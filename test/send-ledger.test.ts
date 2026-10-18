import { describe, expect, it } from "vitest";
import {
  SendLedgerCore,
  SENDING_STUCK_MS,
  usageDay,
  viewOf,
  type AuditEntry,
  type DraftMeta,
  type DraftRow,
  type LedgerStore,
  type NewDraft,
} from "../src/send-ledger-core";
import type { SendCaps } from "../src/send-policy";

class MemoryLedgerStore implements LedgerStore {
  drafts = new Map<string, DraftRow>();
  usage = new Map<string, { messages: number; recipients: number }>();
  audit: AuditEntry[] = [];

  getDraft(id: string): DraftRow | null {
    return this.drafts.get(id) ?? null;
  }
  insertDraft(row: DraftRow): void {
    this.drafts.set(row.id, structuredClone(row));
  }
  updateDraft(id: string, patch: Partial<DraftRow>): void {
    const row = this.drafts.get(id);
    if (row) this.drafts.set(id, { ...row, ...patch });
  }
  deleteDraft(id: string): void {
    this.drafts.delete(id);
  }
  listDrafts(principal: string): DraftRow[] {
    return [...this.drafts.values()].filter((row) => row.principal === principal);
  }
  countReadyDrafts(principal: string): number {
    return this.listDrafts(principal).filter((row) => row.status === "ready").length;
  }
  getUsage(day: string) {
    return this.usage.get(day) ?? null;
  }
  setUsage(day: string, messages: number, recipients: number): void {
    this.usage.set(day, { messages, recipients });
  }
  addAudit(entry: AuditEntry): void {
    this.audit.push(entry);
  }
  listExpiredDrafts(now: number, limit: number): string[] {
    return [...this.drafts.values()]
      .filter((row) => row.expiresAt < now)
      .slice(0, limit)
      .map((row) => row.id);
  }
  minExpiresAt(): number | null {
    const values = [...this.drafts.values()].map((row) => row.expiresAt);
    return values.length === 0 ? null : Math.min(...values);
  }
  pruneAudit(before: number): void {
    this.audit = this.audit.filter((entry) => entry.ts >= before);
  }
}

const CAPS: SendCaps = {
  maxPerDay: 5,
  maxRcptsPerDay: 20,
  maxRcptsPerMessage: 3,
  maxBodyBytes: 65_536,
  draftTtlSeconds: 3_600,
  maxOpenDrafts: 2,
};

const NOW = 1_800_000_000_000;

function meta(overrides: Partial<DraftMeta> = {}): DraftMeta {
  return {
    fromName: "Diego",
    fromAddr: "diego@example.com",
    toDisplay: ["a@example.com"],
    ccDisplay: [],
    bccDisplay: [],
    subject: "Pranzo",
    dateIso: new Date(NOW).toISOString(),
    messageId: "<m@example.com>",
    inReplyTo: null,
    text: "Ciao",
    textBytes: 4,
    ...overrides,
  };
}

function newDraft(id: string, overrides: Partial<NewDraft> = {}): NewDraft {
  return {
    id,
    principal: "bearer",
    rawB64: btoa("Subject: x\r\n\r\nCiao\r\n"),
    envelopeFrom: "diego@example.com",
    recipients: ["a@example.com"],
    meta: meta(),
    nonce: `nonce-${id}`,
    createdAt: NOW,
    expiresAt: NOW + 3_600_000,
    ...overrides,
  };
}

function setup() {
  const store = new MemoryLedgerStore();
  const core = new SendLedgerCore(store);
  return { store, core };
}

describe("createDraft", () => {
  it("stores a ready draft, audits it and enforces the open-draft cap", () => {
    const { store, core } = setup();
    expect(core.createDraft(newDraft("d1"), CAPS).ok).toBe(true);
    expect(core.createDraft(newDraft("d2"), CAPS).ok).toBe(true);
    const third = core.createDraft(newDraft("d3"), CAPS);
    expect(third).toMatchObject({ ok: false, code: "too_many_drafts" });
    expect(store.audit.filter((entry) => entry.event === "draft_created")).toHaveLength(2);
    const view = core.getDraft("bearer", "d1");
    expect(view?.status).toBe("ready");
    expect(view?.subject).toBe("Pranzo");
  });

  it("binds drafts to their principal and hides discarded ones", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    expect(core.getDraft("oauth:other", "d1")).toBeNull();
    expect(core.listDrafts("oauth:other")).toEqual([]);
    expect(core.listDrafts("bearer")).toHaveLength(1);
    core.discard("d1", { principal: "bearer" }, NOW);
    expect(core.getDraft("bearer", "d1")).toBeNull();
    expect(store.getDraft("d1")?.status).toBe("discarded");
    expect(store.getDraft("d1")?.rawB64).toBeNull();
  });
});

