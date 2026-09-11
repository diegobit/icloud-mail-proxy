import { describe, expect, it } from "vitest";
import { parseJsonRpc, verifyDeployment } from "../../scripts/lib/verify.mjs";
import { fakeFetch } from "./helpers.mjs";

const TOKEN = "test-token";

const okMcp = [
  "/mcp",
  [
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: {} } }) +
        "\n\n",
    },
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body:
        "event: message\ndata: " +
        JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search_mail" }, { name: "list_mailboxes" }] } }) +
        "\n\n",
    },
  ],
];

/** The anonymous probe answers first, the authenticated call second. */
function healthzRules(authorized, anonymous = { status: 401, body: { error: { code: "unauthorized" } } }) {
  return ["/healthz", [anonymous, authorized]];
}

const noSleep = async () => {};

describe("SSE and JSON bodies", () => {
  it("reads the last data frame of an SSE response", () => {
    const body = "event: message\ndata: {\"a\":1}\n\nevent: message\ndata: {\"a\":2}\n\n";
    expect(parseJsonRpc("text/event-stream", body)).toEqual({ a: 2 });
    expect(parseJsonRpc("application/json", '{"a":3}')).toEqual({ a: 3 });
    expect(parseJsonRpc("application/json", "not json")).toBe(null);
  });
});

describe("successful verification", () => {
  it("checks the 401 gate, /healthz, MCP and the configured folder", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({ status: 200, body: { ok: true, imapLatencyMs: 120 } }),
      okMcp,
      ["/v1/search", { status: 200, body: { mailbox: "INBOX", total: 3, messages: [], nextBeforeUid: null } }],
    ]);

    const result = await verifyDeployment({
      url: "https://w.example.workers.dev/",
      token: TOKEN,
      mailbox: "INBOX",
      fetchImpl,
      sleep: noSleep,
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.ok)).toEqual([true, true, true, true]);
    expect(result.checks[2].detail).toContain("search_mail");
    // The first request must carry no Authorization header.
    expect(fetchImpl.requests[0].options.headers).toBeUndefined();
    expect(fetchImpl.requests[1].options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // Bounded search: one message, metadata only.
    expect(JSON.parse(fetchImpl.requests.at(-1).options.body)).toEqual({ mailbox: "INBOX", limit: 1 });
  });

  it("accepts a JSON (non-SSE) MCP response", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({ status: 200, body: { ok: true } }),
      [
        "/mcp",
        [
          { status: 200, body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } } },
          { status: 200, body: { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "search_mail" }] } } },
        ],
      ],
    ]);

    const result = await verifyDeployment({ url: "https://w.example.workers.dev", token: TOKEN, fetchImpl, sleep: noSleep });
    expect(result.ok).toBe(true);
  });
});

