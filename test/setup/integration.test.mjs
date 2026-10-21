// The whole guided setup with only the prompts faked: the real Wrangler
// adapter (against the fake CLI), the real config composer, the real state
// file, and the real HTTP/MCP verification against a fake endpoint.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readBaseConfig, writeGeneratedConfig } from "../../scripts/lib/config.mjs";
import { parseJsonc } from "../../scripts/lib/jsonc.mjs";
import { runSetup } from "../../scripts/lib/setup.mjs";
import { fileStateStore } from "../../scripts/lib/state.mjs";
import { verifyDeployment } from "../../scripts/lib/verify.mjs";
import { createWranglerAdapter } from "../../scripts/lib/wrangler.mjs";
import { fakeFetch, fakePrompts, sseFrame } from "./helpers.mjs";

const fakeBin = fileURLToPath(new URL("./fake-wrangler.mjs", import.meta.url));
const PASSWORD = "abcd-efgh-ijkl-mnop";

let workdir;
let logFile;

beforeEach(() => {
  workdir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-mail-setup-"));
  logFile = path.join(workdir, "wrangler-calls.ndjson");
  process.env.FAKE_WRANGLER_LOG = logFile;
});

afterEach(() => {
  delete process.env.FAKE_WRANGLER_LOG;
  fs.rmSync(workdir, { recursive: true, force: true });
});

function endpoint() {
  const origin = "https://w.personal.workers.dev";
  return fakeFetch([
    [
      "/healthz",
      [
        { status: 401, body: { error: { code: "unauthorized" } } },
        { status: 200, body: { ok: true, imapLatencyMs: 210 } },
      ],
    ],
    [
      "/.well-known/oauth-protected-resource/mcp",
      {
        status: 200,
        body: { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["mail:read"] },
      },
    ],
    [
      "/.well-known/oauth-authorization-server",
      { status: 200, body: { issuer: origin, client_id_metadata_document_supported: true } },
    ],
    [
      (url, options) => url.endsWith("/mcp") && !options.headers?.Authorization,
      {
        status: 401,
        headers: {
          "www-authenticate": `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mail:read"`,
        },
        body: { error: { code: "unauthorized" } },
      },
    ],
    [
      "/mcp",
      [
        sseFrame({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }),
        sseFrame({
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: [
              { name: "list_mailboxes" },
              { name: "search_mail" },
              { name: "get_mail_message" },
              { name: "get_mail_attachment" },
              { name: "archive_mail" },
              { name: "delete_mail" },
              { name: "send_mail" },
              { name: "save_draft" },
            ],
          },
        }),
      ],
    ],
    ["/v1/search", { status: 200, body: { mailbox: "INBOX", total: 7, messages: [], nextBeforeUid: null } }],
  ]);
}

describe("first guided setup, end to end", () => {
  it("selects an account, deploys, verifies, and leaves no secret on disk", async () => {
    // "missing" is the Worker name the fake CLI reports as not existing.
    const prompts = fakePrompts([
      ["Which Cloudflare account", 1],
      ["Worker name", "missing"],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", "INBOX, Archive"],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const secrets = [];
    const statePath = path.join(workdir, "state.json");
    const store = fileStateStore(statePath);
    const fetchImpl = endpoint();

    const result = await runSetup({
      prompts,
      wrangler: createWranglerAdapter({ bin: fakeBin, secrets }),
      state: { read: () => store.read(), write: (state) => store.write(state, secrets), path: statePath },
      verify: (args) => verifyDeployment({ ...args, fetchImpl, sleep: async () => {} }),
      discover: async () => ({ calendars: [], reminderLists: [] }),
      writeConfig: (fragment) => writeGeneratedConfig(fragment, { base: readBaseConfig(), dir: workdir }),
      baseConfig: readBaseConfig(),
      generateToken: () => "integration-token-abcdefghij",
      registerSecret: (secret) => secrets.push(secret),
      log: (text) => prompts.print(text),
    });

    expect(result.code).toBe(0);
    expect(result.verified).toBe(true);
    expect(result.url).toBe("https://w.personal.workers.dev");

    // Wrangler was driven with argument arrays; the secrets went over stdin.
    const calls = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.argv.slice(0, 2).join(" "))).toEqual([
      "--version",
      "whoami --json",
      "secret list",
      "secret bulk",
      "deploy -c",
    ]);
    const bulk = calls.find((call) => call.argv[1] === "bulk");
    expect(bulk.accountId).toBe("acc-2");
    expect(JSON.parse(bulk.stdin)).toEqual({
      ICLOUD_USER: "me@icloud.com",
      ICLOUD_APP_PASSWORD: PASSWORD,
      API_TOKEN: "integration-token-abcdefghij",
    });
    expect(JSON.stringify(calls.map((call) => call.argv))).not.toContain(PASSWORD);

    // The generated config is the tracked defaults plus this target.
    const config = parseJsonc(fs.readFileSync(path.join(workdir, "wrangler.local.jsonc"), "utf8"));
    expect(config).toMatchObject({
      name: "missing",
      account_id: "acc-2",
      workers_dev: true,
      compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    });
    expect(config.vars.ALLOWED_MAILBOXES).toBe("INBOX,Archive");
    expect(config.routes).toBeUndefined();

    // Nonsecret state only, readable by its owner alone.
    const stateText = fs.readFileSync(statePath, "utf8");
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    expect(stateText).not.toContain(PASSWORD);
    expect(stateText).not.toContain("integration-token-abcdefghij");
    expect(JSON.parse(stateText)).toMatchObject({
      accountId: "acc-2",
      accountName: "Personal",
      workerName: "missing",
      allowedMailboxes: "INBOX,Archive",
      stage: "verified",
      url: "https://w.personal.workers.dev",
    });

    // Every live check ran against the reported URL: the anonymous gate, the
    // three OAuth probes, the authenticated calls and the folder search.
    expect(fetchImpl.requests.map((request) => request.url)).toEqual([
      "https://w.personal.workers.dev/healthz",
      "https://w.personal.workers.dev/.well-known/oauth-protected-resource/mcp",
      "https://w.personal.workers.dev/.well-known/oauth-authorization-server",
      "https://w.personal.workers.dev/mcp",
      "https://w.personal.workers.dev/healthz",
      "https://w.personal.workers.dev/mcp",
      "https://w.personal.workers.dev/mcp",
      "https://w.personal.workers.dev/v1/search",
    ]);

    const output = prompts.output();
    expect(output).not.toContain(PASSWORD);
    expect(output).not.toContain("integration-token-abcdefghij");
    expect(output).toContain("claude mcp add --transport http icloud-mail https://w.personal.workers.dev/mcp");
    expect(output).toContain("$ICLOUD_MAIL_TOKEN");
    expect(output).toContain("[ok  ] MCP initialize and tools/list");
    expect(output).toContain("ChatGPT");
    expect(output).toContain("claude.ai");
    expect(output).toContain("OAUTH_KV");
  });
});
