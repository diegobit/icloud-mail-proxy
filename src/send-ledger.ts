// The SendLedger Durable Object (plans/email-send.md, steps 4 and 8).
//
// One instance per deployment holds drafts, the UTC quota counters and the
// audit trail in SQLite storage, and it is the only place that talks to SMTP
// or performs the IMAP APPEND for a draft. Every state transition is
// committed synchronously before the network awaits, so a double submit can
// never send twice: the second call sees `sending`.
//
// Only the DO's `alarm` and its exported RPC methods are reachable; the store
// and the state machine live in send-ledger-core.ts, which is Node-testable.

import { DurableObject } from "cloudflare:workers";
import { ImapError, ImapSession } from "./imap";
import {
  base64ToBytes,
  bytesToBase64,
  SendLedgerCore,
  type AuditEntry,
  type DraftMeta,
  type DraftRow,
  type DraftStatus,
  type DraftView,
  type LedgerStore,
} from "./send-ledger-core";
import { readSendConfig } from "./send-policy";
import { resolveSmtpTarget, SmtpError, sendMail } from "./smtp";
import { cloudflareSocketFactory } from "./smtp-socket";
import type { Env } from "./types";

export const DRAFTS_MAILBOX = "Drafts";
export const SENT_MAILBOX = "Sent Messages";

/** SMTP failures that leave nothing delivered and may be retried by hand. */
const RETRYABLE_SMTP_CODES = new Set(["smtp_unavailable", "smtp_auth_failed", "smtp_tls_failed", "smtp_protocol"]);

export interface NewDraftInput {
  id: string;
  principal: string;
  rawB64: string;
  envelopeFrom: string;
  recipients: string[];
  meta: DraftMeta;
  nonce: string;
  ttlSeconds: number;
}

export interface LedgerAuth {
  principal?: string;
  nonce?: string;
}

export type CreateResult = { ok: true; value: DraftView } | { ok: false; code: string; message: string };
export type SimpleResult = { ok: true; value: true } | { ok: false; code: string; message: string };

export interface SendReport {
  status: "sent" | "ready" | "failed" | "unknown" | "error";
  code?: string;
  message?: string;
  replyCode?: number;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS drafts (
     id TEXT PRIMARY KEY,
     principal TEXT NOT NULL,
     status TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     raw_b64 TEXT,
     envelope_from TEXT NOT NULL,
     rcpt_json TEXT NOT NULL,
     meta_json TEXT NOT NULL,
     nonce TEXT NOT NULL,
     usage_day TEXT,
     usage_msgs INTEGER NOT NULL DEFAULT 0,
     usage_rcpts INTEGER NOT NULL DEFAULT 0,
     saved_at INTEGER
   )`,
  `CREATE TABLE IF NOT EXISTS usage (
     day TEXT PRIMARY KEY,
     messages INTEGER NOT NULL,
     recipients INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS audit (
     ts INTEGER NOT NULL,
     event TEXT NOT NULL,
     draft_id TEXT,
     principal TEXT,
     rcpt_count INTEGER,
     rcpt_domains_json TEXT,
     bytes INTEGER,
     smtp_code TEXT,
     duration_ms INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts)`,
];

type SqlRow = Record<string, SqlStorageValue>;

function rowFromSql(row: SqlRow): DraftRow {
  return {
    id: String(row.id),
    principal: String(row.principal),
    status: String(row.status) as DraftStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    expiresAt: Number(row.expires_at),
    rawB64: row.raw_b64 === null || row.raw_b64 === undefined ? null : String(row.raw_b64),
    envelopeFrom: String(row.envelope_from),
    recipients: JSON.parse(String(row.rcpt_json)) as string[],
    meta: JSON.parse(String(row.meta_json)) as DraftMeta,
    nonce: String(row.nonce),
    usageDay: row.usage_day === null || row.usage_day === undefined ? null : String(row.usage_day),
    usageMsgs: Number(row.usage_msgs ?? 0),
    usageRcpts: Number(row.usage_rcpts ?? 0),
    savedAt: row.saved_at === null || row.saved_at === undefined ? null : Number(row.saved_at),
  };
}

/** LedgerStore over the DO's SQLite storage; every call is synchronous. */
class SqliteLedgerStore implements LedgerStore {
  constructor(private readonly sql: SqlStorage) {}

  private rows(query: string, ...bindings: SqlStorageValue[]): SqlRow[] {
    return this.sql.exec(query, ...bindings).toArray() as SqlRow[];
  }

  getDraft(id: string): DraftRow | null {
    const row = this.rows("SELECT * FROM drafts WHERE id = ?", id)[0];
    return row ? rowFromSql(row) : null;
  }

  insertDraft(row: DraftRow): void {
    this.sql.exec(
      `INSERT INTO drafts (id, principal, status, created_at, updated_at, expires_at, raw_b64, envelope_from,
         rcpt_json, meta_json, nonce, usage_day, usage_msgs, usage_rcpts, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.principal,
      row.status,
      row.createdAt,
      row.updatedAt,
      row.expiresAt,
      row.rawB64,
      row.envelopeFrom,
      JSON.stringify(row.recipients),
      JSON.stringify(row.meta),
      row.nonce,
      row.usageDay,
      row.usageMsgs,
      row.usageRcpts,
      row.savedAt,
    );
  }

