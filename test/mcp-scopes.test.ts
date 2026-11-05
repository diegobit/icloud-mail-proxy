// The per-tool scope matrix, driven through the real McpServer over an
// in-memory transport. Every network path is a spy: IMAP and SMTP sockets
// (cloudflare:sockets), CalDAV (fetch), the SendLedger Durable Object and the
// calendar write limiter. A refused call must reach none of them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sockets = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("cloudflare:sockets", () => ({
  connect: (...args: unknown[]) => {
    sockets.connect(...args);
    throw new Error("network disabled in this test");
  },
}));
// The agents SDK pulls in Workers-only modules; the in-memory transport below
// replaces the HTTP handler it would build.
vi.mock("agents/mcp", () => ({ createMcpHandler: vi.fn() }));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp";
import { authorityOf, type Authority } from "../src/scopes";
import type { Env } from "../src/types";

const ledger = { get: vi.fn(), idFromName: vi.fn(), send: vi.fn(), saveDraft: vi.fn() };
const limiter = { limit: vi.fn() };
const fetchSpy = vi.fn();

function makeEnv(overrides: Partial<Env> = {}): Env {
  ledger.idFromName.mockReturnValue("ledger-id");
  ledger.get.mockReturnValue({ send: ledger.send, saveDraft: ledger.saveDraft });
  ledger.send.mockResolvedValue({ ok: false, code: "quota_exceeded", message: "test ledger" });
  ledger.saveDraft.mockResolvedValue({ ok: false, code: "imap_error", message: "test ledger" });
  limiter.limit.mockResolvedValue({ success: false });
  return {
    ICLOUD_USER: "owner@example.com",
    ICLOUD_APP_PASSWORD: "app-password",
    API_TOKEN: "token",
    ALLOWED_MAILBOXES: "INBOX,Archive",
    MAX_RESULTS: "50",
    MAX_MESSAGE_BYTES: "1048576",
    MAX_SEARCH_DAYS: "365",
    ALLOWED_ATTACHMENT_TYPES: "application/pdf",
    MAX_ATTACHMENT_BYTES: "2097152",
    SEND_MAX_PER_DAY: "20",
    SEND_MAX_RCPTS_PER_DAY: "50",
    SEND_MAX_RCPTS_PER_MESSAGE: "5",
    SEND_MAX_BODY_BYTES: "65536",
    ALLOWED_CALENDARS: "*",
    CALENDAR_WRITE: "1",
    SEND_LEDGER: { get: ledger.get, idFromName: ledger.idFromName },
    CALENDAR_WRITE_LIMITER: limiter,
    CONTACTS_ENABLED: "1",
    CONTACTS_LIMITER: limiter,
    ...overrides,
  } as unknown as Env;
}

async function connect(authority: Authority, env: Env) {
  const server = buildServer(env, "oauth:test-client", authority, "203.0.113.7");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "scope-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

async function callTool(authority: Authority, name: string, args: Record<string, unknown>) {
  const server = buildServer(makeEnv(), "oauth:test-client", authority, "203.0.113.7");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "scope-test", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text: string }[];
    return { isError: result.isError === true, text: content.map((part) => part.text).join("") };
  } finally {
    await client.close();
  }
}

const oauth = (...scopes: string[]) => authorityOf({ via: "oauth" }, { scope: scopes });
const bearer = authorityOf({ via: "bearer" }, { scope: [] });

const id = { mailbox: "INBOX", uidValidity: 1, uid: 42 };
const compose = { to: ["marco@example.org"], text: "Ciao" };

