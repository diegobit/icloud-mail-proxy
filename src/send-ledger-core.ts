// Draft/quota state machine for outgoing mail (plans/email-send.md, step 4).
//
// Pure and Node-testable: the store is an injected synchronous interface —
// the SendLedger Durable Object backs it with SQLite, tests with a Map. Every
// transition is synchronous, so the DO commits the state change before it
// ever awaits SMTP: a concurrent approval sees `sending`, not a second send.

import type { SendCaps } from "./send-policy";

export type DraftStatus =
  | "ready"
  | "saving"
  | "sending"
  | "sent"
  | "failed"
  | "unknown"
  | "saved"
  | "discarded";

export interface DraftMeta {
  fromName: string | null;
  fromAddr: string;
  toDisplay: string[];
  ccDisplay: string[];
  bccDisplay: string[];
  subject: string;
  dateIso: string;
  messageId: string;
  inReplyTo: string | null;
  text: string;
  textBytes: number;
}

export interface DraftRow {
  id: string;
  principal: string;
  status: DraftStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  rawB64: string | null;
  envelopeFrom: string;
  recipients: string[];
  meta: DraftMeta;
  nonce: string;
  usageDay: string | null;
  usageMsgs: number;
  usageRcpts: number;
  savedAt: number | null;
}

export interface NewDraft {
  id: string;
  principal: string;
  rawB64: string;
  envelopeFrom: string;
  recipients: string[];
  meta: DraftMeta;
  nonce: string;
  createdAt: number;
  expiresAt: number;
}

/** What tools and the approval page may see: never the raw bytes or nonce. */
export interface DraftView {
  id: string;
  status: DraftStatus;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  from: { name: string | null; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  dateIso: string;
  messageId: string;
  text: string;
  textBytes: number;
  recipientCount: number;
}

export interface AuditEntry {
  ts: number;
  event: string;
  draftId: string | null;
  principal: string | null;
  rcptCount: number | null;
  rcptDomains: string[] | null;
  bytes: number | null;
  smtpCode: string | null;
  durationMs: number | null;
}

export interface LedgerStore {
  getDraft(id: string): DraftRow | null;
  insertDraft(row: DraftRow): void;
  updateDraft(id: string, patch: Partial<DraftRow>): void;
  deleteDraft(id: string): void;
  listDrafts(principal: string): DraftRow[];
  countReadyDrafts(principal: string): number;
  getUsage(day: string): { messages: number; recipients: number } | null;
  setUsage(day: string, messages: number, recipients: number): void;
  addAudit(entry: AuditEntry): void;
  listExpiredDrafts(now: number, limit: number): string[];
  /** The earliest expiry still stored, for re-arming the sweep alarm. */
  minExpiresAt(): number | null;
  pruneAudit(before: number): void;
}

export type LedgerErrorCode =
  | "draft_not_found"
  | "draft_expired"
  | "already_sent"
  | "already_saved"
  | "send_in_progress"
  | "send_status_unknown"
  | "draft_not_ready"
  | "invalid_nonce"
  | "daily_limit_reached"
  | "too_many_drafts";

export type LedgerResult<T> = { ok: true; value: T } | { ok: false; code: LedgerErrorCode; message: string };

/** A `sending` draft older than this is treated as `unknown`, never retried. */
export const SENDING_STUCK_MS = 5 * 60_000;

export function usageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function viewOf(row: DraftRow): DraftView {
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    from: { name: row.meta.fromName, address: row.meta.fromAddr },
    to: row.meta.toDisplay,
    cc: row.meta.ccDisplay,
    bcc: row.meta.bccDisplay,
    subject: row.meta.subject,
    dateIso: row.meta.dateIso,
    messageId: row.meta.messageId,
    text: row.meta.text,
    textBytes: row.meta.textBytes,
    recipientCount: row.recipients.length,
  };
}

function recipientDomains(row: DraftRow): string[] {
  const domains = new Set<string>();
  for (const address of row.recipients) {
    const at = address.lastIndexOf("@");
    if (at > 0) domains.add(address.slice(at + 1).toLowerCase());
  }
  return [...domains];
}

/** How a send ended; `ready` failures released their quota, `unknown` kept it. */
export type SendOutcome =
  | { status: "sent"; smtpCode: string; durationMs: number }
  | { status: "ready" | "failed" | "unknown"; code: string; durationMs: number };

export class SendLedgerCore {
  constructor(
    private readonly store: LedgerStore,
    private readonly log: (entry: AuditEntry) => void = () => {},
  ) {}

  private audit(entry: Omit<AuditEntry, "ts"> & { ts?: number }): void {
    const full: AuditEntry = { ts: Date.now(), ...entry } as AuditEntry;
    this.store.addAudit(full);
    this.log(full);
  }

