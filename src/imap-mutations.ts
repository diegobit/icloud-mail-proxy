// Pure framing for mailbox mutations (plans/mailbox-mutations.md, step 1).
// Kept out of imap.ts so it is Node-testable, like imap-append.ts.
//
// A mutation is one of two fixed destinations chosen by the caller in
// src/core.ts, never by the request: the archive mailbox or the trash. These
// builders only know how to file a single uid there — there is deliberately no
// builder for EXPUNGE without a uid, for arbitrary flags, or for CREATE/DELETE
// of a mailbox.

import { ImapParseError, quoteImapString } from "./imap-parse";

/**
 * How a session should file one message, given the server's CAPABILITY list:
 * RFC 6851 `UID MOVE`; RFC 4315 `UID COPY` + `UID STORE` + `UID EXPUNGE`; or
 * nothing at all — a plain `EXPUNGE` would purge every `\Deleted` message in
 * the mailbox, not just this one, so the session refuses instead.
 */
export type MoveStrategy = "move" | "copy-uidplus" | "unsupported";

/** Pick the move strategy. Capability names are matched case-insensitively. */
export function chooseMoveStrategy(capabilities: ReadonlySet<string>): MoveStrategy {
  const names = new Set<string>();
  for (const name of capabilities) names.add(name.toUpperCase());
  if (names.has("MOVE")) return "move";
  if (names.has("UIDPLUS")) return "copy-uidplus";
  return "unsupported";
}

function assertUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new ImapParseError(`invalid UID: ${uid}`);
  }
}

/** `UID MOVE <uid> "<destination>"` (RFC 6851), without tag or CRLF. */
export function buildMove(uid: number, destination: string): string {
  assertUid(uid);
  return `UID MOVE ${uid} ${quoteImapString(destination)}`;
}

/** `UID COPY <uid> "<destination>"` (the first half of the fallback). */
export function buildCopy(uid: number, destination: string): string {
  assertUid(uid);
  return `UID COPY ${uid} ${quoteImapString(destination)}`;
}

/**
 * `UID STORE <uid> +FLAGS.SILENT (\Deleted)`. Only the `\Deleted` flag is ever
 * set, and only as part of the fallback: nothing else about the message's
 * flags is touched.
 */
export function buildStoreDeleted(uid: number): string {
  assertUid(uid);
  return `UID STORE ${uid} +FLAGS.SILENT (\\Deleted)`;
}

/**
 * `UID EXPUNGE <uid>` (RFC 4315): removes only the named uid's `\Deleted`
 * message, which is why the fallback requires UIDPLUS.
 */
export function buildUidExpunge(uid: number): string {
  assertUid(uid);
  return `UID EXPUNGE ${uid}`;
}