// The plan's table, tool by tool (plans/feature-gap-roadmap.md, unit 1).
const MAIL_TOOLS: { tool: string; scope: string; args: Record<string, unknown> }[] = [
  { tool: "list_mailboxes", scope: "mail:read", args: {} },
  { tool: "search_mail", scope: "mail:read", args: { mailbox: "INBOX" } },
  { tool: "get_mail_message", scope: "mail:read", args: id },
  { tool: "get_mail_attachment", scope: "mail:read", args: { ...id, index: 0 } },
  { tool: "read_mail", scope: "mail:modify", args: id },
  { tool: "set_mail_flag", scope: "mail:modify", args: { ...id, flag: "seen", value: false } },
  { tool: "archive_mail", scope: "mail:modify", args: id },
  { tool: "restore_mail", scope: "mail:modify", args: { ...id, mailbox: "Archive" } },
  { tool: "save_draft", scope: "mail:modify", args: compose },
  { tool: "delete_mail", scope: "mail:trash", args: id },
  { tool: "send_mail", scope: "mail:send", args: compose },
];

const ALL_SCOPES = [
  "mail:read",
  "mail:modify",
  "mail:trash",
  "mail:send",
  "calendar:read",
  "calendar:write",
  "calendar:delete",
  "contacts:read",
];

/** Scopes that satisfy `scope`: itself, plus the write scopes implying a read. */
function satisfying(scope: string): string[] {
  if (scope === "mail:read") return ["mail:read", "mail:modify", "mail:trash", "mail:send"];
  return [scope];
}

function expectNoNetwork() {
  expect(sockets.connect).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  expect(ledger.get).not.toHaveBeenCalled();
  expect(ledger.send).not.toHaveBeenCalled();
  expect(ledger.saveDraft).not.toHaveBeenCalled();
  expect(limiter.limit).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("mail tool scopes", () => {
  it("rejects unknown search fields before opening a connection", async () => {
    const result = await callTool(oauth("mail:read"), "search_mail", { mailbox: "INBOX", hasAttachments: true });
    expect(result.isError).toBe(true);
    expectNoNetwork();
  });
  for (const { tool, scope, args } of MAIL_TOOLS) {
    const wrong = ALL_SCOPES.filter((candidate) => !satisfying(scope).includes(candidate));
    for (const held of wrong) {
      it(`${tool} refuses a grant holding only ${held} before any network call`, async () => {
        const result = await callTool(oauth(held), tool, args);
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          `insufficient_scope: this operation requires the ${scope} scope; reconnect and approve it`,
        );
        expectNoNetwork();
      });
    }
  }

  it("keeps an old mail:read-only grant reading and refuses every mail write tool", async () => {
    const legacy = oauth("mail:read");
    const listed = await callTool(legacy, "list_mailboxes", {});
    expect(listed.isError).toBe(false);
    expect(JSON.parse(listed.text)).toEqual({ mailboxes: ["INBOX", "Archive"] });
    const outside = await callTool(legacy, "search_mail", { mailbox: "Not Allowed" });
    expect(outside.text).toContain("mailbox_not_allowed");

    for (const tool of ["read_mail", "archive_mail", "restore_mail", "save_draft", "delete_mail", "send_mail"]) {
      const entry = MAIL_TOOLS.find((candidate) => candidate.tool === tool)!;
      const result = await callTool(legacy, tool, entry.args);
      expect(result.text, tool).toMatch(/^insufficient_scope: /);
    }
    expectNoNetwork();
  });

  it("lets each write scope read, without granting another write", async () => {
    for (const held of ["mail:modify", "mail:trash", "mail:send"]) {
      const listed = await callTool(oauth(held), "list_mailboxes", {});
      expect(listed.isError, held).toBe(false);
    }
    expect((await callTool(oauth("mail:modify"), "send_mail", compose)).text).toContain("mail:send");
    expect((await callTool(oauth("mail:modify"), "delete_mail", id)).text).toContain("mail:trash");
    expect((await callTool(oauth("mail:trash"), "archive_mail", id)).text).toContain("mail:modify");
    expect((await callTool(oauth("mail:send"), "save_draft", compose)).text).toContain("mail:modify");
    expectNoNetwork();
  });

  it("passes the guard with the right scope and reaches the operation", async () => {
    const outside = { ...id, mailbox: "Not Allowed" };
    for (const tool of ["read_mail", "archive_mail"]) {
      const result = await callTool(oauth("mail:modify"), tool, outside);
      expect(result.text, tool).toContain("mailbox_not_allowed");
    }
    expect((await callTool(oauth("mail:trash"), "delete_mail", outside)).text).toContain(
      "mailbox_not_allowed",
    );

    const sent = await callTool(oauth("mail:send"), "send_mail", compose);
    expect(sent.text).toContain("quota_exceeded");
    expect(ledger.send).toHaveBeenCalledTimes(1);
    const drafted = await callTool(oauth("mail:modify"), "save_draft", compose);
    expect(drafted.isError).toBe(true);
    expect(ledger.saveDraft).toHaveBeenCalledTimes(1);
  });

  it("lets the static bearer reach every mail tool", async () => {
    const outside = { ...id, mailbox: "Not Allowed" };
    for (const tool of ["read_mail", "archive_mail", "delete_mail"]) {
      expect((await callTool(bearer, tool, outside)).text, tool).toContain("mailbox_not_allowed");
    }
    expect((await callTool(bearer, "send_mail", compose)).text).toContain("quota_exceeded");
    expect((await callTool(bearer, "save_draft", compose)).isError).toBe(true);
    expect(ledger.send).toHaveBeenCalledTimes(1);
    expect(ledger.saveDraft).toHaveBeenCalledTimes(1);
  });
});

