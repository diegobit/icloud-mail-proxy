// Shared, transport-agnostic logic for the read-only iCloud Mail proxy.
//
// This module knows nothing about HTTP or MCP: it takes an Env plus plain
// parameters, talks to IMAP via ImapSession, parses messages with postal-mime
// and returns the typed shapes from src/types.ts. Client-side problems are
// signalled with ApiError (carrying an HTTP-ish status + machine code); the
// callers translate ApiError / ImapError into their own wire formats.

import PostalMime from "postal-mime";
import type { Address as PMAddress, Email as PMEmail } from "postal-mime";
import { ImapSession } from "./imap";
import { htmlToText } from "./html-text";
import { quoteImapString, toImapDate } from "./imap-parse";
import type {
  Address,
  AttachmentInfo,
  Env,
  MessageDetail,
  MessageSummary,
  SearchParams,
  SearchResult,
} from "./types";

/** Thrown for client-attributable failures (bad input, not found, too large). */
export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const MS_PER_DAY = 86_400_000;

/** Parse ALLOWED_MAILBOXES ("A,B,C") into a trimmed, non-empty list. */
export function listMailboxes(env: Env): string[] {
  return env.ALLOWED_MAILBOXES.split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function assertMailboxAllowed(env: Env, mailbox: string): void {
  const allowed = listMailboxes(env);
  if (!allowed.includes(mailbox)) {
    throw new ApiError(
      400,
      "mailbox_not_allowed",
      `mailbox not allowed: ${JSON.stringify(mailbox)}; allowed: ${allowed.join(", ")}`,
    );
  }
}

/** Positive integer env var with a sane fallback. */
function intEnv(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

/** Parse a strict YYYY-MM-DD date (UTC midnight); reject anything else. */
function parseYmd(s: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) {
    throw new ApiError(400, "invalid_date", `date must be YYYY-MM-DD: ${s}`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new ApiError(400, "invalid_date", `invalid calendar date: ${s}`);
  }
  return d;
}

/** Current date as UTC midnight. */
function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Flatten a postal-mime address (or list/group) into our Address[] shape. */
function mapAddresses(input: PMAddress | PMAddress[] | undefined): Address[] {
  if (!input) return [];
  const list = Array.isArray(input) ? input : [input];
  const out: Address[] = [];
  for (const a of list) {
    if (a.group) {
      for (const member of a.group) {
        out.push({ name: member.name || null, address: member.address ?? null });
      }
    } else {
      out.push({ name: a.name || null, address: a.address ?? null });
    }
  }
  return out;
}

/** Parse raw RFC822 bytes (or header-only bytes) with postal-mime. */
async function parseEmail(bytes: Uint8Array): Promise<PMEmail> {
  return new PostalMime().parse(bytes);
}

/**
 * Append a blank line so a header-only section parses as a headerless-body
 * message. Appending an extra CRLF pair is harmless when one is already there.
 */
function ensureHeaderTerminator(bytes: Uint8Array): Uint8Array {
  const sep = new TextEncoder().encode("\r\n\r\n");
  const out = new Uint8Array(bytes.length + sep.length);
  out.set(bytes, 0);
  out.set(sep, bytes.length);
  return out;
}

function attachmentByteLength(content: ArrayBuffer | Uint8Array | string): number | null {
  if (content instanceof Uint8Array) return content.byteLength;
  if (content instanceof ArrayBuffer) return content.byteLength;
  return null;
}

export async function searchMail(env: Env, params: SearchParams): Promise<SearchResult> {
  assertMailboxAllowed(env, params.mailbox);

  const maxResults = intEnv(env.MAX_RESULTS, 20);
  const maxSearchDays = intEnv(env.MAX_SEARCH_DAYS, 90);

  let limit = params.limit ?? maxResults;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ApiError(400, "invalid_limit", "limit must be a positive integer");
  }
  if (limit > maxResults) limit = maxResults;

  // Date window. The default lower bound (today - MAX_SEARCH_DAYS) always
  // applies; an explicit `after` can only narrow it, never widen it.
  const today = todayUtc();
  const minAfter = new Date(today.getTime() - maxSearchDays * MS_PER_DAY);
  const requestedAfter = params.after ? parseYmd(params.after) : null;
  const effectiveAfter =
    requestedAfter && requestedAfter.getTime() > minAfter.getTime()
      ? requestedAfter
      : minAfter;
  const beforeDate = params.before ? parseYmd(params.before) : null;

  const criteriaParts: string[] = [`SINCE ${toImapDate(effectiveAfter)}`];
  if (beforeDate) criteriaParts.push(`BEFORE ${toImapDate(beforeDate)}`);
  // UNSEEN is a fixed IMAP keyword, never built from user input.
  if (params.unseen === true) criteriaParts.push("UNSEEN");
  try {
    if (params.from) criteriaParts.push(`FROM ${quoteImapString(params.from)}`);
    if (params.subject) criteriaParts.push(`SUBJECT ${quoteImapString(params.subject)}`);
    if (params.text) criteriaParts.push(`TEXT ${quoteImapString(params.text)}`);
  } catch {
    // quoteImapString rejects non-ASCII / control chars.
    throw new ApiError(
      400,
      "invalid_criteria",
      "search terms must be printable ASCII (non-ASCII search is unsupported in v1)",
    );
  }
  const criteria = criteriaParts.join(" ");

  const session = await ImapSession.open(env.ICLOUD_USER, env.ICLOUD_APP_PASSWORD);
  try {
    const examined = await session.examine(params.mailbox);
    const matched = await session.uidSearch(criteria);
    const total = matched.length;

    // Highest UIDs are the newest messages; take the last `limit` of them.
    const sortedAsc = [...matched].sort((a, b) => a - b);
    const selected = sortedAsc.slice(-limit);

    const envelopes = await session.fetchEnvelopes(selected);
    const messages: MessageSummary[] = [];
    for (const env0 of envelopes) {
      const parsed = await parseEmail(ensureHeaderTerminator(env0.headerBytes));
      const flags = env0.flags.map((f) => f.toLowerCase());
      messages.push({
        mailbox: params.mailbox,
        uidValidity: examined.uidValidity,
        uid: env0.uid,
        date: parsed.date ?? env0.internalDate ?? null,
        from: mapAddresses(parsed.from),
        to: mapAddresses(parsed.to),
        subject: parsed.subject ?? null,
        size: env0.size,
        seen: flags.includes("\\seen"),
        flagged: flags.includes("\\flagged"),
        answered: flags.includes("\\answered"),
      });
    }
    messages.sort((a, b) => b.uid - a.uid);

    return {
      mailbox: params.mailbox,
      uidValidity: examined.uidValidity,
      total,
      messages,
    };
  } finally {
    await session.logout();
  }
}

export async function getMessage(
  env: Env,
  mailbox: string,
  uidValidity: number,
  uid: number,
): Promise<MessageDetail> {
  assertMailboxAllowed(env, mailbox);
  if (!Number.isSafeInteger(uidValidity) || uidValidity <= 0) {
    throw new ApiError(400, "invalid_uidvalidity", "uidValidity must be a positive integer");
  }
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new ApiError(400, "invalid_uid", "uid must be a positive integer");
  }

  const maxBytes = intEnv(env.MAX_MESSAGE_BYTES, 3_145_728);

  const session = await ImapSession.open(env.ICLOUD_USER, env.ICLOUD_APP_PASSWORD);
  try {
    const examined = await session.examine(mailbox);
    if (examined.uidValidity !== uidValidity) {
      throw new ApiError(
        409,
        "uidvalidity_mismatch",
        `UIDVALIDITY changed (now ${examined.uidValidity}); re-run the search to get fresh ids`,
      );
    }

    let size: number;
    try {
      size = await session.fetchSize(uid);
    } catch (e) {
      // No FETCH data for this UID (or unparseable) => the message is gone.
      const code = (e as { code?: string }).code;
      if (code === "PARSE" || code === "NO") {
        throw new ApiError(404, "message_not_found", `no message with uid ${uid}`);
      }
      throw e;
    }
    // Oversized messages are fetched partially (first maxBytes bytes) and
    // flagged, rather than refused with a 413.
    const truncated = size > maxBytes;
    const raw = truncated
      ? await session.fetchRawPartial(uid, maxBytes)
      : await session.fetchRaw(uid, maxBytes);

    let parsed: PMEmail;
    try {
      parsed = await parseEmail(raw);
    } catch (e) {
      // postal-mime tolerates truncated input, but a cut mid-structure can
      // still make it throw. For a truncated fetch, degrade to a minimal,
      // clearly-flagged detail instead of surfacing a 500.
      if (!truncated) throw e;
      return {
        id: { mailbox, uidValidity, uid },
        date: null,
        from: [],
        to: [],
        cc: [],
        subject: null,
        messageId: null,
        untrustedEmailContent: { text: null, textSource: null },
        attachments: [],
        truncated: true,
      };
    }

    const attachments: AttachmentInfo[] = parsed.attachments.map((att, index) => ({
      index,
      filename: att.filename ?? null,
      mimeType: att.mimeType ?? null,
      size: attachmentByteLength(att.content),
    }));

    // Body text is untrusted third-party content; raw HTML is never surfaced.
    // Prefer the message's own plain-text part; otherwise derive text from the
    // HTML part so HTML-only messages are not returned empty.
    let text: string | null = parsed.text ?? null;
    let textSource: "text" | "html" | null = text !== null ? "text" : null;
    if (text === null && parsed.html) {
      text = htmlToText(parsed.html);
      textSource = "html";
    }

    return {
      id: { mailbox, uidValidity, uid },
      date: parsed.date ?? null,
      from: mapAddresses(parsed.from),
      to: mapAddresses(parsed.to),
      cc: mapAddresses(parsed.cc),
      subject: parsed.subject ?? null,
      messageId: parsed.messageId ?? null,
      untrustedEmailContent: { text, textSource },
      attachments,
      truncated,
    };
  } finally {
    await session.logout();
  }
}
