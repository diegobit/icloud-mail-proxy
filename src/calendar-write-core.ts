// Shared helpers for the CalDAV event write surface.
//
// The contract:
// - structured fields only, never raw iCalendar;
// - strong ETags only for updates, with a re-read before the PUT;
// - one written resource per call;
// - a per-IP rate limit before any network work;
// - one audit line per attempted write, never with user text.

import { CalDavError } from "./caldav";
import type { CollectionInfo } from "./calendar-core";
import { byteLength } from "./calendar-resource";
import { ApiError } from "./core";
import type { Env } from "./types";

export const SUMMARY_MAX_CHARS = 200;
export const TEXT_MAX_BYTES = 8 * 1024;

/** Properties v1 never creates and refuses to mutate a resource carrying. */
export const FORBIDDEN_WRITE_PROPERTIES = new Set([
  "rrule",
  "rdate",
  "exdate",
  "recurrence-id",
  "attendee",
  "organizer",
]);

export type WriteAction = "create_event" | "update_event";

export interface WriteOptions {
  /** Recorded in the audit line; defaults to "unknown". */
  principal?: string;
  /** Injected for tests; production uses the Worker's fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; the default is Date.now(). */
  now?: number;
  /** Per-IP bucket for CALENDAR_WRITE_LIMITER. */
  rateLimitKey?: string;
}

export function normalizeSummary(value: string): string {
  const summary = value.trim();
  if (summary === "") throw new ApiError(400, "invalid_request", "summary must not be empty");
  const chars = [...summary].length;
  if (chars > SUMMARY_MAX_CHARS) {
    throw new ApiError(
      400,
      "invalid_request",
      `summary is ${chars} characters; the limit is ${SUMMARY_MAX_CHARS}`,
    );
  }
  return summary;
}

export function normalizeText(
  value: string | null | undefined,
  label: string,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  const bytes = byteLength(value);
  if (bytes > TEXT_MAX_BYTES) {
    throw new ApiError(
      400,
      "invalid_request",
      `${label} is ${bytes} bytes; the limit is ${TEXT_MAX_BYTES}`,
    );
  }
  return value;
}

export function escapeIcalText(value: string): string {
  return value
    .replace(/\r\n|\r/g, "\n")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");
}

/** Fold one content line at 75 octets without splitting a UTF-8 sequence. */
export function foldIcalLine(line: string): string[] {
  const encoder = new TextEncoder();
  if (encoder.encode(line).byteLength <= 75) return [line];
  const folded: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of line) {
    const size = encoder.encode(char).byteLength;
    // A continuation line starts with one space, so it carries 74 octets.
    const limit = folded.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      folded.push(current);
      current = ` ${char}`;
      bytes = 1 + size;
    } else {
      current += char;
      bytes += size;
    }
  }
  if (current !== "") folded.push(current);
  return folded;
}

export function serializeIcal(lines: readonly string[]): string {
  return lines.flatMap(foldIcalLine).join("\r\n") + "\r\n";
}

export async function withWriteLimit<T>(
  env: Env,
  key: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const limiter = env.CALENDAR_WRITE_LIMITER;
  if (limiter === undefined || limiter === null) {
    throw new ApiError(
      500,
      "configuration_error",
      "CALENDAR_WRITE_LIMITER is not configured; calendar writes are disabled",
    );
  }
  const { success } = await limiter.limit({ key: key ?? "unknown" });
  if (!success) {
    throw new ApiError(429, "rate_limited", "too many calendar writes; retry in a minute");
  }
  return fn();
}

export function readOnlyCollectionError(collection: CollectionInfo): ApiError {
  return new ApiError(
    403,
    "read_only_collection",
    `the calendar ${JSON.stringify(collection.name)} is read-only for this account`,
  );
}

export function outcomeOf(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (error instanceof CalDavError) return error.code;
  return "internal_error";
}

export async function auditWrite<T>(
  options: WriteOptions,
  action: WriteAction,
  collectionId: string,
  resourceId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    logWrite(options.principal, action, collectionId, resourceId, "ok");
    return result;
  } catch (error) {
    logWrite(options.principal, action, collectionId, resourceId, outcomeOf(error));
    throw error;
  }
}

function logWrite(
  principal: string | undefined,
  action: string,
  collectionId: string,
  resourceId: string,
  outcome: string,
): void {
  console.log(
    "calendar_write",
    JSON.stringify({
      principal: principal ?? "unknown",
      action,
      calendar: collectionId,
      resource: resourceId,
      outcome,
    }),
  );
}

export function reconcileMutationError(
  error: unknown,
  action: "create" | "update",
  id: string,
  readTool: "get_event",
): unknown {
  if (error instanceof CalDavError && error.code === "mutation_state_unknown") {
    return new CalDavError(
      "mutation_state_unknown",
      error.status,
      `${error.message} Reconcile with ${readTool} on ${JSON.stringify(id)} before retrying; ` +
        `the ${action} may already have landed.`,
    );
  }
  return error;
}
