// OAuth on /mcp against a real local workerd, started through Wrangler's
// unstable_startWorker: provider metadata, the browser flow with a dynamic
// client and PKCE, the PKCE requirement (public and confidential clients),
// token use on /mcp versus the REST API, rotation (including a consent
// transaction left pending across the rotation), PUBLIC_ORIGIN rewriting
// behind a tunnel (including double-slash paths), per-origin provider
// isolation, and the rate limits on /oauth/register and /oauth/token.
// iCloud itself is never contacted.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authorizeQuery,
  FORM,
  freePort,
  hidden,
  JSON_HEADERS,
  mcpRequest,
  pkce,
  registerClient,
  startWorker,
  TOKEN_A,
  TOKEN_B,
  tokenRequest,
  REDIRECT_URI,
} from "./support/oauth-flow.mjs";

describe("OAuth on /mcp, end to end", () => {
  let dir;
  let current;
  let flow;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-oauth-"));
    current = await startWorker(TOKEN_A, path.join(dir, "kv"), await freePort());
  }, 120_000);

  afterAll(async () => {
    await current?.worker.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("publishes the protected-resource and authorization-server metadata", async () => {
    const resource = await fetch(`${current.base}/.well-known/oauth-protected-resource/mcp`);
    expect(resource.status).toBe(200);
    expect(await resource.json()).toEqual({
      resource: `${current.base}/mcp`,
      authorization_servers: [current.base],
      scopes_supported: ["mail:read"],
      bearer_methods_supported: ["header"],
      resource_name: "icloud-mail-proxy",
    });

    const authorization = await fetch(`${current.base}/.well-known/oauth-authorization-server`);
    expect(authorization.status).toBe(200);
    expect(await authorization.json()).toMatchObject({
      issuer: current.base,
      authorization_endpoint: `${current.base}/authorize`,
      token_endpoint: `${current.base}/oauth/token`,
      registration_endpoint: `${current.base}/oauth/register`,
      client_id_metadata_document_supported: true,
    });
  }, 30_000);

  it("answers unknown well-known paths with 404 JSON", async () => {
    for (const suffix of ["weird", "oauth-protected-resource", "oauth-protected-resource/other"]) {
      const res = await fetch(`${current.base}/.well-known/${suffix}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
    }
  }, 30_000);

  it("challenges anonymous /mcp requests with the resource metadata", async () => {
    const res = await mcpRequest(current.base, null);
    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate");
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${current.base}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).toContain('scope="mail:read"');
  }, 30_000);

  it("answers anonymous /healthz and /v1/mailboxes with 401 JSON", async () => {
    for (const path of ["/healthz", "/v1/mailboxes"]) {
      const res = await fetch(`${current.base}${path}`);
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await res.json()).toEqual({
        error: { code: "unauthorized", message: "missing or invalid bearer token" },
      });
    }
  }, 30_000);

  it("accepts the static bearer on /mcp", async () => {
    const init = await mcpRequest(current.base, TOKEN_A);
    expect(init.status).toBe(200);
    expect(await init.text()).toContain("protocolVersion");

    const tools = await fetch(`${current.base}/mcp`, {
      method: "POST",
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${TOKEN_A}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(tools.status).toBe(200);
    expect(await tools.text()).toContain("search_mail");
  }, 30_000);

  it("runs the full flow for a dynamic client: consent, code, PKCE, tokens", async () => {
    const clientId = await registerClient(current.base);
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(clientId, challenge, "state-123");

    // The sign-in page renders before anything is written to KV.
    const page = await fetch(`${current.base}/authorize?${query}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(await page.text()).toContain("Connect iCloud Mail");

    // A wrong API token is rejected with no consent transaction.
    const wrong = await fetch(`${current.base}/authorize`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ authQuery: query, token: "not-the-token" }),
    });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.text()).toContain("does not match this deployment");

    // The right token opens a consent transaction.
    const posted = await fetch(`${current.base}/authorize`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ authQuery: query, token: TOKEN_A }),
    });
    expect(posted.status).toBe(200);
    const cookie = posted.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    const consentHtml = await posted.text();
    const handle = hidden(consentHtml, "handle");

    // A handle the browser never received cannot be approved.
    const bogus = await fetch(`${current.base}/authorize/consent`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ handle: "made-up", action: "approve" }),
    });
    expect(bogus.status).toBe(400);

    const approved = await fetch(`${current.base}/authorize/consent`, {
      method: "POST",
      headers: { ...FORM, Cookie: cookie.split(";")[0] },
      body: new URLSearchParams({ handle, action: "approve", epoch: hidden(consentHtml, "epoch") }),
      redirect: "manual",
    });
    expect(approved.status).toBe(302);
    const location = new URL(approved.headers.get("location"));
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe("state-123");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    const exchanged = await tokenRequest(current.base, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    const tokens = await exchanged.json();
    expect(tokens.token_type?.toLowerCase()).toBe("bearer");
    expect(tokens.scope).toBe("mail:read");
    expect(tokens.refresh_token).toBeTruthy();

    // The OAuth access token works on /mcp but not on the REST API or /healthz.
    const init = await mcpRequest(current.base, tokens.access_token);
    expect(init.status).toBe(200);
    for (const path of ["/v1/mailboxes", "/healthz"]) {
      const rest = await fetch(`${current.base}${path}`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      expect(rest.status).toBe(401);
      expect((await rest.json()).error.code).toBe("unauthorized");
    }

    // Refreshing issues a new access token.
    const refreshed = await tokenRequest(current.base, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    expect(refreshed.status).toBe(200);
    const next = await refreshed.json();
    expect(next.access_token).toBeTruthy();
    expect((await mcpRequest(current.base, next.access_token)).status).toBe(200);

    flow = { clientId, refreshToken: next.refresh_token, accessToken: next.access_token };
  }, 60_000);

  it("requires an S256 PKCE challenge for public and confidential clients", async () => {
    for (const authMethod of ["client_secret_basic", "none"]) {
      const clientId = await registerClient(current.base, { token_endpoint_auth_method: authMethod });
      const query = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "mail:read",
        state: `state-${authMethod}`,
      }).toString();

      // The sign-in prompt bounces back with invalid_request: no page and no
      // consent transaction. The library only requires PKCE for public
      // clients at token exchange, so this is enforced here for both.
      const prompt = await fetch(`${current.base}/authorize?${query}`, { redirect: "manual" });
      expect(prompt.status).toBe(302);
      expect(prompt.headers.get("set-cookie")).toBeNull();
      const bounce = new URL(prompt.headers.get("location"));
      expect(`${bounce.origin}${bounce.pathname}`).toBe(REDIRECT_URI);
      expect(bounce.searchParams.get("error")).toBe("invalid_request");
      expect(bounce.searchParams.get("error_description")).toContain("PKCE");
      expect(bounce.searchParams.get("state")).toBe(`state-${authMethod}`);
      // Error responses carry the issuer advertised in the discovery metadata.
      expect(bounce.searchParams.get("iss")).toBe(current.base);

      // Submitting the correct API token cannot start the consent flow either.
      const submitted = await fetch(`${current.base}/authorize`, {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({ authQuery: query, token: TOKEN_A }),
        redirect: "manual",
      });
      expect(submitted.status).toBe(302);
      expect(submitted.headers.get("set-cookie")).toBeNull();

      // A `plain` challenge is rejected the same way.
      const plain = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "mail:read",
        state: "state-plain",
        code_challenge: "plain-challenge",
        code_challenge_method: "plain",
      }).toString();
      const plainPrompt = await fetch(`${current.base}/authorize?${plain}`, { redirect: "manual" });
      expect(plainPrompt.status).toBe(302);
      expect(new URL(plainPrompt.headers.get("location")).searchParams.get("error")).toBe("invalid_request");
    }
  }, 30_000);

  it("keeps per-origin providers isolated across hostnames in one isolate", async () => {
    const localhost = `http://localhost:${current.port}`;
    const queryFor = (origin) =>
      new URLSearchParams({
        response_type: "code",
        client_id: flow.clientId,
        redirect_uri: REDIRECT_URI,
        scope: "mail:read",
        state: "state-origins",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        resource: `${origin}/mcp`,
      }).toString();

    // The 127.0.0.1 provider is already cached from the tests above; the
    // localhost provider must not inherit its resource configuration (the
    // second origin used to be answered with invalid_target).
    const first = await fetch(`${current.base}/authorize?${queryFor(current.base)}`, { redirect: "manual" });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Connect iCloud Mail");

    const second = await fetch(`${localhost}/authorize?${queryFor(localhost)}`, { redirect: "manual" });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("Connect iCloud Mail");
  }, 30_000);

  it("rotating API_TOKEN revokes existing grants and tokens", async () => {
    const persist = path.join(dir, "kv");
    const origin = current.port;

    // A consent transaction opened just before the rotation: the handle and
    // cookie stay valid in KV, but approval must be refused because the token
    // verified at sign-in is no longer the deployment's token.
    const pendingChallenge = pkce();
    const pendingQuery = authorizeQuery(flow.clientId, pendingChallenge.challenge, "state-pending");
    const pendingPage = await fetch(`${current.base}/authorize`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ authQuery: pendingQuery, token: TOKEN_A }),
    });
    expect(pendingPage.status).toBe(200);
    const pendingHtml = await pendingPage.text();
    const pending = {
      cookie: pendingPage.headers.get("set-cookie").split(";")[0],
      handle: hidden(pendingHtml, "handle"),
      epoch: hidden(pendingHtml, "epoch"),
    };

    await current.worker.dispose();
    // Same origin and same KV: the only difference is the API token.
    current = await startWorker(TOKEN_B, persist, origin);

    const staleApproval = await fetch(`${current.base}/authorize/consent`, {
      method: "POST",
      headers: { ...FORM, Cookie: pending.cookie },
      body: new URLSearchParams({ handle: pending.handle, action: "approve", epoch: pending.epoch }),
      redirect: "manual",
    });
    expect(staleApproval.status).toBe(400);
    expect(staleApproval.headers.get("location")).toBeNull();
    expect(await staleApproval.text()).toContain("API token changed after sign-in");

    // The access token is still a valid provider token, but its epoch is not:
    // the 401 comes from the /mcp epoch check, not from token validation.
    const stale = await mcpRequest(current.base, flow.accessToken);
    expect(stale.status).toBe(401);
    expect(stale.headers.get("WWW-Authenticate")).toContain('error="invalid_token"');
    expect((await stale.json()).error.code).toBe("invalid_token");

    const refresh = await tokenRequest(current.base, {
      grant_type: "refresh_token",
      refresh_token: flow.refreshToken,
      client_id: flow.clientId,
    });
    expect(refresh.status).toBe(400);
    const rotated = await refresh.json();
    expect(rotated.error).toBe("invalid_grant");
    expect(rotated.error_description).toBe("API token rotated; reconnect");

    // The grant is gone, not just the epoch: a second refresh fails the same way.
    const again = await tokenRequest(current.base, {
      grant_type: "refresh_token",
      refresh_token: flow.refreshToken,
      client_id: flow.clientId,
    });
    expect(again.status).toBe(400);
    const revoked = await again.json();
    expect(revoked.error).toBe("invalid_grant");
    expect(revoked.error_description).toBe("Grant not found");

    // Signing in again with the new token restores access end to end.
    const reconnect = pkce();
    const reconnectQuery = authorizeQuery(flow.clientId, reconnect.challenge, "state-reconnect");
    const reconnectPage = await fetch(`${current.base}/authorize`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ authQuery: reconnectQuery, token: TOKEN_B }),
    });
    expect(reconnectPage.status).toBe(200);
    const reconnectHtml = await reconnectPage.text();
    const approved = await fetch(`${current.base}/authorize/consent`, {
      method: "POST",
      headers: { ...FORM, Cookie: reconnectPage.headers.get("set-cookie").split(";")[0] },
      body: new URLSearchParams({
        handle: hidden(reconnectHtml, "handle"),
        action: "approve",
        epoch: hidden(reconnectHtml, "epoch"),
      }),
      redirect: "manual",
    });
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get("location")).searchParams.get("code");
    const exchanged = await tokenRequest(current.base, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: flow.clientId,
      code_verifier: reconnect.verifier,
    });
    expect(exchanged.status).toBe(200);
    const { access_token: accessToken } = await exchanged.json();
    expect((await mcpRequest(current.base, accessToken)).status).toBe(200);
  }, 120_000);
});

