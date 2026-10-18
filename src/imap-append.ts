// Pure framing for the one IMAP write command this proxy issues: APPEND
// (plans/email-send.md, step 8). Kept out of imap.ts so it is Node-testable.

import { ImapParseError, quoteImapString } from "./imap-parse";

/** Flags the caller may set on an appended message. */
const ALLOWED_FLAGS = new Set(["\\Draft", "\\Seen"]);

/**
 * The command line that introduces an APPEND literal:
 * `A1 APPEND "Drafts" (\Draft) {1234}` followed by CRLF. The caller then
 * writes exactly `bytes.byteLength` octets plus a terminating CRLF.
 */
export function buildAppend(mailbox: string, flags: string[], bytes: Uint8Array): string {
  if (!Array.isArray(flags)) throw new ImapParseError("flags must be an array");
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.has(flag)) throw new ImapParseError(`flag not allowed: ${flag}`);
  }
  if (!Number.isSafeInteger(bytes.byteLength) || bytes.byteLength <= 0) {
    throw new ImapParseError("cannot append an empty message");
  }
  const parts = ["APPEND", quoteImapString(mailbox)];
  if (flags.length > 0) parts.push(`(${flags.join(" ")})`);
  parts.push(`{${bytes.byteLength}}`);
  return `${parts.join(" ")}\r\n`;
}
