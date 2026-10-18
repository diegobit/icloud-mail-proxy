import { describe, expect, it } from "vitest";
import {
  approvalSecret,
  epochMatches,
  extractBearer,
  grantEpoch,
  hasPkcePolicy,
  hasSendSession,
  isAuthorized,
  sendCookieFrom,
  sendCookieValue,
  sendSessionCookie,
  SEND_COOKIE_NAME,
  tokenMatches,
} from "../src/auth";

const TOKEN = "s3cret-deployment-token-abcdefghijklmnop";
const OTHER = "another-deployment-token-abcdefghijklmn";

function requestWith(authorization?: string): Request {
  return new Request("https://mail.example.com/mcp", {
    headers: authorization === undefined ? {} : { Authorization: authorization },
  });
}

describe("extractBearer", () => {
  it("reads a well-formed bearer header", () => {
    expect(extractBearer(requestWith("Bearer abc.def"))).toBe("abc.def");
  });

  it("rejects missing, malformed, and non-bearer headers", () => {
    expect(extractBearer(requestWith())).toBeNull();
    expect(extractBearer(requestWith("Bearer"))).toBeNull();
    expect(extractBearer(requestWith("Bearer "))).toBeNull();
    expect(extractBearer(requestWith("Basic abc"))).toBeNull();
    expect(extractBearer(requestWith("bearer abc"))).toBeNull();
  });
});

