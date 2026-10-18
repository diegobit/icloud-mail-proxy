// Quota and duplicate protection for outgoing mail (plans/email-send.md,
// "Owner revision": the server keeps no drafts and no approval state).
//
// Pure and Node-testable: the store is an injected synchronous interface —
// the SendLedger Durable Object backs it with SQLite, tests with a Map. The
// reservation is committed before the caller ever awaits SMTP, so a
// concurrent attempt sees the consumed quota, and the duplicate window is
// claimed at the same moment (it is released again when the attempt fails
// before delivery, so a legitimate retry is not mistaken for a double send).

import type { SendCaps } from "./send-policy";

export interface AuditEntry {
  ts: number;
  event: string;
  principal: string | null;
  rcptCount: number | null;
  rcptDomains: string[] | null;
  bytes: number | null;
  smtpCode: string | null;
  durationMs: number | null;
}

export interface LedgerStore {
  getUsage(day: string): { messages: number; recipients: number } | null;
  setUsage(day: string, messages: number, recipients: number): void;
  addAudit(entry: AuditEntry): void;
  pruneAudit(before: number): void;
  /** When this exact message was last submitted, or null. */
  lastSendAt(hash: string): number | null;
  recordSend(hash: string, ts: number): void;
  forgetSend(hash: string): void;
  pruneSends(before: number): void;
}

export type LedgerErrorCode = "daily_limit_reached" | "duplicate_send";

export type LedgerResult<T> = { ok: true; value: T } | { ok: false; code: LedgerErrorCode; message: string };

/** How long an identical serialized message counts as a duplicate. */
export const DUPLICATE_WINDOW_MS = 60_000;

/** How long claimed hashes are kept around for the window and pruning. */
const DUPLICATE_RETENTION_MS = 10 * 60_000;

export function usageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export class SendLedgerCore {
  constructor(
    private readonly store: LedgerStore,
    private readonly log: (entry: AuditEntry) => void = () => {},
  ) {}

  audit(entry: Omit<AuditEntry, "ts"> & { ts?: number }): void {
    const full: AuditEntry = { ts: Date.now(), ...entry } as AuditEntry;
    this.store.addAudit(full);
    this.log(full);
  }

  /**
   * Claim the attempt: refuse a recent identical message (unless the caller
   * explicitly allows it), check the daily caps, then reserve the quota and
   * record the hash in one synchronous step.
   */
  beginSend(
    now: number,
    recipients: number,
    hash: string,
    allowDuplicate: boolean,
    caps: SendCaps,
  ): LedgerResult<{ day: string }> {
    if (!allowDuplicate) {
      const last = this.store.lastSendAt(hash);
      if (last !== null && now - last < DUPLICATE_WINDOW_MS) {
        return {
          ok: false,
          code: "duplicate_send",
          message: `the same message was submitted ${Math.max(0, Math.round((now - last) / 1000))}s ago; pass allowDuplicate to send it again`,
        };
      }
    }

    const day = usageDay(now);
    const usage = this.store.getUsage(day) ?? { messages: 0, recipients: 0 };
    if (caps.maxPerDay === 0 || usage.messages + 1 > caps.maxPerDay) {
      return { ok: false, code: "daily_limit_reached", message: `daily send limit reached (${caps.maxPerDay}/day)` };
    }
    if (caps.maxRcptsPerDay === 0 || usage.recipients + recipients > caps.maxRcptsPerDay) {
      return {
        ok: false,
        code: "daily_limit_reached",
        message: `daily recipient limit reached (${caps.maxRcptsPerDay}/day)`,
      };
    }
    this.store.setUsage(day, usage.messages + 1, usage.recipients + recipients);
    this.store.recordSend(hash, now);
    this.store.pruneSends(now - DUPLICATE_RETENTION_MS);
    return { ok: true, value: { day } };
  }

  /** Give back what a failed attempt reserved, and release its hash. */
  release(day: string, recipients: number, hash: string): void {
    const usage = this.store.getUsage(day);
    if (usage) {
      this.store.setUsage(day, Math.max(0, usage.messages - 1), Math.max(0, usage.recipients - recipients));
    }
    this.store.forgetSend(hash);
  }

  /** Keep the hash after a successful (or unknown) submission. */
  keep(hash: string, now: number): void {
    this.store.recordSend(hash, now);
  }

  /** Prune audit rows and stale duplicate-window claims. */
  sweep(now: number): void {
    this.store.pruneAudit(now - 90 * 86_400_000);
    this.store.pruneSends(now - DUPLICATE_RETENTION_MS);
  }
}

/** base64 (standard) to bytes, as the DO passes the message across RPC. */
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
