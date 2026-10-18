// Pure framing for the one IMAP write command this proxy issues: APPEND
// (plans/email-send.md, step 8). Kept out of imap.ts so it is Node-testable.

import { ImapParseError, quoteImapString } from "./imap-parse";

/** Flags the caller may set on an appended message. */
const ALLOWED_FLAGS = new Set(["\\Draft", "\\Seen"]);

/**
 * The command text that introduces an APPEND literal, without the tag or the
 * trailing CRLF (the session composes `A<n> <command>\r\n`):
 * `APPEND "Drafts" (\Draft) {1234}`. With `nonSynchronizing` it emits the
 * RFC 2088 `{1234+}`, which tells a LITERAL+-capable server to expect the
 * bytes without a continuation. The caller then writes exactly `byteLength`
 * octets plus a terminating CRLF.
 */
export function buildAppend(
  mailbox: string,
  flags: string[],
  byteLength: number,
  options?: { nonSynchronizing?: boolean },
): string {
  if (!Array.isArray(flags)) throw new ImapParseError("flags must be an array");
  for (const flag of flags) {
    if (!ALLOWED_FLAGS.has(flag)) throw new ImapParseError(`flag not allowed: ${flag}`);
  }
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new ImapParseError("cannot append an empty message");
  }
  const parts = ["APPEND", quoteImapString(mailbox)];
  if (flags.length > 0) parts.push(`(${flags.join(" ")})`);
  parts.push(`{${byteLength}${options?.nonSynchronizing === true ? "+" : ""}}`);
  return parts.join(" ");
}
