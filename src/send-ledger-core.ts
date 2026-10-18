// Quota and duplicate protection for outgoing mail (plans/email-send.md,
// "Owner revision": the server keeps no drafts and no approval state).
//
// Pure and Node-testable: the store is an injected synchronous interface —
// the SendLedger Durable Object backs it with SQLite, tests with a Map. The
// reservation is committed before the caller ever awaits SMTP, so a
// concurrent attempt sees the consumed quota, and each attempt claims its
// message hash: an identical attempt in flight is refused outright, and a
// failed attempt gives the claim back *without* erasing an earlier
// successful send's window.

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
  /** Claim the in-flight slot for this hash: "busy" means one is running. */
  claimSend(hash: string, ts: number): "claimed" | "busy";
  /** When this exact message last completed as sent or unknown, or null. */
  lastSendAt(hash: string): number | null;
  keepSend(hash: string, ts: number): void;
  /** Give the in-flight slot back; the completed-send time stays. */
  releaseSend(hash: string): void;
  /** Drop rows older than `before`, and free claims abandoned by a crash. */
  pruneSends(before: number): void;
}

export type LedgerErrorCode = "daily_limit_reached" | "duplicate_send";

export type LedgerResult<T> = { ok: true; value: T } | { ok: false; code: LedgerErrorCode; message: string };

/** How long an identical serialized message counts as a duplicate. */
export const DUPLICATE_WINDOW_MS = 60_000;

/** Claims older than this were abandoned by a crash and are freed. */
export const CLAIM_TIMEOUT_MS = 10 * 60_000;

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
   * Claim the attempt: refuse an identical message that is already in flight
   * or was completed inside the window (unless the caller explicitly allows a
   * resend), check the daily caps, then reserve the quota and the claim in
   * one synchronous step. Every refusal releases the claim it just made.
   */
  beginSend(
    now: number,
    recipients: number,
    hash: string,
    allowDuplicate: boolean,
    caps: SendCaps,
  ): LedgerResult<{ day: string }> {
    // Free claims abandoned by a crashed attempt first: otherwise a retry of
    // that very message would be refused as in-flight until some other send
    // happened to prune the row.
    this.store.pruneSends(now - CLAIM_TIMEOUT_MS);

    if (this.store.claimSend(hash, now) === "busy") {
      return {
        ok: false,
        code: "duplicate_send",
        message: "an identical message is already being submitted",
      };
    }
    if (!allowDuplicate) {
      const last = this.store.lastSendAt(hash);
      if (last !== null && now - last < DUPLICATE_WINDOW_MS) {
        this.store.releaseSend(hash);
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
      this.store.releaseSend(hash);
      return { ok: false, code: "daily_limit_reached", message: `daily send limit reached (${caps.maxPerDay}/day)` };
    }
    if (caps.maxRcptsPerDay === 0 || usage.recipients + recipients > caps.maxRcptsPerDay) {
      this.store.releaseSend(hash);
      return {
        ok: false,
        code: "daily_limit_reached",
        message: `daily recipient limit reached (${caps.maxRcptsPerDay}/day)`,
      };
    }
    this.store.setUsage(day, usage.messages + 1, usage.recipients + recipients);
    return { ok: true, value: { day } };
  }

  /** Give back what a failed attempt reserved, and free its claim. */
  release(day: string, recipients: number, hash: string): void {
    const usage = this.store.getUsage(day);
    if (usage) {
      this.store.setUsage(day, Math.max(0, usage.messages - 1), Math.max(0, usage.recipients - recipients));
    }
    this.store.releaseSend(hash);
  }

  /** Mark the attempt complete (sent or unknown): the window starts now. */
  keep(hash: string, now: number): void {
    this.store.keepSend(hash, now);
  }

  /** Prune audit rows and stale claims. */
  sweep(now: number): void {
    this.store.pruneAudit(now - 90 * 86_400_000);
    this.store.pruneSends(now - CLAIM_TIMEOUT_MS);
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