  updateDraft(id: string, patch: Partial<DraftRow>): void {
    const columns: Array<[keyof DraftRow, string, (value: unknown) => SqlStorageValue]> = [
      ["status", "status", (v) => String(v)],
      ["updatedAt", "updated_at", (v) => Number(v)],
      ["expiresAt", "expires_at", (v) => Number(v)],
      ["rawB64", "raw_b64", (v) => (v === null ? null : String(v))],
      ["envelopeFrom", "envelope_from", (v) => String(v)],
      ["recipients", "rcpt_json", (v) => JSON.stringify(v)],
      ["meta", "meta_json", (v) => JSON.stringify(v)],
      ["nonce", "nonce", (v) => String(v)],
      ["usageDay", "usage_day", (v) => (v === null ? null : String(v))],
      ["usageMsgs", "usage_msgs", (v) => Number(v)],
      ["usageRcpts", "usage_rcpts", (v) => Number(v)],
      ["savedAt", "saved_at", (v) => (v === null ? null : Number(v))],
    ];
    const sets: string[] = [];
    const values: SqlStorageValue[] = [];
    for (const [key, column, serialize] of columns) {
      if (!(key in patch)) continue;
      sets.push(`${column} = ?`);
      values.push(serialize(patch[key]));
    }
    if (sets.length === 0) return;
    values.push(id);
    this.sql.exec(`UPDATE drafts SET ${sets.join(", ")} WHERE id = ?`, ...values);
  }

  deleteDraft(id: string): void {
    this.sql.exec("DELETE FROM drafts WHERE id = ?", id);
  }

  listDrafts(principal: string): DraftRow[] {
    return this.rows("SELECT * FROM drafts WHERE principal = ? ORDER BY created_at DESC", principal).map(rowFromSql);
  }

  countReadyDrafts(principal: string): number {
    const row = this.rows(
      "SELECT COUNT(*) AS n FROM drafts WHERE principal = ? AND status = 'ready'",
      principal,
    )[0];
    return row ? Number(row.n) : 0;
  }

  getUsage(day: string): { messages: number; recipients: number } | null {
    const row = this.rows("SELECT messages, recipients FROM usage WHERE day = ?", day)[0];
    if (!row) return null;
    return { messages: Number(row.messages), recipients: Number(row.recipients) };
  }

  setUsage(day: string, messages: number, recipients: number): void {
    this.sql.exec(
      `INSERT INTO usage (day, messages, recipients) VALUES (?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET messages = excluded.messages, recipients = excluded.recipients`,
      day,
      messages,
      recipients,
    );
  }

  addAudit(entry: AuditEntry): void {
    this.sql.exec(
      "INSERT INTO audit (ts, event, draft_id, principal, rcpt_count, rcpt_domains_json, bytes, smtp_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      entry.ts,
      entry.event,
      entry.draftId,
      entry.principal,
      entry.rcptCount,
      entry.rcptDomains === null ? null : JSON.stringify(entry.rcptDomains),
      entry.bytes,
      entry.smtpCode,
      entry.durationMs,
    );
  }

  listExpiredDrafts(now: number, limit: number): string[] {
    return this.rows("SELECT id FROM drafts WHERE expires_at < ? LIMIT ?", now, limit).map((row) => String(row.id));
  }

  minExpiresAt(): number | null {
    const row = this.rows("SELECT MIN(expires_at) AS m FROM drafts")[0];
    if (!row || row.m === null || row.m === undefined) return null;
    return Number(row.m);
  }

  pruneAudit(before: number): void {
    this.sql.exec("DELETE FROM audit WHERE ts < ?", before);
  }
}

