import { describe, expect, it, vi } from "vitest";
import type { AuthRequest } from "@cloudflare/workers-oauth-provider";
import { grantEpoch } from "../src/auth";
import { handleAuthorize } from "../src/oauth-authorize";
import type { Env } from "../src/types";

const TOKEN = "test-token-abcdefghijklmnopqrstuvwxyz01";
const OTHER_TOKEN = "test-token-zzzzzzzzzzzzzzzzzzzzzzzzzz01";
const AUTH_QUERY =
  "response_type=code&client_id=client-1&redirect_uri=https%3A%2F%2Fclient.example%2Fcb" +
  "&state=st-1&code_challenge=challenge-1&code_challenge_method=S256&scope=mail%3Aread";

const AUTH_REQUEST: AuthRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://client.example/cb",
  scope: ["mail:read"],
  state: "st-1",
  codeChallenge: "challenge-1",
  codeChallengeMethod: "S256",
  resource: "https://mail.example.com/mcp",
  issuer: "https://mail.example.com",
};

const FACTS = {
  clientId: "client-1",
  clientName: "Example App",
  clientDomain: "client.example",
  redirectUri: "https://client.example/cb",
  redirectHost: "client.example",
  redirectIsLoopback: false,
  scope: ["mail:read"],
};

// The library cannot be imported under Node, so the expected failures are
// shaped the way its classes shape them (both set `name` explicitly).
function authorizationError(description: string, withRedirect = false): Error {
  return Object.assign(new Error(description), {
    name: "AuthorizationError",
    code: "invalid_request",
    description,
    redirectUri: withRedirect ? AUTH_REQUEST.redirectUri : undefined,
    redirectTo: withRedirect ? "https://client.example/cb?error=invalid_request&state=st-1" : undefined,
  });
}

function cimdFetchError(): Error {
  return Object.assign(new Error("CIMD fetch failed for https://client.example/client.json: boom"), {
    name: "CimdFetchError",
    reason: "metadata_resolution_failed",
  });
}

interface CompleteOptions {
  request: typeof AUTH_REQUEST;
  userId: string;
  scope: string[];
  metadata: { clientName: string; approvedAt: string };
  props: { epoch: string; pkce?: boolean; via: string };
}

