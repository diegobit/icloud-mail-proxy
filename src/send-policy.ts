// Send-side configuration (plans/email-send.md, step 1): the caps every
// outgoing message is checked against, plus the optional From identity.
//
// Every cap is read from a base `vars` entry and clamped to a hard maximum
// below, so a mis-set variable can tighten sending but never widen it past
// what the plan allows. A daily cap of 0 refuses every send: the documented
// kill switch. Invalid optional values fail sending closed with
// `send_not_configured`; reads are never affected.

import { isValidAddress } from "./mime-build";
import type { Env } from "./types";

export interface SendCaps {
  maxPerDay: number;
  maxRcptsPerDay: number;
  maxRcptsPerMessage: number;
  maxBodyBytes: number;
  draftTtlSeconds: number;
  maxOpenDrafts: number;
}

export interface SendConfig {
  from: string;
  fromName: string | null;
  caps: SendCaps;
  /** Append a copy of a sent message to the Sent mailbox (off until live
   * acceptance shows whether iCloud files SMTP submissions itself). */
  sentCopy: boolean;
}

export const SEND_HARD_MAXIMA: SendCaps = {
  maxPerDay: 100,
  maxRcptsPerDay: 200,
  maxRcptsPerMessage: 20,
  maxBodyBytes: 262_144,
  draftTtlSeconds: 86_400,
  maxOpenDrafts: 100,
};

const DEFAULTS: SendCaps = {
  maxPerDay: 20,
  maxRcptsPerDay: 50,
  maxRcptsPerMessage: 5,
  maxBodyBytes: 65_536,
  draftTtlSeconds: 3_600,
  maxOpenDrafts: 20,
};

/**
 * Integer env var: unparsable or below `min` values fall back to the default,
 * values above the hard maximum clamp down, and zero is preserved only where
 * the caller allows it (the daily caps, where 0 disables sending).
 */
function intVar(
  value: string | undefined,
  fallback: number,
  hardMax: number,
  opts: { allowZero?: boolean; min?: number } = {},
): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (trimmed === "") return fallback;
  if (!/^-?\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return fallback;
  if (n === 0) return opts.allowZero ? 0 : fallback;
  const min = opts.min ?? 1;
  if (n < min) return fallback;
  return Math.min(n, hardMax);
}

export function readSendConfig(env: Env): { ok: true; config: SendConfig } | { ok: false; error: string } {
  const from = (env.SEND_FROM ?? "").trim() || env.ICLOUD_USER;
  if (!isValidAddress(from)) {
    return { ok: false, error: "SEND_FROM is not a usable email address" };
  }
  const rawName = (env.SEND_FROM_NAME ?? "").trim();
  if (rawName !== "" && /[\u0000-\u001f\u007f]/.test(rawName)) {
    return { ok: false, error: "SEND_FROM_NAME contains control characters" };
  }
  const sentCopy = /^(1|true)$/i.test((env.SEND_SENT_COPY ?? "").trim());
  return {
    ok: true,
    config: {
      from,
      fromName: rawName === "" ? null : rawName,
      caps: {
        maxPerDay: intVar(env.SEND_MAX_PER_DAY, DEFAULTS.maxPerDay, SEND_HARD_MAXIMA.maxPerDay, { allowZero: true }),
        maxRcptsPerDay: intVar(env.SEND_MAX_RCPTS_PER_DAY, DEFAULTS.maxRcptsPerDay, SEND_HARD_MAXIMA.maxRcptsPerDay, {
          allowZero: true,
        }),
        maxRcptsPerMessage: intVar(env.SEND_MAX_RCPTS_PER_MESSAGE, DEFAULTS.maxRcptsPerMessage, SEND_HARD_MAXIMA.maxRcptsPerMessage),
        maxBodyBytes: intVar(env.SEND_MAX_BODY_BYTES, DEFAULTS.maxBodyBytes, SEND_HARD_MAXIMA.maxBodyBytes),
        draftTtlSeconds: intVar(env.SEND_DRAFT_TTL_SECONDS, DEFAULTS.draftTtlSeconds, SEND_HARD_MAXIMA.draftTtlSeconds),
        maxOpenDrafts: intVar(env.SEND_MAX_OPEN_DRAFTS, DEFAULTS.maxOpenDrafts, SEND_HARD_MAXIMA.maxOpenDrafts),
      },
      sentCopy,
    },
  };
}