describe("calendar tool scopes", () => {
  it("does not let any mail scope open the calendar domain", async () => {
    for (const held of ["mail:read", "mail:modify", "mail:trash", "mail:send"]) {
      const result = await callTool(oauth(held), "list_calendars", {});
      expect(result.text, held).toContain("requires the calendar:read scope");
    }
    expectNoNetwork();
  });

  it("does not let calendar scopes reach mail", async () => {
    const result = await callTool(oauth("calendar:read", "calendar:write", "calendar:delete"), "list_mailboxes", {});
    expect(result.text).toContain("requires the mail:read scope");
    expectNoNetwork();
  });
});

describe("contact tool scopes", () => {
  for (const [tool, args] of [
    ["search_contacts", { query: "Rossi" }],
    ["get_contact", { id: "anna-bianchi" }],
  ] as const) {
    for (const held of ALL_SCOPES.filter((scope) => scope !== "contacts:read")) {
      it(`${tool} refuses a grant holding only ${held} before any network call`, async () => {
        const result = await callTool(oauth(held), tool, args);
        expect(result.text).toBe(
          "insufficient_scope: this operation requires the contacts:read scope; reconnect and approve it",
        );
        expectNoNetwork();
      });
    }
  }

  it("passes the guard with contacts:read and reaches the limiter", async () => {
    const result = await callTool(oauth("contacts:read"), "search_contacts", { query: "Rossi" });
    expect(result.text).toContain("rate_limited");
    expect(limiter.limit).toHaveBeenCalledWith({ key: "203.0.113.7" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not let contacts:read reach mail", async () => {
    const result = await callTool(oauth("contacts:read"), "list_mailboxes", {});
    expect(result.text).toContain("requires the mail:read scope");
  });

  it("registers the contact tools only when contacts are enabled", async () => {
    const on = await connect(bearer, makeEnv());
    const off = await connect(bearer, makeEnv({ CONTACTS_ENABLED: "0" }));
    try {
      const onNames = (await on.listTools()).tools.map((tool) => tool.name);
      const offNames = (await off.listTools()).tools.map((tool) => tool.name);
      expect(onNames).toEqual(expect.arrayContaining(["search_contacts", "get_contact"]));
      expect(onNames).toHaveLength(19);
      expect(offNames).not.toContain("search_contacts");
      expect(offNames).not.toContain("get_contact");
      expect(offNames).toHaveLength(17);
      const search = (await on.listTools()).tools.find((tool) => tool.name === "search_contacts");
      expect(search?.annotations).toMatchObject({ readOnlyHint: true });
      expect(search?.description).toContain("untrusted");
    } finally {
      await on.close();
      await off.close();
    }
  });
});