function fakeHelpers() {
  return {
    parseAuthRequest: vi.fn(async (_request: Request) => AUTH_REQUEST),
    describeConsent: vi.fn(async (_authRequest: unknown) => FACTS),
    beginConsent: vi.fn(async (_authRequest: unknown) => ({
      handle: "handle-1",
      headers: new Headers({
        "Set-Cookie": "__Host-oauth-consent=xyz; Secure; HttpOnly",
        "Content-Security-Policy": "frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      }),
    })),
    approveConsent: vi.fn(async (_request: Request, _handle: string, _options?: { scope?: string[] }) => ({
      request: AUTH_REQUEST,
      headers: new Headers({ "Set-Cookie": "__Host-oauth-consent=; Max-Age=0" }),
    })),
    denyConsent: vi.fn(async (_request: Request, _handle: string) => ({
      request: AUTH_REQUEST,
      redirectTo: "https://client.example/cb?error=access_denied&state=st-1",
      headers: new Headers({ Location: "https://client.example/cb?error=access_denied&state=st-1" }),
    })),
    completeAuthorization: vi.fn(async (_options: CompleteOptions) => ({
      redirectTo: "https://client.example/cb?code=code-1&state=st-1",
    })),
  };
}

type FakeHelpers = ReturnType<typeof fakeHelpers>;

function fakeEnv(helpers: FakeHelpers, token = TOKEN, overrides: Partial<Env> = {}): Env {
  return { API_TOKEN: token, OAUTH_PROVIDER: helpers, ...overrides } as unknown as Env;
}

function getPromptRequest(): Request {
  return new Request(`https://mail.example.com/authorize?${AUTH_QUERY}`);
}

function postForm(
  path: string,
  fields: Record<string, string | string[]>,
  withConsentCookie = false,
): Request {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) body.append(key, item);
  }
  return new Request(`https://mail.example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(withConsentCookie ? { Cookie: "__Host-oauth-consent=xyz" } : {}),
    },
    body: body.toString(),
  });
}

describe("GET /authorize", () => {
  it("renders the token page without writing anything", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(getPromptRequest(), fakeEnv(helpers));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain("Example App");
    expect(body).toContain('type="password"');
    expect(body).toContain('name="authQuery"');
    expect(helpers.parseAuthRequest).toHaveBeenCalledTimes(1);
    expect(helpers.describeConsent).toHaveBeenCalledWith(AUTH_REQUEST);
    expect(helpers.beginConsent).not.toHaveBeenCalled();
    expect(helpers.approveConsent).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("renders a local 400 when the library did not validate a redirect", async () => {
    const helpers = fakeHelpers();
    helpers.parseAuthRequest.mockRejectedValueOnce(authorizationError("Invalid client_id"));
    const response = await handleAuthorize(getPromptRequest(), fakeEnv(helpers));

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(await response.text()).toContain("Invalid client_id");
  });

  it("redirects back when the failure carries a validated redirect", async () => {
    const helpers = fakeHelpers();
    helpers.parseAuthRequest.mockRejectedValueOnce(authorizationError("Bad scope", true));
    const response = await handleAuthorize(getPromptRequest(), fakeEnv(helpers));

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://client.example/cb?error=invalid_request&state=st-1");
  });

  it("reports unresolvable client metadata as a 400", async () => {
    const helpers = fakeHelpers();
    helpers.describeConsent.mockRejectedValueOnce(cimdFetchError());
    const response = await handleAuthorize(getPromptRequest(), fakeEnv(helpers));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("client metadata could not be fetched");
  });

  it("redirects back when the request carries no S256 PKCE challenge", async () => {
    const helpers = fakeHelpers();
    helpers.parseAuthRequest.mockResolvedValueOnce({
      ...AUTH_REQUEST,
      codeChallenge: undefined,
      codeChallengeMethod: undefined,
    });
    const response = await handleAuthorize(getPromptRequest(), fakeEnv(helpers));

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("Location")!);
    expect(`${target.origin}${target.pathname}`).toBe("https://client.example/cb");
    expect(target.searchParams.get("error")).toBe("invalid_request");
    expect(target.searchParams.get("error_description")).toContain("PKCE");
    expect(target.searchParams.get("state")).toBe("st-1");
    expect(target.searchParams.get("iss")).toBe("https://mail.example.com");
    expect(helpers.describeConsent).not.toHaveBeenCalled();
    expect(helpers.beginConsent).not.toHaveBeenCalled();
  });

  it("replaces stale response parameters on the error redirect", async () => {
    const helpers = fakeHelpers();
    helpers.parseAuthRequest.mockResolvedValueOnce({
      ...AUTH_REQUEST,
      redirectUri: "https://client.example/cb?error=server_error&state=old&iss=old&keep=1",
      codeChallenge: undefined,
      codeChallengeMethod: undefined,
    });
    const response = await handleAuthorize(getPromptRequest(), fakeEnv(helpers));

    expect(response.status).toBe(302);
    const target = new URL(response.headers.get("Location")!);
    expect(target.searchParams.getAll("error")).toEqual(["invalid_request"]);
    expect(target.searchParams.getAll("state")).toEqual(["st-1"]);
    expect(target.searchParams.getAll("iss")).toEqual(["https://mail.example.com"]);
    expect(target.searchParams.get("keep")).toBe("1");
  });

  it("rejects a plain challenge method before describeConsent", async () => {
    const helpers = fakeHelpers();
    helpers.parseAuthRequest.mockResolvedValueOnce({ ...AUTH_REQUEST, codeChallengeMethod: "plain" });
    const response = await handleAuthorize(getPromptRequest(), fakeEnv(helpers));

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
    expect(helpers.describeConsent).not.toHaveBeenCalled();
    expect(helpers.beginConsent).not.toHaveBeenCalled();
  });

  it("rejects other methods and paths", async () => {
    const helpers = fakeHelpers();
    const put = new Request(`https://mail.example.com/authorize?${AUTH_QUERY}`, { method: "PUT" });
    expect((await handleAuthorize(put, fakeEnv(helpers))).status).toBe(405);
    expect(
      (await handleAuthorize(new Request("https://mail.example.com/authorize/consent"), fakeEnv(helpers))).status,
    ).toBe(405);
  });
});