describe("tokenMatches", () => {
  it("accepts the exact token and nothing else", async () => {
    expect(await tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(await tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(await tokenMatches(TOKEN.slice(0, -1), TOKEN)).toBe(false);
    expect(await tokenMatches("", TOKEN)).toBe(false);
  });

  it("never matches when the deployment has no token", async () => {
    expect(await tokenMatches(TOKEN, "")).toBe(false);
    expect(await tokenMatches("", "")).toBe(false);
  });
});

describe("isAuthorized", () => {
  it("authorizes only a request carrying the exact token", async () => {
    expect(await isAuthorized(requestWith(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
    expect(await isAuthorized(requestWith(`Bearer ${OTHER}`), TOKEN)).toBe(false);
    expect(await isAuthorized(requestWith(), TOKEN)).toBe(false);
  });
});

describe("grantEpoch", () => {
  it("is stable for one token", async () => {
    expect(await grantEpoch(TOKEN)).toBe(await grantEpoch(TOKEN));
  });

  it("differs across tokens and never leaks the token", async () => {
    const epoch = await grantEpoch(TOKEN);
    expect(epoch).not.toBe(await grantEpoch(OTHER));
    expect(epoch).not.toContain(TOKEN);
    expect(TOKEN).not.toContain(epoch);
    expect(epoch).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("epochMatches", () => {
  it("accepts the epoch of the current token only", async () => {
    expect(await epochMatches(await grantEpoch(TOKEN), TOKEN)).toBe(true);
    expect(await epochMatches(await grantEpoch(OTHER), TOKEN)).toBe(false);
  });

  it("rejects missing or non-string epochs", async () => {
    expect(await epochMatches(undefined, TOKEN)).toBe(false);
    expect(await epochMatches(null, TOKEN)).toBe(false);
    expect(await epochMatches(42, TOKEN)).toBe(false);
    expect(await epochMatches("", TOKEN)).toBe(false);
  });
});

describe("hasPkcePolicy", () => {
  it("accepts only grants marked by the PKCE-enforcing consent flow", () => {
    expect(hasPkcePolicy({ pkce: true })).toBe(true);
    expect(hasPkcePolicy({ epoch: "e", via: "oauth" })).toBe(false);
    expect(hasPkcePolicy({ pkce: "true" })).toBe(false);
    expect(hasPkcePolicy({ pkce: false })).toBe(false);
    expect(hasPkcePolicy(undefined)).toBe(false);
  });
});

describe("send approval session", () => {
  const NOW = 1_800_000_000_000;
  const ENV = { API_TOKEN: TOKEN };

  function requestWithCookie(cookie?: string): Request {
    return new Request("https://mail.example.com/send/approve?d=abc", {
      headers: cookie === undefined ? {} : { Cookie: cookie },
    });
  }

  it("mints and verifies a session cookie keyed on the approval secret", async () => {
    const value = await sendCookieValue(TOKEN, TOKEN, NOW + 60_000);
    expect(value).toMatch(/^\d+\.[A-Za-z0-9_-]+$/);
    expect(await hasSendSession(requestWithCookie(`${SEND_COOKIE_NAME}=${value}`), ENV, NOW)).toBe(true);
    expect(await hasSendSession(requestWithCookie(`${SEND_COOKIE_NAME}=${value}`), { API_TOKEN: OTHER }, NOW)).toBe(false);
    // Rotating API_TOKEN invalidates the cookie even when the approval secret
    // itself did not change: the token is part of the signed message.
    expect(
      await hasSendSession(requestWithCookie(`${SEND_COOKIE_NAME}=${value}`), { API_TOKEN: OTHER, SEND_APPROVAL_TOKEN: TOKEN }, NOW),
    ).toBe(false);
  });

  it("uses the dedicated approval token when one is set", async () => {
    const dedicated = "owner-only-approval-token-abcdefgh";
    const env = { API_TOKEN: TOKEN, SEND_APPROVAL_TOKEN: dedicated };
    expect(approvalSecret(env)).toBe(dedicated);
    expect(approvalSecret({ API_TOKEN: TOKEN, SEND_APPROVAL_TOKEN: "  " })).toBe(TOKEN);
    expect(approvalSecret(ENV)).toBe(TOKEN);

    const cookie = (await sendSessionCookie(env, NOW)).split(";")[0];
    expect(await hasSendSession(requestWithCookie(cookie), env, NOW)).toBe(true);
    // The same cookie is worthless on a deployment without that secret.
    expect(await hasSendSession(requestWithCookie(cookie), ENV, NOW)).toBe(false);
    // And a session minted from API_TOKEN stops working once the dedicated
    // secret is configured.
    const oldCookie = (await sendSessionCookie(ENV, NOW)).split(";")[0];
    expect(await hasSendSession(requestWithCookie(oldCookie), env, NOW)).toBe(false);
  });

  it("rejects tampered, malformed, expired and missing values", async () => {
    const value = await sendCookieValue(TOKEN, TOKEN, NOW + 60_000);
    const tampered = `${value.split(".")[0]}.${value.split(".")[1].slice(0, -1)}x`;
    for (const cookie of [
      undefined,
      "",
      "other=1",
      `${SEND_COOKIE_NAME}=`,
      `${SEND_COOKIE_NAME}=abc`,
      `${SEND_COOKIE_NAME}=notanumber.sig`,
      `${SEND_COOKIE_NAME}=${tampered}`,
    ]) {
      expect(await hasSendSession(requestWithCookie(cookie), ENV, NOW), String(cookie)).toBe(false);
    }
    // Expired even though the signature is genuine.
    expect(await hasSendSession(requestWithCookie(`${SEND_COOKIE_NAME}=${value}`), ENV, NOW + 60_001)).toBe(false);
  });

  it("parses the cookie out of a multi-cookie header", () => {
    expect(sendCookieFrom("a=1; __Host-send=x.y; b=2")).toBe("x.y");
    expect(sendCookieFrom("a=1")).toBeNull();
    expect(sendCookieFrom(null)).toBeNull();
  });

  it("sets the hardened cookie attributes", async () => {
    const header = await sendSessionCookie(ENV, NOW);
    expect(header.startsWith(`${SEND_COOKIE_NAME}=`)).toBe(true);
    expect(header).toContain("Path=/");
    expect(header).toContain("Secure");
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    expect(header).toContain("Max-Age=900");
    expect(await hasSendSession(requestWithCookie(header.split(";")[0]), ENV, NOW + 899_000)).toBe(true);
  });
});
