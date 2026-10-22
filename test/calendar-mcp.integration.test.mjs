// The calendar MCP surface with writes enabled. This starts the real Worker
// from wrangler.base.jsonc and inspects tools/list; iCloud is never contacted
// because the delete call is rejected before discovery.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  freePort,
  mcpToolCall,
  mcpToolsListDetailed,
  startWorker,
  TOKEN_A,
} from "./support/oauth-flow.mjs";

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
});