describe("PUBLIC_ORIGIN tunnel override", () => {
  const PUBLIC_ORIGIN = "https://tunnel.example.com";
  let dir;
  let current;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-oauth-origin-"));
    current = await startWorker(TOKEN_A, path.join(dir, "kv"), await freePort(), {
      PUBLIC_ORIGIN: { type: "plain_text", value: PUBLIC_ORIGIN },
    });
  }, 120_000);

  afterAll(async () => {
    await current?.worker.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("advertises PUBLIC_ORIGIN and completes OAuth and bearer requests when reached on loopback", async () => {
    const resource = await fetch(`${current.base}/.well-known/oauth-protected-resource/mcp`);
    expect(resource.status).toBe(200);
    expect(await resource.json()).toEqual({
      resource: `${PUBLIC_ORIGIN}/mcp`,
      authorization_servers: [PUBLIC_ORIGIN],
      scopes_supported: ["mail:read"],
      bearer_methods_supported: ["header"],
      resource_name: "icloud-mail-proxy",
    });

    const authorization = await fetch(`${current.base}/.well-known/oauth-authorization-server`);
    expect(authorization.status).toBe(200);
    expect(await authorization.json()).toMatchObject({
      issuer: PUBLIC_ORIGIN,
      authorization_endpoint: `${PUBLIC_ORIGIN}/authorize`,
      token_endpoint: `${PUBLIC_ORIGIN}/oauth/token`,
      registration_endpoint: `${PUBLIC_ORIGIN}/oauth/register`,
      client_id_metadata_document_supported: true,
    });

    const challengeRes = await mcpRequest(current.base, null);
    expect(challengeRes.status).toBe(401);
    expect(challengeRes.headers.get("WWW-Authenticate")).toContain(
      `resource_metadata="${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );

    expect((await mcpRequest(current.base, TOKEN_A)).status).toBe(200);

    const clientId = await registerClient(current.base);
    const { verifier, challenge } = pkce();
    const query = authorizeQuery(clientId, challenge, "state-tunnel");
    const posted = await fetch(`${current.base}/authorize`, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams({ authQuery: query, token: TOKEN_A }),
    });
    expect(posted.status).toBe(200);
    const cookie = posted.headers.get("set-cookie");
    const consentHtml = await posted.text();
    const handle = hidden(consentHtml, "handle");

    const approved = await fetch(`${current.base}/authorize/consent`, {
      method: "POST",
      headers: { ...FORM, Cookie: cookie.split(";")[0] },
      body: new URLSearchParams({ handle, action: "approve", epoch: hidden(consentHtml, "epoch") }),
      redirect: "manual",
    });
    expect(approved.status).toBe(302);
    const code = new URL(approved.headers.get("location")).searchParams.get("code");

    const exchanged = await tokenRequest(current.base, {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    expect(exchanged.status).toBe(200);
    const { access_token: accessToken } = await exchanged.json();
    expect((await mcpRequest(current.base, accessToken)).status).toBe(200);
  }, 60_000);

  it("does not let double-slash paths reach the gated endpoints", async () => {
    // `//host/oauth/register` must not be re-read as a network-path reference:
    // the rewrite used to change the host and leave `/oauth/register` behind
    // it, so the path reached the provider without ever passing the limiter.
    for (const host of ["tunnel.example.com", "evil.example.com"]) {
      const registration = await fetch(`${current.base}//${host}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: `Bypass ${host}`,
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
        }),
      });
      expect(registration.status).toBe(401);
      expect(registration.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(registration.headers.get("Cache-Control")).toBe("private, no-store");

      const token = await fetch(`${current.base}//${host}/oauth/token`, {
        method: "POST",
        headers: FORM,
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: "user:grant0000000000:secret",
          client_id: "bypass",
        }),
      });
      expect(token.status).toBe(401);
      expect((await token.json()).error.code).toBe("unauthorized");
    }

    // The gated endpoints themselves are untouched: a normal registration
    // still succeeds, and the bypass attempts did not consume its quota.
    expect(await registerClient(current.base)).toBeTruthy();
  }, 30_000);

  it("fails closed with 500 not_configured JSON when PUBLIC_ORIGIN is invalid", async () => {
    await current.worker.dispose();
    current = await startWorker(TOKEN_A, path.join(dir, "kv"), current.port, {
      PUBLIC_ORIGIN: { type: "plain_text", value: "http://tunnel.example.com/with-path" },
    });

    const res = await fetch(`${current.base}/healthz`, {
      headers: { Authorization: `Bearer ${TOKEN_A}` },
    });
    expect(res.status).toBe(500);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await res.json()).error.code).toBe("not_configured");
  }, 60_000);
});