describe("discard", () => {
  it("refuses the wrong principal, wrong nonce and non-ready drafts", () => {
    const { core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    expect(core.discard("d1", { principal: "oauth:other" }, NOW)).toMatchObject({ ok: false, code: "draft_not_found" });
    expect(core.discard("d1", { nonce: "wrong" }, NOW)).toMatchObject({ ok: false, code: "draft_not_found" });
    expect(core.discard("d1", { principal: "bearer" }, NOW).ok).toBe(true);
    expect(core.discard("d1", { principal: "bearer" }, NOW)).toMatchObject({ ok: false, code: "draft_not_found" });
  });
});

describe("approval send flow", () => {
  it("reserves quota, blocks a second send at once and finalises as sent", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    const begin = core.beginSend("d1", "nonce-d1", NOW, CAPS);
    expect(begin.ok).toBe(true);
    expect(store.getDraft("d1")?.status).toBe("sending");
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 1, recipients: 1 });

    const second = core.beginSend("d1", "nonce-d1", NOW, CAPS);
    expect(second).toMatchObject({ ok: false, code: "send_in_progress" });

    core.finishSend("d1", { status: "sent", smtpCode: "250", durationMs: 120 }, NOW + 500);
    expect(store.getDraft("d1")?.status).toBe("sent");
    expect(store.getDraft("d1")?.rawB64).toBeNull();
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 1, recipients: 1 });
    expect(core.beginSend("d1", "nonce-d1", NOW + 1_000, CAPS)).toMatchObject({ ok: false, code: "already_sent" });
  });

  it("refuses a wrong nonce without touching quota", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    expect(core.beginSend("d1", "wrong", NOW, CAPS)).toMatchObject({ ok: false, code: "invalid_nonce" });
    expect(store.getDraft("d1")?.status).toBe("ready");
    expect(store.getUsage(usageDay(NOW))).toBeNull();
  });

  it("releases quota for retryable and permanent failures, keeps it for unknown", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    core.beginSend("d1", "nonce-d1", NOW, CAPS);
    core.finishSend("d1", { status: "ready", code: "smtp_unavailable", durationMs: 1 }, NOW);
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 0, recipients: 0 });
    expect(store.getDraft("d1")?.status).toBe("ready");
    // The failure rotated the nonce: the stale form cannot retry, the fresh
    // one can.
    const rotated = store.getDraft("d1")!.nonce;
    expect(rotated).not.toBe("nonce-d1");
    expect(core.beginSend("d1", "nonce-d1", NOW + 1, CAPS)).toMatchObject({ ok: false, code: "invalid_nonce" });
    expect(core.beginSend("d1", rotated, NOW + 1, CAPS).ok).toBe(true);
    core.finishSend("d1", { status: "failed", code: "smtp_recipient_rejected", durationMs: 1 }, NOW + 2);
    expect(store.getDraft("d1")?.status).toBe("failed");
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 0, recipients: 0 });

    core.createDraft(newDraft("d2"), CAPS);
    core.beginSend("d2", "nonce-d2", NOW + 3, CAPS);
    core.finishSend("d2", { status: "unknown", code: "send_status_unknown", durationMs: 1 }, NOW + 4);
    expect(store.getDraft("d2")?.status).toBe("unknown");
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 1, recipients: 1 });
    expect(core.beginSend("d2", "nonce-d2", NOW + 5, CAPS)).toMatchObject({ ok: false, code: "send_status_unknown" });
  });

  it("treats a stuck send as unknown instead of ever retrying it", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    core.beginSend("d1", "nonce-d1", NOW, CAPS);
    store.updateDraft("d1", { updatedAt: NOW - SENDING_STUCK_MS - 1 });
    expect(core.beginSend("d1", "nonce-d1", NOW, CAPS)).toMatchObject({ ok: false, code: "send_status_unknown" });
    expect(store.getDraft("d1")?.status).toBe("unknown");
    expect(store.audit.some((entry) => entry.event === "unknown" && entry.smtpCode === "stuck_sending")).toBe(true);
  });

  it("enforces the per-day message and recipient caps, including a zero cap", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1", { recipients: ["a@example.com", "b@example.com"] }), CAPS);
    core.createDraft(newDraft("d2", { recipients: ["c@example.com"] }), CAPS);
    expect(core.beginSend("d1", "nonce-d1", NOW, CAPS).ok).toBe(true);
    core.finishSend("d1", { status: "sent", smtpCode: "250", durationMs: 1 }, NOW);
    expect(core.beginSend("d2", "nonce-d2", NOW, CAPS).ok).toBe(true);
    core.finishSend("d2", { status: "sent", smtpCode: "250", durationMs: 1 }, NOW);
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 2, recipients: 3 });

    core.createDraft(newDraft("d3"), CAPS);
    expect(core.beginSend("d3", "nonce-d3", NOW, { ...CAPS, maxPerDay: 2 })).toMatchObject({
      ok: false,
      code: "daily_limit_reached",
    });
    expect(core.beginSend("d3", "nonce-d3", NOW, { ...CAPS, maxPerDay: 0 })).toMatchObject({
      ok: false,
      code: "daily_limit_reached",
    });
    expect(core.beginSend("d3", "nonce-d3", NOW, { ...CAPS, maxRcptsPerDay: 3 })).toMatchObject({
      ok: false,
      code: "daily_limit_reached",
    });
    // Every refusal left the draft ready and the counters untouched.
    expect(store.getDraft("d3")?.status).toBe("ready");
    expect(store.getUsage(usageDay(NOW))).toEqual({ messages: 2, recipients: 3 });
  });

  it("keys quota by UTC day", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    core.beginSend("d1", "nonce-d1", NOW, CAPS);
    const nextDay = NOW + 86_400_000;
    expect(usageDay(NOW)).not.toBe(usageDay(nextDay));
    expect(store.getUsage(usageDay(nextDay))).toBeNull();
    core.createDraft(newDraft("d2", { createdAt: nextDay, expiresAt: nextDay + 3_600_000 }), CAPS);
    expect(core.beginSend("d2", "nonce-d2", nextDay, CAPS).ok).toBe(true);
    expect(store.getUsage(usageDay(nextDay))).toEqual({ messages: 1, recipients: 1 });
  });

  it("refuses expired drafts", () => {
    const { core } = setup();
    core.createDraft(newDraft("d1", { expiresAt: NOW - 1 }), CAPS);
    expect(core.beginSend("d1", "nonce-d1", NOW, CAPS)).toMatchObject({ ok: false, code: "draft_expired" });
  });
});