  createDraft(input: NewDraft, caps: SendCaps): LedgerResult<DraftView> {
    if (this.store.countReadyDrafts(input.principal) >= caps.maxOpenDrafts) {
      return { ok: false, code: "too_many_drafts", message: `too many open drafts (limit ${caps.maxOpenDrafts})` };
    }
    const row: DraftRow = {
      id: input.id,
      principal: input.principal,
      status: "ready",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      expiresAt: input.expiresAt,
      rawB64: input.rawB64,
      envelopeFrom: input.envelopeFrom,
      recipients: input.recipients,
      meta: input.meta,
      nonce: input.nonce,
      usageDay: null,
      usageMsgs: 0,
      usageRcpts: 0,
      savedAt: null,
    };
    this.store.insertDraft(row);
    this.audit({
      event: "draft_created",
      draftId: row.id,
      principal: row.principal,
      rcptCount: row.recipients.length,
      rcptDomains: recipientDomains(row),
      bytes: input.rawB64.length,
      smtpCode: null,
      durationMs: null,
    });
    return { ok: true, value: viewOf(row) };
  }

  getDraft(principal: string, id: string): DraftView | null {
    const row = this.store.getDraft(id);
    if (!row || row.principal !== principal || row.status === "discarded") return null;
    return viewOf(row);
  }

  listDrafts(principal: string): DraftView[] {
    return this.store
      .listDrafts(principal)
      .filter((row) => row.status !== "discarded")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(viewOf);
  }

  /** The approval page's view: no principal check, but the nonce for the form. */
  getDraftForApproval(id: string): { view: DraftView; nonce: string } | null {
    const row = this.store.getDraft(id);
    if (!row || row.status === "discarded") return null;
    return { view: viewOf(row), nonce: row.nonce };
  }

  discard(
    id: string,
    auth: { principal?: string; nonce?: string },
    now: number,
  ): LedgerResult<true> {
    const row = this.store.getDraft(id);
    if (!row || row.status === "discarded") {
      return { ok: false, code: "draft_not_found", message: "no such draft" };
    }
    const authorized = this.authorize(row, auth);
    if (!authorized) return { ok: false, code: "draft_not_found", message: "no such draft" };
    if (row.status !== "ready") {
      return { ok: false, code: "draft_not_ready", message: `draft is ${row.status}` };
    }
    this.store.updateDraft(id, { status: "discarded", updatedAt: now, rawB64: null });
    this.audit({
      event: "discarded",
      draftId: id,
      principal: row.principal,
      rcptCount: row.recipients.length,
      rcptDomains: recipientDomains(row),
      bytes: null,
      smtpCode: null,
      durationMs: null,
    });
    return { ok: true, value: true };
  }

  /**
   * Move a draft to `saving` and hand out its bytes for the IMAP APPEND. The
   * state change is what stops an approval from sending a draft that is
   * already on its way to the iCloud Drafts mailbox.
   */
  beginSave(
    id: string,
    auth: { principal?: string; nonce?: string },
    now: number,
  ): LedgerResult<{ raw: Uint8Array; row: DraftRow }> {
    const row = this.store.getDraft(id);
    if (!row || row.status === "discarded") {
      return { ok: false, code: "draft_not_found", message: "no such draft" };
    }
    if (!this.authorize(row, auth)) return { ok: false, code: "draft_not_found", message: "no such draft" };
    if (row.status === "saved") {
      return { ok: false, code: "already_saved", message: "draft is already in the Drafts mailbox" };
    }
    if (row.status !== "ready") {
      return { ok: false, code: "draft_not_ready", message: `draft is ${row.status}` };
    }
    if (now >= row.expiresAt) return { ok: false, code: "draft_expired", message: "draft expired" };
    if (row.rawB64 === null) return { ok: false, code: "draft_not_ready", message: "draft has no body" };
    this.store.updateDraft(id, { status: "saving", updatedAt: now });
    return { ok: true, value: { raw: base64ToBytes(row.rawB64), row } };
  }

  finishSave(id: string, ok: boolean, now: number): void {
    const row = this.store.getDraft(id);
    if (!row || row.status !== "saving") return;
    if (ok) {
      this.store.updateDraft(id, { status: "saved", updatedAt: now, rawB64: null, savedAt: now });
      this.audit({
        event: "saved_to_drafts",
        draftId: id,
        principal: row.principal,
        rcptCount: row.recipients.length,
        rcptDomains: recipientDomains(row),
        bytes: null,
        smtpCode: null,
        durationMs: null,
      });
      return;
    }
    this.store.updateDraft(id, { status: "ready", updatedAt: now });
  }

