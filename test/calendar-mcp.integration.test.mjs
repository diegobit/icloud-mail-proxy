// The calendar MCP surface with writes enabled. This starts the real Worker
// from wrangler.base.jsonc and inspects tools/list; iCloud is never contacted
// because the delete call is rejected before discovery.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FORM,
  freePort,
  hidden,
  mcpToolCall,
  mcpToolsListDetailed,
  pkce,
  REDIRECT_URI,
  registerClient,
  startWorker,
  TOKEN_A,
  tokenRequest,
} from "./support/oauth-flow.mjs";

async function grant(base, scopes) {
  const clientId = await registerClient(base);
  const { verifier, challenge } = pkce();
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: scopes.join(" "),
    state: "calendar-scope-check",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const posted = await fetch(`${base}/authorize`, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({ authQuery: query, token: TOKEN_A }),
  });
  const cookie = posted.headers.get("set-cookie").split(";")[0];
  const html = await posted.text();
  const form = new URLSearchParams({
    handle: hidden(html, "handle"),
    action: "approve",
    epoch: hidden(html, "epoch"),
  });
  for (const scope of scopes) form.append("scope", scope);
  const approved = await fetch(`${base}/authorize/consent`, {
    method: "POST",
    headers: { ...FORM, Cookie: cookie },
    body: form,
    redirect: "manual",
  });
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const exchanged = await tokenRequest(base, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
  expect(exchanged.status).toBe(200);
  return (await exchanged.json()).access_token;
}

describe("calendar MCP surface", () => {
  let current;

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-calendar-mcp-"));
    current = await startWorker(TOKEN_A, path.join(dir, "kv"), await freePort(), {
      ALLOWED_CALENDARS: { type: "plain_text", value: "*" },
      CALENDAR_WRITE: { type: "plain_text", value: "1" },
    });
  }, 120_000);

  afterAll(async () => {
    await current?.worker.dispose();
  });

  it("registers delete_event with destructive annotations", async () => {
    const tools = await mcpToolsListDetailed(current.base, TOKEN_A);
    expect(tools).toHaveLength(14);
    const remove = tools.find((tool) => tool.name === "delete_event");
    expect(remove).toBeDefined();
    expect(remove.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
    });
  });

  it("rejects an invalid ETag before any calendar request", async () => {
    const result = await mcpToolCall(current.base, TOKEN_A, "delete_event", {
      calendar: "Lavoro",
      id: "plain",
      etag: "not-a-strong-etag",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("invalid_etag");
  });

  it("does not let a calendar:write grant delete without calendar:delete", async () => {
    const writeToken = await grant(current.base, ["mail:read", "calendar:read", "calendar:write"]);
    const denied = await mcpToolCall(current.base, writeToken, "delete_event", {
      calendar: "Lavoro",
      id: "plain",
      etag: "not-a-strong-etag",
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("calendar:delete");

    const deleteToken = await grant(current.base, [
      "mail:read",
      "calendar:read",
      "calendar:delete",
    ]);
    const allowedThroughScope = await mcpToolCall(current.base, deleteToken, "delete_event", {
      calendar: "Lavoro",
      id: "plain",
      etag: "not-a-strong-etag",
    });
    expect(allowedThroughScope.isError).toBe(true);
    expect(allowedThroughScope.text).toContain("invalid_etag");
  });

});