describe("save flow", () => {
  it("moves the draft through saving to saved and closes approval", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    const begin = core.beginSave("d1", { principal: "bearer" }, NOW);
    expect(begin.ok).toBe(true);
    if (begin.ok) expect(new TextDecoder().decode(begin.value.raw)).toContain("Subject: x");
    expect(store.getDraft("d1")?.status).toBe("saving");
    expect(core.beginSend("d1", "nonce-d1", NOW, CAPS)).toMatchObject({ ok: false, code: "draft_not_ready" });
    core.finishSave("d1", true, NOW + 1);
    expect(store.getDraft("d1")?.status).toBe("saved");
    expect(store.getDraft("d1")?.rawB64).toBeNull();
    expect(core.beginSend("d1", "nonce-d1", NOW + 2, CAPS)).toMatchObject({ ok: false, code: "already_saved" });
    expect(core.beginSave("d1", { principal: "bearer" }, NOW + 2)).toMatchObject({ ok: false, code: "already_saved" });
  });

  it("reverts to ready with a fresh nonce when the append fails and refuses other principals", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    expect(core.beginSave("d1", { principal: "oauth:other" }, NOW)).toMatchObject({ ok: false, code: "draft_not_found" });
    expect(core.beginSave("d1", { principal: "bearer" }, NOW).ok).toBe(true);
    core.finishSave("d1", false, NOW + 1);
    expect(store.getDraft("d1")?.status).toBe("ready");
    const rotated = store.getDraft("d1")!.nonce;
    expect(rotated).not.toBe("nonce-d1");
    expect(core.beginSend("d1", "nonce-d1", NOW + 2, CAPS)).toMatchObject({ ok: false, code: "invalid_nonce" });
    expect(core.beginSend("d1", rotated, NOW + 2, CAPS).ok).toBe(true);
  });
});

describe("sweep", () => {
  it("deletes expired drafts, audits them and prunes old audit rows", () => {
    const { store, core } = setup();
    core.createDraft(newDraft("d1", { expiresAt: NOW - 10 }), CAPS);
    core.createDraft(newDraft("d2"), CAPS);
    store.audit.push({
      ts: NOW - 100 * 86_400_000,
      event: "draft_created",
      draftId: "old",
      principal: "bearer",
      rcptCount: null,
      rcptDomains: null,
      bytes: null,
      smtpCode: null,
      durationMs: null,
    });
    const swept = core.sweep(NOW);
    expect(swept).toBe(1);
    expect(store.getDraft("d1")).toBeNull();
    expect(store.getDraft("d2")).not.toBeNull();
    expect(store.audit.some((entry) => entry.event === "expired" && entry.draftId === "d1")).toBe(true);
    expect(store.audit.some((entry) => entry.draftId === "old")).toBe(false);
  });
});

describe("views", () => {
  it("never expose raw bytes or the nonce", () => {
    const { core } = setup();
    core.createDraft(newDraft("d1"), CAPS);
    const view = core.getDraft("bearer", "d1")!;
    expect(Object.keys(view)).not.toContain("rawB64");
    expect(Object.keys(view)).not.toContain("nonce");
    expect(view.recipientCount).toBe(1);
    const row: DraftRow = {
      ...newDraft("d2"),
      status: "ready",
      updatedAt: NOW,
      usageDay: null,
      usageMsgs: 0,
      usageRcpts: 0,
      savedAt: null,
    };
    expect(viewOf(row).to).toEqual(["a@example.com"]);
  });
});
