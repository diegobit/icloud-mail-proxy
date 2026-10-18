import { describe, expect, it } from "vitest";
import {
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
  sends = new Map<string, number>();

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
  lastSendAt(hash: string): number | null {
    return this.sends.get(hash) ?? null;
  }
  recordSend(hash: string, ts: number): void {
    this.sends.set(hash, ts);
  }
  forgetSend(hash: string): void {
    this.sends.delete(hash);
  }
  pruneSends(before: number): void {
    for (const [hash, ts] of this.sends) {
      if (ts < before) this.sends.delete(hash);
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
    // Third message with two recipients: 3 messages is the cap, 4+2 = 6 > 5 recipients.
    const byMessages = core.beginSend(NOW, 2, "h3", false, { ...CAPS, maxPerDay: 2 });
    expect(byMessages).toMatchObject({ ok: false, code: "daily_limit_reached" });
    const byRecipients = core.beginSend(NOW, 2, "h4", false, { ...CAPS, maxRcptsPerDay: 4 });
    expect(byRecipients).toMatchObject({ ok: false, code: "daily_limit_reached" });
    expect(core.beginSend(NOW, 1, "h5", false, { ...CAPS, maxPerDay: 0 })).toMatchObject({
      ok: false,
      code: "daily_limit_reached",
    });
    // Nothing was consumed by the refusals.
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 2, recipients: 4 });
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
  it("refuses an identical message inside the window and allows it once released", () => {
    const { core } = setup();
    expect(core.beginSend(NOW, 1, "hash-a", false, CAPS).ok).toBe(true);
    const again = core.beginSend(NOW + 5_000, 1, "hash-a", false, CAPS);
    expect(again).toMatchObject({ ok: false, code: "duplicate_send" });
    // A failure before delivery releases the claim, so the retry goes through.
    core.release(usageDay(NOW), 1, "hash-a");
    expect(core.beginSend(NOW + 6_000, 1, "hash-a", false, CAPS).ok).toBe(true);
    // A different message is never a duplicate.
    expect(core.beginSend(NOW + 6_000, 1, "hash-b", false, CAPS).ok).toBe(true);
  });

  it("allows the same message after the window or with allowDuplicate", () => {
    const { core } = setup();
    expect(core.beginSend(NOW, 1, "hash-a", false, CAPS).ok).toBe(true);
    expect(core.beginSend(NOW + DUPLICATE_WINDOW_MS + 1, 1, "hash-a", false, CAPS).ok).toBe(true);
    expect(core.beginSend(NOW + DUPLICATE_WINDOW_MS + 2, 1, "hash-a", true, CAPS).ok).toBe(true);
  });

  it("does not spend quota on a refused duplicate", () => {
    const { store, core } = setup();
    core.beginSend(NOW, 1, "hash-a", false, CAPS);
    core.beginSend(NOW + 1, 1, "hash-a", false, CAPS);
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 1, recipients: 1 });
  });

  it("prunes stale claims at begin and at sweep", () => {
    const { store, core } = setup();
    expect(core.beginSend(NOW, 1, "hash-a", false, CAPS).ok).toBe(true);
    core.sweep(NOW + 11 * 60_000);
    expect(store.lastSendAt("hash-a")).toBeNull();
    expect(core.beginSend(NOW + 12 * 60_000, 1, "hash-a", false, CAPS).ok).toBe(true);
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