  /**
   * Reserve quota and move the draft to `sending`, all synchronously. The
   * caller then runs SMTP and calls finishSend; a second concurrent approval
   * sees `sending` (or, after five stuck minutes, `unknown`).
   */
  beginSend(id: string, nonce: string, now: number, caps: SendCaps): LedgerResult<DraftRow> {
    const row = this.store.getDraft(id);
    if (!row || row.status === "discarded") {
      return { ok: false, code: "draft_not_found", message: "no such draft" };
    }
    if (row.status === "sent") return { ok: false, code: "already_sent", message: "draft was already sent" };
    if (row.status === "saved") {
      return { ok: false, code: "already_saved", message: "draft is in the Drafts mailbox; approval is closed" };
    }
    if (row.status === "unknown") {
      return { ok: false, code: "send_status_unknown", message: "the previous attempt ended in an unknown state" };
    }
    if (row.status === "sending") {
      if (now - row.updatedAt > SENDING_STUCK_MS) {
        this.store.updateDraft(id, { status: "unknown", updatedAt: now });
        this.audit({
          event: "unknown",
          draftId: id,
          principal: row.principal,
          rcptCount: row.recipients.length,
          rcptDomains: recipientDomains(row),
          bytes: null,
          smtpCode: "stuck_sending",
          durationMs: null,
        });
        return { ok: false, code: "send_status_unknown", message: "the previous attempt ended in an unknown state" };
      }
      return { ok: false, code: "send_in_progress", message: "a send is already in progress" };
    }
    if (row.status !== "ready") {
      return { ok: false, code: "draft_not_ready", message: `draft is ${row.status}` };
    }
    if (now >= row.expiresAt) return { ok: false, code: "draft_expired", message: "draft expired" };
    if (row.nonce !== nonce) return { ok: false, code: "invalid_nonce", message: "invalid approval nonce" };
    if (row.rawB64 === null) return { ok: false, code: "draft_not_ready", message: "draft has no body" };

    const day = usageDay(now);
    const usage = this.store.getUsage(day) ?? { messages: 0, recipients: 0 };
    if (caps.maxPerDay === 0 || usage.messages + 1 > caps.maxPerDay) {
      return { ok: false, code: "daily_limit_reached", message: `daily send limit reached (${caps.maxPerDay}/day)` };
    }
    if (caps.maxRcptsPerDay === 0 || usage.recipients + row.recipients.length > caps.maxRcptsPerDay) {
      return {
        ok: false,
        code: "daily_limit_reached",
        message: `daily recipient limit reached (${caps.maxRcptsPerDay}/day)`,
      };
    }
    this.store.setUsage(day, usage.messages + 1, usage.recipients + row.recipients.length);
    this.store.updateDraft(id, {
      status: "sending",
      updatedAt: now,
      usageDay: day,
      usageMsgs: 1,
      usageRcpts: row.recipients.length,
    });
    this.audit({
      event: "send_started",
      draftId: id,
      principal: row.principal,
      rcptCount: row.recipients.length,
      rcptDomains: recipientDomains(row),
      bytes: null,
      smtpCode: null,
      durationMs: null,
    });
    return { ok: true, value: this.store.getDraft(id) ?? row };
  }

  finishSend(id: string, outcome: SendOutcome, now: number): void {
    const row = this.store.getDraft(id);
    if (!row || row.status !== "sending") return;
    if (outcome.status !== "sent" && outcome.status !== "unknown") {
      this.releaseQuota(row);
    }
    // A retryable failure goes back to `ready` with its bytes intact; the
    // terminal outcomes drop the message body.
    const patch: Partial<DraftRow> =
      outcome.status === "ready"
        ? { status: "ready", updatedAt: now }
        : { status: outcome.status, updatedAt: now, rawB64: null };
    this.store.updateDraft(id, patch);
    this.audit({
      event: outcome.status,
      draftId: id,
      principal: row.principal,
      rcptCount: row.recipients.length,
      rcptDomains: recipientDomains(row),
      bytes: null,
      smtpCode: outcome.status === "sent" ? outcome.smtpCode : outcome.code,
      durationMs: outcome.durationMs,
    });
  }

  /** Delete expired drafts and old audit rows. Returns the number swept. */
  sweep(now: number): number {
    const expired = this.store.listExpiredDrafts(now, 200);
    for (const id of expired) {
      const row = this.store.getDraft(id);
      this.store.deleteDraft(id);
      if (!row) continue;
      this.audit({
        event: "expired",
        draftId: id,
        principal: row.principal,
        rcptCount: row.recipients.length,
        rcptDomains: recipientDomains(row),
        bytes: null,
        smtpCode: null,
        durationMs: null,
      });
    }
    this.store.pruneAudit(now - 90 * 86_400_000);
    return expired.length;
  }

  private releaseQuota(row: DraftRow): void {
    if (row.usageDay === null || row.usageMsgs === 0) return;
    const usage = this.store.getUsage(row.usageDay);
    if (!usage) return;
    this.store.setUsage(
      row.usageDay,
      Math.max(0, usage.messages - row.usageMsgs),
      Math.max(0, usage.recipients - row.usageRcpts),
    );
  }

  private authorize(row: DraftRow, auth: { principal?: string; nonce?: string }): boolean {
    if (typeof auth.principal === "string" && row.principal === auth.principal) return true;
    if (typeof auth.nonce === "string" && row.nonce === auth.nonce && auth.nonce !== "") return true;
    return false;
  }
}

/** base64 (standard) to bytes, as stored by the ledger. */
export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
