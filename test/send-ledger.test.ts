import { describe, expect, it } from "vitest";
import {
  CLAIM_TIMEOUT_MS,
  DUPLICATE_WINDOW_MS,
  SendLedgerCore,
  usageDay,
  type AuditEntry,
  type LedgerStore,
} from "../src/send-ledger-core";
import type { SendCaps } from "../src/send-policy";

class MemoryLedgerStore implements LedgerStore {
  usage = new Map<string, { messages: number; recipients: number }>();
  audit: AuditEntry[] = [];
  claims = new Map<string, { ts: number; inflight: boolean; claimedAt: number }>();

  getUsage(day: string) {
    return this.usage.get(day) ?? null;
  }
  setUsage(day: string, messages: number, recipients: number): void {
    this.usage.set(day, { messages, recipients });
  }
  addAudit(entry: AuditEntry): void {
    this.audit.push(entry);
  }
  pruneAudit(before: number): void {
    this.audit = this.audit.filter((entry) => entry.ts >= before);
  }
  claimSend(hash: string, ts: number): "claimed" | "busy" {
    const row = this.claims.get(hash);
    if (row?.inflight) return "busy";
    this.claims.set(hash, { ts: row?.ts ?? 0, inflight: true, claimedAt: ts });
    return "claimed";
  }
  lastSendAt(hash: string): number | null {
    const ts = this.claims.get(hash)?.ts ?? 0;
    return ts > 0 ? ts : null;
  }
  keepSend(hash: string, ts: number): void {
    this.claims.set(hash, { ts, inflight: false, claimedAt: 0 });
  }
  releaseSend(hash: string): void {
    const row = this.claims.get(hash);
    if (row) this.claims.set(hash, { ...row, inflight: false });
  }
  pruneSends(before: number): void {
    for (const [hash, row] of this.claims) {
      if (row.inflight && row.claimedAt < before) this.claims.set(hash, { ...row, inflight: false });
    }
    for (const [hash, row] of this.claims) {
      if (!row.inflight && row.ts < before) this.claims.delete(hash);
    }
  }
}

const CAPS: SendCaps = { maxPerDay: 3, maxRcptsPerDay: 5, maxRcptsPerMessage: 2, maxBodyBytes: 65_536 };
const NOW = 1_800_000_000_000;

function setup() {
  const store = new MemoryLedgerStore();
  return { store, core: new SendLedgerCore(store) };
}

describe("quota", () => {
  it("reserves messages and recipients for the UTC day", () => {
    const { store, core } = setup();
    expect(core.beginSend(NOW, 2, "h1", false, CAPS)).toMatchObject({ ok: true });
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 1, recipients: 2 });
    expect(core.beginSend(NOW, 1, "h2", false, CAPS)).toMatchObject({ ok: true });
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 2, recipients: 3 });
  });

  it("refuses past the daily message or recipient cap, and with the kill switch", () => {
    const { store, core } = setup();
    expect(core.beginSend(NOW, 2, "h1", false, CAPS).ok).toBe(true);
    expect(core.beginSend(NOW, 2, "h2", false, CAPS).ok).toBe(true);
    const byMessages = core.beginSend(NOW, 2, "h3", false, { ...CAPS, maxPerDay: 2 });
    expect(byMessages).toMatchObject({ ok: false, code: "daily_limit_reached" });
    const byRecipients = core.beginSend(NOW, 2, "h4", false, { ...CAPS, maxRcptsPerDay: 4 });
    expect(byRecipients).toMatchObject({ ok: false, code: "daily_limit_reached" });
    expect(core.beginSend(NOW, 1, "h5", false, { ...CAPS, maxPerDay: 0 })).toMatchObject({
      ok: false,
      code: "daily_limit_reached",
    });
    // Nothing was consumed by the refusals, and their claims were given back.
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 2, recipients: 4 });
    expect(store.claims.get("h3")?.inflight).toBe(false);
  });

  it("gives the reservation back on release, never below zero", () => {
    const { store, core } = setup();
    core.beginSend(NOW, 2, "h1", false, CAPS);
    core.release(usageDay(NOW), 2, "h1");
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 0, recipients: 0 });
    core.release(usageDay(NOW), 2, "h1");
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 0, recipients: 0 });
  });

  it("keys quota by UTC day", () => {
    const { store, core } = setup();
    core.beginSend(NOW, 1, "h1", false, CAPS);
    const nextDay = NOW + 86_400_000;
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 1, recipients: 1 });
    expect(store.getUsage(usageDay(nextDay))).toBeNull();
    expect(core.beginSend(nextDay, 1, "h2", false, CAPS).ok).toBe(true);
    expect(store.getUsage(usageDay(nextDay))).toEqual({ messages: 1, recipients: 1 });
  });
});