describe("failure classes", () => {
  it("fails when the endpoint answers unauthenticated requests", async () => {
    const fetchImpl = fakeFetch([["/healthz", { status: 200, body: { ok: true } }]]);
    const result = await verifyDeployment({ url: "https://w.example.workers.dev", token: TOKEN, fetchImpl, sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ ok: false, kind: "authorization" });
  });

  it("reports a wrong token as an authorization failure, not an iCloud problem", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({ status: 401, body: { error: { code: "unauthorized" } } }),
    ]);
    const result = await verifyDeployment({ url: "https://w.example.workers.dev", token: TOKEN, fetchImpl, sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(result.checks[1]).toMatchObject({ kind: "authorization" });
  });

  it("reports a missing API_TOKEN secret as a configuration failure", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({ status: 500, body: { error: { code: "not_configured", message: "server not configured" } } }),
      ["/healthz", { status: 500, body: { error: { code: "not_configured" } } }],
    ]);
    const result = await verifyDeployment({ url: "https://w.example.workers.dev", token: TOKEN, fetchImpl, sleep: noSleep });
    expect(result.checks[1]).toMatchObject({ kind: "configuration" });
  });

  it("reports iCloud IMAP failures from /healthz 503 codes and keeps the uncertainty", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({ status: 503, body: { ok: false, error: { code: "NO", message: "LOGIN failed" } } }),
    ]);
    const result = await verifyDeployment({ url: "https://w.example.workers.dev", token: TOKEN, fetchImpl, sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(result.checks[1].kind).toBe("upstream");
    expect(result.checks[1].detail).toContain("LOGIN failed");
    expect(result.checks[1].detail).toMatch(/cannot tell whether/);
  });

  it("describes IMAP LIMIT as a proxy size cap, not iCloud rate-limiting", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({
        status: 503,
        body: { ok: false, error: { code: "LIMIT", message: "message body 4000 bytes exceeds limit 3000" } },
      }),
    ]);
    const result = await verifyDeployment({ url: "https://w.example.workers.dev", token: TOKEN, fetchImpl, sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(result.checks[1].kind).toBe("limit");
    expect(result.checks[1].detail).toMatch(/response-size cap/);
    expect(result.checks[1].detail).toContain("message body 4000 bytes exceeds limit 3000");
    expect(result.checks[1].detail).not.toMatch(/rate-limited/i);
    expect(result.checks[1].detail).toMatch(/not a reason to rotate/);
  });

  it("does not treat an IMAP timeout as a reason to rotate the password", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({ status: 503, body: { ok: false, error: { code: "TIMEOUT", message: "IMAP timed out" } } }),
    ]);
    const result = await verifyDeployment({ url: "https://w.example.workers.dev", token: TOKEN, fetchImpl, sleep: noSleep });
    expect(result.ok).toBe(false);
    expect(result.checks[1].kind).toBe("upstream_timeout");
    expect(result.checks[1].detail).toMatch(/does not by itself mean/);
    expect(result.checks[1].detail).not.toMatch(/rotat|revok/i);
  });

  it("does not retry a /healthz 503 IMAP answer as if the Worker were still propagating", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({ status: 503, body: { ok: false, error: { code: "BAD", message: "command rejected" } } }),
    ]);
    const result = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      fetchImpl,
      sleep: noSleep,
      attempts: 4,
    });
    expect(result.checks[1].kind).toBe("upstream");
    expect(fetchImpl.requests).toHaveLength(2);
  });

  it("requires the first folder search to succeed", async () => {
    const fetchImpl = fakeFetch([
      healthzRules({ status: 200, body: { ok: true } }),
      okMcp,
      ["/v1/search", { status: 503, body: { ok: false, error: { code: "NO", message: "Mailbox does not exist" } } }],
    ]);
    const result = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      mailbox: "Archiv",
      fetchImpl,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.checks[3]).toMatchObject({ ok: false, kind: "mailbox" });
    expect(result.checks[3].advisory).toBeUndefined();
    expect(result.checks[3].detail).toContain("match iCloud exactly");
  });

  it("does not blame the folder name when the search times out or is unauthorized", async () => {
    const timeoutFetch = fakeFetch([
      healthzRules({ status: 200, body: { ok: true } }),
      okMcp,
      ["/v1/search", { status: 503, body: { ok: false, error: { code: "TIMEOUT", message: "IMAP timed out" } } }],
    ]);
    const timeout = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      mailbox: "INBOX",
      fetchImpl: timeoutFetch,
      sleep: noSleep,
    });
    expect(timeout.ok).toBe(false);
    expect(timeout.checks[3]).toMatchObject({ kind: "upstream_timeout" });
    expect(timeout.checks[3].detail).not.toMatch(/match iCloud exactly/);

    const authFetch = fakeFetch([
      healthzRules({ status: 200, body: { ok: true } }),
      okMcp,
      ["/v1/search", { status: 401, body: { error: { code: "unauthorized" } } }],
    ]);
    const auth = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      mailbox: "INBOX",
      fetchImpl: authFetch,
      sleep: noSleep,
    });
    expect(auth.ok).toBe(false);
    expect(auth.checks[3]).toMatchObject({ kind: "authorization" });
  });

  it("skips the token checks and says so when no token is available", async () => {
    const fetchImpl = fakeFetch([["/healthz", { status: 401, body: {} }]]);
    const result = await verifyDeployment({ url: "https://w.example.workers.dev", token: null, fetchImpl, sleep: noSleep });
    expect(result.skippedForToken).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.checks.filter((check) => check.skipped)).toHaveLength(2);
    expect(fetchImpl.requests).toHaveLength(1);
  });

  it("fails fast on a failed anonymous gate and does not skip as if only the token were missing", async () => {
    const open = fakeFetch([["/healthz", { status: 200, body: { ok: true } }]]);
    const openResult = await verifyDeployment({ url: "https://w.example.workers.dev", token: null, fetchImpl: open, sleep: noSleep });
    expect(openResult.ok).toBe(false);
    expect(openResult.skippedForToken).toBeUndefined();
    expect(openResult.checks[0]).toMatchObject({ kind: "authorization" });
    expect(open.requests).toHaveLength(1);

    const closed = fakeFetch([
      ["/healthz", { status: 500, body: { error: { code: "not_configured", message: "server not configured" } } }],
    ]);
    const closedResult = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      fetchImpl: closed,
      sleep: noSleep,
    });
    expect(closedResult.ok).toBe(false);
    expect(closedResult.skippedForToken).toBeUndefined();
    expect(closedResult.checks[0]).toMatchObject({ kind: "configuration" });
    expect(closedResult.checks[0].detail).toContain("not_configured");
    expect(closed.requests).toHaveLength(1);
  });
});