describe("POST /authorize", () => {
  it("rejects a wrong token without writing anything", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm("/authorize", { authQuery: AUTH_QUERY, token: "wrong-token" }),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("does not match this deployment");
    expect(body).toContain('name="authQuery"');
    expect(helpers.beginConsent).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects an empty token", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm("/authorize", { authQuery: AUTH_QUERY, token: "" }),
      fakeEnv(helpers),
    );
    expect(response.status).toBe(401);
    expect(helpers.beginConsent).not.toHaveBeenCalled();
  });

  it("opens the consent transaction only after the token matches", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm("/authorize", { authQuery: AUTH_QUERY, token: TOKEN }),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(200);
    expect(helpers.beginConsent).toHaveBeenCalledTimes(1);
    expect(helpers.beginConsent).toHaveBeenCalledWith(AUTH_REQUEST);
    expect(response.headers.get("Set-Cookie")).toContain("__Host-oauth-consent");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    );
    const body = await response.text();
    expect(body).toContain('name="handle" value="handle-1"');
    expect(body).toContain(`name="epoch" value="${await grantEpoch(TOKEN)}"`);
    expect(body).toContain("Read and manage mail (mail:read)");
    expect(body).toContain('name="scope" value="mail:read" checked');
    expect(body).not.toContain('name="scope" value="calendar:read"');
    expect(body).not.toContain('name="scope" value="calendar:delete"');
  });

  it("offers the calendar scopes this deployment enabled", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm("/authorize", { authQuery: AUTH_QUERY, token: TOKEN }),
      fakeEnv(helpers, TOKEN, { ALLOWED_CALENDARS: "*", CALENDAR_WRITE: "1" }),
    );

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('name="scope" value="calendar:read"');
    expect(body).toContain('name="scope" value="calendar:write"');
    expect(body).toContain('name="scope" value="calendar:delete"');
    expect(body).toContain("Create and update events (calendar:write)");
    expect(body).toContain("Delete events (calendar:delete)");
  });

  it("rejects a token submission without an S256 challenge before consent", async () => {
    const helpers = fakeHelpers();
    helpers.parseAuthRequest.mockResolvedValueOnce({ ...AUTH_REQUEST, codeChallenge: undefined });
    const response = await handleAuthorize(
      postForm("/authorize", { authQuery: AUTH_QUERY, token: TOKEN }),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("Location")!).searchParams.get("error")).toBe("invalid_request");
    expect(helpers.beginConsent).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a form", async () => {
    const helpers = fakeHelpers();
    const request = new Request("https://mail.example.com/authorize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const response = await handleAuthorize(request, fakeEnv(helpers));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("could not be read");
    expect(helpers.beginConsent).not.toHaveBeenCalled();
  });

  it("re-parses the submitted hidden query and fails closed on tampering", async () => {
    const helpers = fakeHelpers();
    helpers.parseAuthRequest.mockRejectedValueOnce(authorizationError("Invalid client_id"));
    const response = await handleAuthorize(
      postForm("/authorize", { authQuery: "client_id=evil", token: TOKEN }),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(400);
    expect(helpers.beginConsent).not.toHaveBeenCalled();
  });
});

