import { describe, expect, it } from "vitest";
import { epochMatches, extractBearer, grantEpoch, hasPkcePolicy, isAuthorized, tokenMatches } from "../src/auth";

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