describe("duplicate window", () => {
  it("refuses an identical in-flight or recently completed message, letting a failed one retry", () => {
    const { core } = setup();
    // First attempt, still in flight.
    expect(core.beginSend(NOW, 1, "hash-a", false, CAPS).ok).toBe(true);
    expect(core.beginSend(NOW + 5_000, 1, "hash-a", false, CAPS)).toMatchObject({ ok: false, code: "duplicate_send" });
    // It failed before delivery: the retry is allowed.
    core.release(usageDay(NOW), 1, "hash-a");
    expect(core.beginSend(NOW + 6_000, 1, "hash-a", false, CAPS).ok).toBe(true);
    // It completed as sent: the window applies from now on.
    core.keep("hash-a", NOW + 6_000);
    expect(core.beginSend(NOW + 7_000, 1, "hash-a", false, CAPS)).toMatchObject({ ok: false, code: "duplicate_send" });
    // A different message is never a duplicate.
    expect(core.beginSend(NOW + 7_000, 1, "hash-b", false, CAPS).ok).toBe(true);
  });

  it("keeps an earlier send's window when a forced resend fails", () => {
    const { core } = setup();
    expect(core.beginSend(NOW, 1, "hash-a", false, CAPS).ok).toBe(true);
    core.keep("hash-a", NOW);
    // A deliberate resend is claimed, then fails before delivery.
    expect(core.beginSend(NOW + 1_000, 1, "hash-a", true, CAPS).ok).toBe(true);
    core.release(usageDay(NOW), 1, "hash-a");
    // The original window must still be there: a third attempt is a duplicate.
    expect(core.beginSend(NOW + 2_000, 1, "hash-a", false, CAPS)).toMatchObject({
      ok: false,
      code: "duplicate_send",
    });
  });

  it("refuses an identical message that is already in flight, whatever the flags", () => {
    const { store, core } = setup();
    expect(core.beginSend(NOW, 1, "hash-a", false, CAPS).ok).toBe(true);
    const concurrent = core.beginSend(NOW, 1, "hash-a", true, CAPS);
    expect(concurrent).toMatchObject({ ok: false, code: "duplicate_send" });
    expect(concurrent.ok === false && concurrent.message).toContain("already being submitted");
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 1, recipients: 1 });
  });

  it("allows the same message after the window or with allowDuplicate", () => {
    const { core } = setup();
    expect(core.beginSend(NOW, 1, "hash-a", false, CAPS).ok).toBe(true);
    core.keep("hash-a", NOW);
    expect(core.beginSend(NOW + DUPLICATE_WINDOW_MS + 1, 1, "hash-a", false, CAPS).ok).toBe(true);
    core.release(usageDay(NOW), 1, "hash-a");
    expect(core.beginSend(NOW + DUPLICATE_WINDOW_MS + 2, 1, "hash-a", true, CAPS).ok).toBe(true);
  });

  it("does not spend quota on a refused duplicate", () => {
    const { store, core } = setup();
    core.beginSend(NOW, 1, "hash-a", false, CAPS);
    core.keep("hash-a", NOW);
    core.beginSend(NOW + 1, 1, "hash-a", false, CAPS);
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 1, recipients: 1 });
  });

  it("frees a claim abandoned by a crash and prunes completed windows", () => {
    const { store, core } = setup();
    // A claim never completed (the isolate died mid-send) blocks a resend...
    expect(core.beginSend(NOW, 1, "hash-a", false, CAPS).ok).toBe(true);
    expect(core.beginSend(NOW + 1_000, 1, "hash-a", true, CAPS)).toMatchObject({ ok: false, code: "duplicate_send" });
    // ...until the timeout sweep frees it; with no completed send to remember,
    // the row goes away entirely.
    core.sweep(NOW + CLAIM_TIMEOUT_MS + 1);
    expect(store.claims.has("hash-a")).toBe(false);
    expect(core.beginSend(NOW + CLAIM_TIMEOUT_MS + 2, 1, "hash-a", false, CAPS).ok).toBe(true);
    // A completed window older than the timeout is dropped entirely.
    core.keep("hash-a", NOW + CLAIM_TIMEOUT_MS + 2);
    core.sweep(NOW + 2 * CLAIM_TIMEOUT_MS + 3);
    expect(store.claims.has("hash-a")).toBe(false);
  });
});

describe("audit", () => {
  it("records metadata-only entries, logs them, and sweeps old rows", () => {
    const store = new MemoryLedgerStore();
    const logged: AuditEntry[] = [];
    const core = new SendLedgerCore(store, (entry) => logged.push(entry));
    core.audit({
      event: "sent",
      principal: "bearer",
      rcptCount: 1,
      rcptDomains: ["example.com"],
      bytes: 100,
      smtpCode: "250",
      durationMs: 12,
    });
    expect(logged).toHaveLength(1);
    expect(store.audit).toHaveLength(1);
    expect(JSON.stringify(store.audit[0])).not.toContain("body");
    store.audit.unshift({
      ts: NOW - 100 * 86_400_000,
      event: "sent",
      principal: null,
      rcptCount: null,
      rcptDomains: null,
      bytes: null,
      smtpCode: null,
      durationMs: null,
    });
    core.sweep(NOW);
    expect(store.audit).toHaveLength(1);
  });
});
