// Shared helpers for the workerd integration suites: starting the Worker from
// the real wrangler.base.jsonc, a minimal OAuth client flow, and MCP calls.
// iCloud is never contacted by anything here.

import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { expect } from "vitest";
import { unstable_startWorker } from "wrangler";

export const CONFIG = new URL("../../wrangler.base.jsonc", import.meta.url).pathname;
export const TOKEN_A = "integration-api-token-aaaaaaaaaa";
export const TOKEN_B = "integration-api-token-bbbbbbbbbb";
export const REDIRECT_URI = "http://127.0.0.1:8971/callback";
export const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
export const JSON_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

export function freePort() {
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
export async function startWorker(apiToken, persist, port, extraBindings = {}) {
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

export function base64url(buffer) {
  return buffer.toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function pkce() {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function hidden(html, name) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`hidden input ${name} not found`);
  return match[1];
}

export function initBody(id = 1) {
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

export function mcpRequest(base, token) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: token ? { ...JSON_HEADERS, Authorization: `Bearer ${token}` } : JSON_HEADERS,
    body: initBody(),
  });
}

/** Parse an MCP JSON or event-stream response body. */
export async function parseMcpJson(res) {
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) return JSON.parse(line.slice("data: ".length));
    }
    throw new Error(`no data line in event stream: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text);
}

async function mcpRpc(base, token, id, method, params) {
  const headers = token ? { ...JSON_HEADERS, Authorization: `Bearer ${token}` } : { ...JSON_HEADERS };
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await parseMcpJson(res);
  if (body.error) throw new Error(`MCP error: ${JSON.stringify(body.error)}`);
  return body.result;
}

export async function mcpToolsList(base, token) {
  const result = await mcpRpc(base, token, 2, "tools/list", {});
  return (result.tools ?? []).map((tool) => tool.name);
}

/** The full tool descriptors, annotations included. */
export async function mcpToolsListDetailed(base, token) {
  const result = await mcpRpc(base, token, 2, "tools/list", {});
  return result.tools ?? [];
}

/**
 * Call one MCP tool. Returns `{ isError, text, json }`, where `json` is the
 * parsed text payload when it is JSON.
 */
export async function mcpToolCall(base, token, name, args) {
  const result = await mcpRpc(base, token, 3, "tools/call", { name, arguments: args });
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { isError: Boolean(result.isError), text, json };
}

export async function registerClient(base, options = {}) {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Integration test",
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...options,
    }),
  });
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(typeof body.client_id).toBe("string");
  return body.client_id;
}

export function authorizeQuery(clientId, challenge, state) {
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

export function tokenRequest(base, params) {
  return fetch(`${base}/oauth/token`, { method: "POST", headers: FORM, body: new URLSearchParams(params) });
}

/** Register a client, sign in, consent and exchange: returns the tokens. */
export async function oauthExchange(base, apiToken, tokenExchange = tokenRequest) {
  const clientId = await registerClient(base);
  const { verifier, challenge } = pkce();
  const query = authorizeQuery(clientId, challenge, "state-helper");
  const posted = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({ authQuery: query, token: apiToken }),
  });
  const cookie = posted.headers.get("set-cookie").split(";")[0];
  const consentHtml = await posted.text();
  const approved = await fetch(`${base}/authorize/consent`, {
    method: "POST",
    headers: { ...FORM, Cookie: cookie },
    body: new URLSearchParams({
      handle: hidden(consentHtml, "handle"),
      action: "approve",
      epoch: hidden(consentHtml, "epoch"),
      scope: "mail:read",
    }),
    redirect: "manual",
  });
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const exchanged = await tokenExchange(base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status).toBe(200);
  const tokens = await exchanged.json();
  return { clientId, ...tokens };
}

/** POST an application/x-www-form-urlencoded body, cookies included. */
export function postForm(url, fields, options = {}) {
  const headers = { ...FORM, ...(options.headers ?? {}) };
  return fetch(url, { method: "POST", headers, body: new URLSearchParams(fields), redirect: "manual" });
}