describe("bounded retries", () => {
  it("retries a propagating endpoint and then succeeds", async () => {
    const delays = [];
    const fetchImpl = fakeFetch([
      [
        "/healthz",
        [
          new TypeError("fetch failed"),
          { status: 404, body: "not found" },
          { status: 401, body: { error: { code: "unauthorized" } } },
          { status: 200, body: { ok: true } },
        ],
      ],
      okMcp,
    ]);

    const result = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      fetchImpl,
      sleep: async (ms) => delays.push(ms),
    });

    expect(result.ok).toBe(true);
    expect(delays).toEqual([1000, 2000]);
  });

  it("gives up after a bounded number of attempts", async () => {
    const delays = [];
    const fetchImpl = fakeFetch([["/healthz", new TypeError("fetch failed")]]);

    const result = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      fetchImpl,
      attempts: 4,
      sleep: async (ms) => delays.push(ms),
    });

    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ kind: "propagation" });
    expect(result.checks[0].detail).toContain("not reachable yet");
    expect(fetchImpl.requests).toHaveLength(4);
    expect(delays).toEqual([1000, 2000, 4000]);
    expect(delays.every((ms) => ms <= 8000)).toBe(true);
  });
});

describe("per-attempt deadline", () => {
  it("times out a never-resolving fetch", async () => {
    const result = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      fetchImpl: () => new Promise(() => {}),
      attempts: 1,
      deadlineMs: 40,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ kind: "propagation" });
    expect(result.checks[0].detail).toContain("timed out waiting for the endpoint");
  });

  it("times out an endless response body", async () => {
    const fetchImpl = fakeFetch([["/healthz", { status: 401, hangBody: true }]]);
    const result = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      fetchImpl,
      attempts: 1,
      deadlineMs: 40,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ kind: "propagation" });
    expect(result.checks[0].detail).toContain("timed out waiting for the endpoint");
  });

  it("treats a body-read error as a failed attempt, not a crash", async () => {
    const fetchImpl = fakeFetch([["/healthz", { status: 401, textError: "cannot read body" }]]);
    const result = await verifyDeployment({
      url: "https://w.example.workers.dev",
      token: TOKEN,
      fetchImpl,
      attempts: 1,
      deadlineMs: 200,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.checks[0]).toMatchObject({ kind: "propagation" });
    expect(result.checks[0].detail).toContain("cannot read body");
  });
});
