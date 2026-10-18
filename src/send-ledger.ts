// The SendLedger Durable Object (plans/email-send.md, "Owner revision").
//
// One instance per deployment holds the UTC quota counters, the
// duplicate-send window and the audit trail in SQLite storage, and it is the
// only place that talks to SMTP or performs the IMAP APPEND for a draft. The
// reservation is committed synchronously before the network await, so two
// concurrent attempts cannot both consume the same quota.
//
// The earlier design kept drafts and an approval state machine here; the
// owner's revision removed both, and the leftover `drafts` table is dropped
// on first start.

import { DurableObject } from "cloudflare:workers";
import { ImapError, ImapSession } from "./imap";
import {
  base64ToBytes,
  SendLedgerCore,
  type AuditEntry,
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

export interface DirectSendInput {
  rawB64: string;
  recipients: string[];
  hash: string;
  allowDuplicate: boolean;
  principal: string | null;
}

export interface DirectSendReport {
  status: "sent" | "failed" | "unknown" | "refused";
  code?: string;
  message?: string;
  replyCode?: number;
  retryable?: boolean;
  durationMs?: number;
}

export interface SaveDraftInput {
  rawB64: string;
  recipientCount: number;
  principal: string | null;
}

export interface SaveDraftReport {
  status: "saved" | "failed";
  code?: string;
  message?: string;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS usage (
     day TEXT PRIMARY KEY,
     messages INTEGER NOT NULL,
     recipients INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS audit (
     ts INTEGER NOT NULL,
     event TEXT NOT NULL,
     principal TEXT,
     rcpt_count INTEGER,
     rcpt_domains_json TEXT,
     bytes INTEGER,
     smtp_code TEXT,
     duration_ms INTEGER
   )`,
  `CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts)`,
  `CREATE TABLE IF NOT EXISTS recent_sends (
     hash TEXT PRIMARY KEY,
     ts INTEGER NOT NULL
   )`,
  // The revision removed server-side drafts; drop what the old schema left.
  `DROP TABLE IF EXISTS drafts`,
];

type SqlRow = Record<string, SqlStorageValue>;

/** LedgerStore over the DO's SQLite storage; every call is synchronous. */
class SqliteLedgerStore implements LedgerStore {
  constructor(private readonly sql: SqlStorage) {}

  private rows(query: string, ...bindings: SqlStorageValue[]): SqlRow[] {
    return this.sql.exec(query, ...bindings).toArray() as SqlRow[];
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
      "INSERT INTO audit (ts, event, principal, rcpt_count, rcpt_domains_json, bytes, smtp_code, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      entry.ts,
      entry.event,
      entry.principal,
      entry.rcptCount,
      entry.rcptDomains === null ? null : JSON.stringify(entry.rcptDomains),
      entry.bytes,
      entry.smtpCode,
      entry.durationMs,
    );
  }

  pruneAudit(before: number): void {
    this.sql.exec("DELETE FROM audit WHERE ts < ?", before);
  }

  lastSendAt(hash: string): number | null {
    const row = this.rows("SELECT ts FROM recent_sends WHERE hash = ?", hash)[0];
    return row ? Number(row.ts) : null;
  }

  recordSend(hash: string, ts: number): void {
    this.sql.exec(
      `INSERT INTO recent_sends (hash, ts) VALUES (?, ?)
       ON CONFLICT(hash) DO UPDATE SET ts = excluded.ts`,
      hash,
      ts,
    );
  }

  forgetSend(hash: string): void {
    this.sql.exec("DELETE FROM recent_sends WHERE hash = ?", hash);
  }

  pruneSends(before: number): void {
    this.sql.exec("DELETE FROM recent_sends WHERE ts < ?", before);
  }
}

export class SendLedger extends DurableObject<Env> {
  private readonly core: SendLedgerCore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    for (const statement of SCHEMA) ctx.storage.sql.exec(statement);
    this.core = new SendLedgerCore(new SqliteLedgerStore(ctx.storage.sql), (entry) => {
      // Metadata only: never the subject, the body or address local parts.
      console.log("send_event", JSON.stringify(entry));
    });
  }

  /**
   * The direct send: claim quota and the duplicate window, submit over SMTP,
   * finalise. A failure before delivery gives the quota and the hash back so
   * the caller can retry; `unknown` keeps both, because the message may
   * already be queued.
   */
  async send(input: DirectSendInput): Promise<DirectSendReport> {
    const config = readSendConfig(this.env);
    if (!config.ok) return { status: "refused", code: "send_not_configured", message: config.error };

    const raw = base64ToBytes(input.rawB64);
    const started = Date.now();
    const begin = this.core.beginSend(started, input.recipients.length, input.hash, input.allowDuplicate, config.config.caps);
    if (!begin.ok) {
      this.core.audit({
        event: "refused",
        principal: input.principal,
        rcptCount: input.recipients.length,
        rcptDomains: domainsOf(input.recipients),
        bytes: raw.byteLength,
        smtpCode: begin.code,
        durationMs: null,
      });
      return { status: "refused", code: begin.code, message: begin.message };
    }
    const { day } = begin.value;
    this.core.audit({
      event: "send_started",
      principal: input.principal,
      rcptCount: input.recipients.length,
      rcptDomains: domainsOf(input.recipients),
      bytes: raw.byteLength,
      smtpCode: null,
      durationMs: null,
    });

    try {
      const result = await sendMail({
        target: resolveSmtpTarget(this.env),
        user: this.env.ICLOUD_USER,
        appPassword: this.env.ICLOUD_APP_PASSWORD,
        envelopeFrom: config.config.from,
        recipients: input.recipients,
        raw,
        connectSocket: cloudflareSocketFactory,
      });
      this.core.keep(input.hash, Date.now());
      this.core.audit({
        event: "sent",
        principal: input.principal,
        rcptCount: input.recipients.length,
        rcptDomains: domainsOf(input.recipients),
        bytes: raw.byteLength,
        smtpCode: String(result.replyCode),
        durationMs: Date.now() - started,
      });
      if (config.config.sentCopy) {
        try {
          await this.appendToMailbox(SENT_MAILBOX, ["\\Seen"], raw);
        } catch (error) {
          console.log(
            "send_event",
            JSON.stringify({
              event: "sent_copy_failed",
              error: error instanceof ImapError ? error.code : "unknown",
            }),
          );
        }
      }
      return { status: "sent", replyCode: result.replyCode, durationMs: Date.now() - started };
    } catch (error) {
      const code = error instanceof SmtpError ? error.code : "internal_error";
      const status = error instanceof SmtpError ? (code === "send_status_unknown" ? "unknown" : "failed") : "unknown";
      const retryable = error instanceof SmtpError && RETRYABLE_SMTP_CODES.has(code);
      if (status === "unknown") {
        // Ambiguous: keep the quota and the hash, never retry automatically.
        this.core.keep(input.hash, Date.now());
      } else {
        this.core.release(day, input.recipients.length, input.hash);
      }
      this.core.audit({
        event: status,
        principal: input.principal,
        rcptCount: input.recipients.length,
        rcptDomains: domainsOf(input.recipients),
        bytes: raw.byteLength,
        smtpCode: code,
        durationMs: Date.now() - started,
      });
      return {
        status,
        code,
        message: error instanceof Error ? error.message : "send failed",
        retryable,
        durationMs: Date.now() - started,
      };
    }
  }

  /** Compose-and-append: the message lands in iCloud's real Drafts folder. */
  async saveDraft(input: SaveDraftInput): Promise<SaveDraftReport> {
    const raw = base64ToBytes(input.rawB64);
    try {
      await this.appendToMailbox(DRAFTS_MAILBOX, ["\\Draft"], raw);
      this.core.audit({
        event: "draft_saved",
        principal: input.principal,
        rcptCount: input.recipientCount,
        rcptDomains: null,
        bytes: raw.byteLength,
        smtpCode: null,
        durationMs: null,
      });
      return { status: "saved" };
    } catch (error) {
      const code = error instanceof ImapError ? `imap_${error.code.toLowerCase()}` : "imap_error";
      this.core.audit({
        event: "draft_save_failed",
        principal: input.principal,
        rcptCount: input.recipientCount,
        rcptDomains: null,
        bytes: raw.byteLength,
        smtpCode: code,
        durationMs: null,
      });
      return { status: "failed", code, message: error instanceof Error ? error.message : "append failed" };
    }
  }

  async alarm(): Promise<void> {
    this.core.sweep(Date.now());
    // Daily maintenance keeps the audit prune running on an idle deployment.
    this.ctx.storage.setAlarm(Date.now() + 86_400_000);
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

function domainsOf(recipients: string[]): string[] {
  const domains = new Set<string>();
  for (const address of recipients) {
    const at = address.lastIndexOf("@");
    if (at > 0) domains.add(address.slice(at + 1).toLowerCase());
  }
  return [...domains];
}