export class SendLedger extends DurableObject<Env> {
  private readonly store: SqliteLedgerStore;
  private readonly core: SendLedgerCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
    this.store = new SqliteLedgerStore(ctx.storage.sql);
    this.core = new SendLedgerCore(this.store, (entry) => {
      // Metadata only: never the subject, the body or address local parts.
      console.log("send_event", JSON.stringify(entry));
    });
  }

  async createDraft(input: NewDraftInput): Promise<CreateResult> {
    const config = readSendConfig(this.env);
    if (!config.ok) return { ok: false, code: "send_not_configured", message: config.error };
    const now = Date.now();
    const ttlSeconds = Math.max(1, Math.floor(input.ttlSeconds));
    const result = this.core.createDraft(
      {
        id: input.id,
        principal: input.principal,
        rawB64: input.rawB64,
        envelopeFrom: input.envelopeFrom,
        recipients: input.recipients,
        meta: input.meta,
        nonce: input.nonce,
        createdAt: now,
        expiresAt: now + ttlSeconds * 1000,
      },
      config.config.caps,
    );
    if (!result.ok) return result;
    const next = this.store.minExpiresAt();
    if (next !== null) this.ctx.storage.setAlarm(next + 60_000);
    return result;
  }

  async listDrafts(principal: string): Promise<DraftView[]> {
    return this.core.listDrafts(principal);
  }

  async getDraft(principal: string, id: string): Promise<DraftView | null> {
    return this.core.getDraft(principal, id);
  }

  /** The approval page's view: no principal binding, but the form nonce. */
  async getDraftForApproval(id: string): Promise<{ view: DraftView; nonce: string } | null> {
    return this.core.getDraftForApproval(id);
  }

  async discardDraft(id: string, auth: LedgerAuth): Promise<SimpleResult> {
    const result = this.core.discard(id, auth, Date.now());
    if (!result.ok) return result;
    return { ok: true, value: true };
  }

  /**
   * Save a draft into iCloud's Drafts mailbox. The draft moves to `saving`
   * first, so it cannot be approved and sent while the APPEND is in flight;
   * a failure puts it back to `ready`.
   */
  async saveDraft(id: string, auth: LedgerAuth): Promise<SimpleResult> {
    const begin = this.core.beginSave(id, auth, Date.now());
    if (!begin.ok) return { ok: false, code: begin.code, message: begin.message };
    try {
      await this.appendToMailbox(DRAFTS_MAILBOX, ["\\Draft"], begin.value.raw);
      this.core.finishSave(id, true, Date.now());
      return { ok: true, value: true };
    } catch (error) {
      this.core.finishSave(id, false, Date.now());
      return {
        ok: false,
        code: error instanceof ImapError ? `imap_${error.code.toLowerCase()}` : "imap_error",
        message: error instanceof Error ? error.message : "append failed",
      };
    }
  }

  /**
   * The only path that can send: reserve quota, flip to `sending`, run SMTP,
   * finalise. Called by the approval page after the owner signed in and the
   * one-time nonce was checked.
   */
  async approveSend(id: string, nonce: string): Promise<SendReport> {
    const config = readSendConfig(this.env);
    if (!config.ok) return { status: "error", code: "send_not_configured", message: config.error };
    const begin = this.core.beginSend(id, nonce, Date.now(), config.config.caps);
    if (!begin.ok) return { status: "error", code: begin.code, message: begin.message };

    const row = begin.value;
    const started = Date.now();
    if (row.rawB64 === null) {
      this.core.finishSend(id, { status: "failed", code: "draft_not_ready", durationMs: 0 }, Date.now());
      return { status: "error", code: "draft_not_ready", message: "draft has no body" };
    }
    const raw = base64ToBytes(row.rawB64);

    try {
      const result = await sendMail({
        target: resolveSmtpTarget(this.env),
        user: this.env.ICLOUD_USER,
        appPassword: this.env.ICLOUD_APP_PASSWORD,
        envelopeFrom: row.envelopeFrom,
        recipients: row.recipients,
        raw,
        connectSocket: cloudflareSocketFactory,
      });
      this.core.finishSend(
        id,
        { status: "sent", smtpCode: String(result.replyCode), durationMs: Date.now() - started },
        Date.now(),
      );
      if (config.config.sentCopy) {
        try {
          await this.appendToMailbox(SENT_MAILBOX, ["\\Seen"], raw);
        } catch (error) {
          console.log(
            "send_event",
            JSON.stringify({
              event: "sent_copy_failed",
              draftId: id,
              error: error instanceof ImapError ? error.code : "unknown",
            }),
          );
        }
      }
      return { status: "sent", replyCode: result.replyCode };
    } catch (error) {
      const code = error instanceof SmtpError ? error.code : "internal_error";
      const status =
        error instanceof SmtpError
          ? code === "send_status_unknown"
            ? "unknown"
            : RETRYABLE_SMTP_CODES.has(code)
              ? "ready"
              : "failed"
          : "unknown";
      this.core.finishSend(id, { status, code, durationMs: Date.now() - started }, Date.now());
      return { status, code, message: error instanceof Error ? error.message : "send failed" };
    }
  }

  async alarm(): Promise<void> {
    this.core.sweep(Date.now());
    const next = this.store.minExpiresAt();
    if (next !== null) this.ctx.storage.setAlarm(next + 60_000);
  }

  private async appendToMailbox(mailbox: string, flags: string[], raw: Uint8Array): Promise<void> {
    const session = await ImapSession.open(this.env.ICLOUD_USER, this.env.ICLOUD_APP_PASSWORD);
    try {
      await session.append(mailbox, flags, raw);
    } finally {
      await session.logout();
    }
  }
}