describe("POST /authorize/consent", () => {
  it("approves with exactly mail:read and the current epoch", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm(
        "/authorize/consent",
        { handle: "handle-1", action: "approve", epoch: await grantEpoch(TOKEN), scope: "mail:read" },
        true,
      ),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://client.example/cb?code=code-1&state=st-1");
    expect(response.headers.get("Set-Cookie")).toContain("__Host-oauth-consent");
    expect(helpers.approveConsent).toHaveBeenCalledTimes(1);
    const [request, handle, options] = helpers.approveConsent.mock.calls[0]!;
    expect(request.url).toBe("https://mail.example.com/authorize/consent");
    expect(handle).toBe("handle-1");
    expect(options).toEqual({ scope: ["mail:read"] });

    expect(helpers.completeAuthorization).toHaveBeenCalledTimes(1);
    const [authOptions] = helpers.completeAuthorization.mock.calls[0]!;
    expect(authOptions.request).toBe(AUTH_REQUEST);
    expect(authOptions.userId).toBe("owner");
    expect(authOptions.scope).toEqual(["mail:read"]);
    expect(authOptions.props).toEqual({ epoch: await grantEpoch(TOKEN), pkce: true, via: "oauth" });
    expect(authOptions.metadata.clientName).toBe("Example App");
    expect(Date.parse(authOptions.metadata.approvedAt)).not.toBeNaN();
  });

  it("refuses to complete a stored consent transaction without an S256 challenge", async () => {
    const variants = [
      { codeChallenge: undefined, codeChallengeMethod: undefined },
      { codeChallengeMethod: "plain" },
    ];
    for (const variant of variants) {
      const helpers = fakeHelpers();
      helpers.approveConsent.mockResolvedValueOnce({
        request: { ...AUTH_REQUEST, ...variant },
        headers: new Headers({ "Set-Cookie": "__Host-oauth-consent=; Max-Age=0" }),
      });
      const response = await handleAuthorize(
        postForm(
        "/authorize/consent",
        { handle: "handle-1", action: "approve", epoch: await grantEpoch(TOKEN), scope: "mail:read" },
        true,
      ),
        fakeEnv(helpers),
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toContain("PKCE");
      expect(helpers.completeAuthorization).not.toHaveBeenCalled();
    }
  });

  it("refuses approval when the API token rotated after sign-in", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm(
        "/authorize/consent",
        { handle: "handle-1", action: "approve", epoch: await grantEpoch(TOKEN), scope: "mail:read" },
        true,
      ),
      fakeEnv(helpers, OTHER_TOKEN),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("API token changed after sign-in");
    expect(helpers.approveConsent).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("refuses approval when the epoch is missing or forged", async () => {
    const variants: Record<string, string>[] = [
      { handle: "handle-1", action: "approve", scope: "mail:read" },
      { handle: "handle-1", action: "approve", epoch: "forged-epoch", scope: "mail:read" },
    ];
    for (const fields of variants) {
      const helpers = fakeHelpers();
      const response = await handleAuthorize(postForm("/authorize/consent", fields, true), fakeEnv(helpers));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain("API token changed after sign-in");
      expect(helpers.approveConsent).not.toHaveBeenCalled();
      expect(helpers.completeAuthorization).not.toHaveBeenCalled();
    }
  });

  it("still lets a rotated sign-in be denied", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm("/authorize/consent", { handle: "handle-1", action: "deny" }, true),
      fakeEnv(helpers, OTHER_TOKEN),
    );

    expect(response.status).toBe(302);
    expect(helpers.denyConsent).toHaveBeenCalledTimes(1);
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("grants exactly the scopes the owner selected, deduplicated", async () => {
    const helpers = fakeHelpers();
    const env = fakeEnv(helpers, TOKEN, {
      ALLOWED_CALENDARS: "*",
      CALENDAR_WRITE: "1",
    });
    const selected = [
      "mail:read",
      "calendar:read",
      "calendar:write",
      "calendar:delete",
      "calendar:read",
    ];
    const response = await handleAuthorize(
      postForm(
        "/authorize/consent",
        { handle: "handle-1", action: "approve", epoch: await grantEpoch(TOKEN), scope: selected },
        true,
      ),
      env,
    );

    expect(response.status).toBe(302);
    const expected = ["mail:read", "calendar:read", "calendar:write", "calendar:delete"];
    const [, , approveOptions] = helpers.approveConsent.mock.calls[0]!;
    expect(approveOptions?.scope).toEqual(expected);
    const [authOptions] = helpers.completeAuthorization.mock.calls[0]!;
    expect(authOptions.scope).toEqual(expected);
  });

  it("refuses an approval with no scopes", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm(
        "/authorize/consent",
        { handle: "handle-1", action: "approve", epoch: await grantEpoch(TOKEN) },
        true,
      ),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Select at least one permission");
    expect(helpers.approveConsent).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("refuses a scope the deployment does not offer", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm(
        "/authorize/consent",
        {
          handle: "handle-1",
          action: "approve",
          epoch: await grantEpoch(TOKEN),
          scope: ["mail:read", "calendar:read"],
        },
        true,
      ),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not offered by this deployment");
    expect(helpers.approveConsent).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("denies through the library and redirects back to the client", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm("/authorize/consent", { handle: "handle-1", action: "deny" }, true),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("https://client.example/cb?error=access_denied&state=st-1");
    expect(helpers.denyConsent).toHaveBeenCalledTimes(1);
    expect(helpers.approveConsent).not.toHaveBeenCalled();
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("renders a 400 when the consent transaction is gone", async () => {
    const helpers = fakeHelpers();
    helpers.approveConsent.mockRejectedValueOnce(authorizationError("Consent handle not found"));
    const response = await handleAuthorize(
      postForm(
        "/authorize/consent",
        { handle: "stale", action: "approve", epoch: await grantEpoch(TOKEN), scope: "mail:read" },
        true,
      ),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Consent handle not found");
    expect(helpers.completeAuthorization).not.toHaveBeenCalled();
  });

  it("rejects a body that is not a form", async () => {
    const helpers = fakeHelpers();
    const request = new Request("https://mail.example.com/authorize/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const response = await handleAuthorize(request, fakeEnv(helpers));

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("could not be read");
    expect(helpers.approveConsent).not.toHaveBeenCalled();
    expect(helpers.denyConsent).not.toHaveBeenCalled();
  });

  it("answers an unexpected grant-write failure with a controlled 500", async () => {
    const helpers = fakeHelpers();
    helpers.completeAuthorization.mockRejectedValueOnce(new Error("KV write failed"));
    const response = await handleAuthorize(
      postForm(
        "/authorize/consent",
        { handle: "handle-1", action: "approve", epoch: await grantEpoch(TOKEN), scope: "mail:read" },
        true,
      ),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toContain("Something went wrong");
  });

  it("rejects an unknown action", async () => {
    const helpers = fakeHelpers();
    const response = await handleAuthorize(
      postForm("/authorize/consent", { handle: "handle-1", action: "maybe" }, true),
      fakeEnv(helpers),
    );

    expect(response.status).toBe(400);
    expect(helpers.approveConsent).not.toHaveBeenCalled();
    expect(helpers.denyConsent).not.toHaveBeenCalled();
  });
});
