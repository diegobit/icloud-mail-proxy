// OAuth on /mcp against a real local workerd, started through Wrangler's
// unstable_startWorker: provider metadata, the browser flow with a dynamic
// client and PKCE, token use on /mcp versus the REST API, token rotation,
// PUBLIC_ORIGIN rewriting behind a tunnel, and the registration rate limit.
// iCloud itself is never contacted.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";

const CONFIG = new URL("../wrangler.base.jsonc", import.meta.url).pathname;
const TOKEN_A = "integration-api-token-aaaaaaaaaa";
const TOKEN_B = "integration-api-token-bbbbbbbbbb";
const REDIRECT_URI = "http://127.0.0.1:8971/callback";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const JSON_HEADERS = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// unstable_startWorker is the raw DevEnv: unlike the `wrangler dev` CLI it
// does not derive the Node compat mode or the port itself, so both are passed
// explicitly. The config still comes from the real wrangler.base.jsonc. The
// port is fixed by the caller because grants are bound to the origin they
// were issued for.
async function startWorker(apiToken, persist, port, extraBindings = {}) {
  const worker = await unstable_startWorker({
    config: CONFIG,
    build: { nodejsCompatMode: "v2" },
    dev: { server: { port }, persist },
    bindings: {
      API_TOKEN: { type: "plain_text", value: apiToken },
      ICLOUD_USER: { type: "plain_text", value: "owner@example.com" },
      ICLOUD_APP_PASSWORD: { type: "plain_text", value: "app-password" },
      ...extraBindings,
    },
  });
  await worker.ready;
  return { worker, base: `http://127.0.0.1:${port}`, port };
}

function base64url(buffer) {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function pkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function hidden(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`hidden input ${name} not found`);
  return match[1];
}

function initBody(id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "integration", version: "0.0.1" },
    },
  });
}

function mcpRequest(base, token) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: token ? { ...JSON_HEADERS, Authorization: `Bearer ${token}` } : JSON_HEADERS,
    body: initBody(),
  });
}

async function registerClient(base) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Integration test",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(typeof body.client_id).toBe("string");
  return body.client_id;
}

function authorizeQuery(clientId, challenge, state) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "mail:read",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
}

async function tokenRequest(base, params) {
  return fetch(`${base}/oauth/token`, { method: "POST", headers: FORM, body: new URLSearchParams(params) });
}

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
    const handle = hidden(await posted.text(), "handle");

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
      body: new URLSearchParams({ handle, action: "approve" }),
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

    // The OAuth access token works on /mcp but not on the REST API.
    const init = await mcpRequest(current.base, tokens.access_token);
    expect(init.status).toBe(200);
    const rest = await fetch(`${current.base}/v1/mailboxes`, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    expect(rest.status).toBe(401);

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

  it("rotating API_TOKEN revokes existing grants and tokens", async () => {
    const persist = path.join(dir, "kv");
    const origin = current.port;
    await current.worker.dispose();
    // Same origin and same KV: the only difference is the API token.
    current = await startWorker(TOKEN_B, persist, origin);

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
    expect((await again.json()).error).toBe("invalid_grant");
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
    const handle = hidden(await posted.text(), "handle");

    const approved = await fetch(`${current.base}/authorize/consent`, {
      method: "POST",
      headers: { ...FORM, Cookie: cookie.split(";")[0] },
      body: new URLSearchParams({ handle, action: "approve" }),
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