describe("registration rate limit", () => {
  let dir;
  let current;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-oauth-limit-"));
    current = await startWorker(TOKEN_A, path.join(dir, "kv"), await freePort());
  }, 120_000);

  afterAll(async () => {
    await current?.worker.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("returns 429 after five registrations in a minute", async () => {
    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const res = await fetch(`${current.base}/oauth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: `Rate limit ${attempt}`,
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
        }),
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(await res.json()).toEqual({
          error: { code: "rate_limited", message: "too many registration attempts" },
        });
      }
    }
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  }, 60_000);
});

describe("token rate limit", () => {
  let dir;
  let current;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-oauth-token-limit-"));
    current = await startWorker(TOKEN_A, path.join(dir, "kv"), await freePort());
  }, 120_000);

  afterAll(async () => {
    await current?.worker.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("returns 429 after thirty token requests in a minute", async () => {
    const clientId = await registerClient(current.base);
    const statuses = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const res = await tokenRequest(current.base, {
        grant_type: "refresh_token",
        refresh_token: "user:grant0000000000:secret",
        client_id: clientId,
      });
      statuses.push(res.status);
      if (res.status === 429) {
        expect(await res.json()).toEqual({
          error: { code: "rate_limited", message: "too many token requests" },
        });
      }
    }
    expect(statuses).toEqual([...Array(30).fill(400), 429]);
  }, 60_000);
});
