// Build the final RFC 5322 bytes for an outgoing message
// (plans/email-send.md, step 2). Pure and Node-testable: no Workers imports,
// no network.
//
// Everything here is attacker-influenced — the model composing a draft can be
// steered by the mail it just read — so hostile input is rejected, never
// repaired, and every value that reaches a header goes through an encoder
// rather than being interpolated raw. The serialized message is asserted to
// be pure 7-bit ASCII before it leaves this module.

export class MimeBuildError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MimeBuildError";
    this.code = code;
  }
}

/** A parsed mailbox: display name (optional) plus a strict ASCII addr-spec. */
export interface Mailbox {
  name: string | null;
  address: string;
}

const encoder = new TextEncoder();

const NAME_MAX = 128;
const SUBJECT_MAX = 200;

// ---- address grammar -------------------------------------------------------

// dot-atom local part: atext runs joined by single dots.
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;
const TLD_RE = /^[A-Za-z]{2,}$/;

/**
 * Strict ASCII addr-spec: dot-atom local part, @, then a dot-atom domain with
 * at least two labels and an alphabetic TLD. Quoted local parts, comments,
 * route addresses, IP literals, IDNs and non-ASCII are rejected, so nothing
 * here can smuggle a second address, a control character or a header break.
 */
export function isValidAddress(address: string): boolean {
  if (address.length === 0 || address.length > 254) return false;
  const at = address.lastIndexOf("@");
  if (at <= 0 || at === address.length - 1) return false;
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (local.length === 0 || local.length > 64) return false;
  if (!LOCAL_RE.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  let domainLength = 0;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!LABEL_RE.test(label)) return false;
    domainLength += label.length + 1;
  }
  if (domainLength - 1 > 253) return false;
  if (!TLD_RE.test(labels[labels.length - 1])) return false;
  return true;
}

/** Reject CR, LF, NUL and every other C0 control (TAB is allowed). */
function assertNoControls(value: string, what: string): void {
  if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
    throw new MimeBuildError("invalid_value", `${what} contains control characters`);
  }
}

function hasNonAscii(value: string): boolean {
  return /[^\u0020-\u007e]/.test(value);
}

/**
 * Parse `Name <addr>` or a bare `addr` into a Mailbox, rejecting anything the
 * strict grammar cannot represent. Display names may carry any printable
 * character (they are encoded on output); addresses and the brackets
 * themselves must be plain ASCII.
 */
export function parseMailbox(input: string): Mailbox {
  if (typeof input !== "string" || input.length === 0) {
    throw new MimeBuildError("invalid_address", "empty address");
  }
  assertNoControls(input, "address");
  if (input.length > 320) {
    throw new MimeBuildError("invalid_address", "address is too long");
  }
  const match = /^(.*?)\s*<([^<>]*)>$/.exec(input);
  let name: string | null = null;
  let address: string;
  if (match) {
    name = match[1].trim();
    if (name === "") name = null;
    address = match[2].trim();
  } else {
    address = input.trim();
  }
  if (!isValidAddress(address)) {
    throw new MimeBuildError("invalid_address", `not a usable address: ${JSON.stringify(input)}`);
  }
  if (name !== null && name.length > NAME_MAX) {
    throw new MimeBuildError("invalid_address", "display name is too long");
  }
  return { name, address };
}

// ---- header encoding -------------------------------------------------------

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function isPrintableAscii(value: string): boolean {
  return !hasNonAscii(value);
}

/**
 * RFC 2047 B-encoding of `value` as one or more encoded-words, each short
 * enough (encoded length <= maxWord) to keep the 78-character line goal when
 * folded with CRLF + SP. Splits on code-point boundaries only.
 */
export function encodeWords(value: string, maxWord = 75): string {
  if (value.length === 0) return "=?UTF-8?B??=";
  const codePoints = Array.from(value);
  const words: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  const overhead = "=?UTF-8?B??=".length;
  for (const cp of codePoints) {
    const cpBytes = encoder.encode(cp).length;
    // base64 length includes padding: 4 * ceil(bytes / 3).
    const base64Length = 4 * Math.ceil((currentBytes + cpBytes) / 3);
    if (current.length > 0 && overhead + base64Length > maxWord) {
      words.push(current.join(""));
      current = [];
      currentBytes = 0;
    }
    current.push(cp);
    currentBytes += cpBytes;
  }
  words.push(current.join(""));
  return words.map((word) => `=?UTF-8?B?${base64(encoder.encode(word))}?=`).join("\r\n ");
}

/** An ASCII quoted-string, with backslash and quote escaped. */
export function quoteString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** A display name as it appears in a header: quoted-string or encoded-word. */
export function formatDisplayName(name: string): string {
  return isPrintableAscii(name) ? quoteString(name) : encodeWords(name);
}

/** `Name <addr>` or `addr`, header-safe. */
export function formatMailbox(mailbox: Mailbox): string {
  if (!isValidAddress(mailbox.address)) {
    throw new MimeBuildError("invalid_address", "mailbox has an invalid address");
  }
  if (mailbox.name === null) return mailbox.address;
  assertNoControls(mailbox.name, "display name");
  return `${formatDisplayName(mailbox.name)} <${mailbox.address}>`;
}

/**
 * A subject value: plain when it is short printable ASCII, RFC 2047 encoded
 * otherwise (which also keeps every folded line bounded).
 */
export function encodeSubject(subject: string): string {
  assertNoControls(subject, "subject");
  if (subject.length > SUBJECT_MAX) {
    throw new MimeBuildError("invalid_value", `subject is longer than ${SUBJECT_MAX} characters`);
  }
  if (isPrintableAscii(subject) && subject.length <= 70 && !subject.includes("  ")) return subject;
  return encodeWords(subject);
}

/**
 * A header value derived from a *fetched* message (parent subject, display
 * name) rather than from the caller. Controls are collapsed to spaces — a
 * draft must not fail because a thread's subject is hostile — and the result
 * is capped.
 */
export function sanitizeDerivedHeader(value: string | null | undefined, max = SUBJECT_MAX): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function defaultReplySubject(parentSubject: string | null | undefined): string {
  const clean = sanitizeDerivedHeader(parentSubject);
  if (clean === null) return "Re:";
  return /^re:/i.test(clean) ? clean : `Re: ${clean}`;
}

export function defaultForwardSubject(parentSubject: string | null | undefined): string {
  const clean = sanitizeDerivedHeader(parentSubject);
  if (clean === null) return "Fwd:";
  return /^fwd?:/i.test(clean) ? clean : `Fwd: ${clean}`;
}

// ---- message ids and references --------------------------------------------

// Exactly the id grammar RFC 5322 allows inside angle brackets: no spaces, no
// angle brackets, no controls. Parent ids are copied from third-party mail,
// so invalid ones are dropped, never repaired.
const MESSAGE_ID_RE = /^<[\u0021-\u003b\u003d\u003f-\u007e]{1,250}>$/;

export function isMessageId(value: unknown): value is string {
  return typeof value === "string" && MESSAGE_ID_RE.test(value);
}

/** Split a `References` header into individual ids, dropping invalid ones. */
export function splitReferences(value: string | null | undefined): string[] {
  if (typeof value !== "string") return [];
  return value.match(/<[^<>]*>/g)?.filter(isMessageId) ?? [];
}

/**
 * The `References` value for a reply: the parent's references plus the parent
 * id, trimmed per RFC 5322 practice to the first plus the last 9 ids.
 */
export function buildReferences(parentReferences: string[], parentId: string | null): string[] {
  const ids = parentReferences.filter(isMessageId);
  if (isMessageId(parentId) && ids[ids.length - 1] !== parentId) ids.push(parentId);
  if (ids.length > 10) return [ids[0], ...ids.slice(ids.length - 9)];
  return ids;
}

// ---- quoted-printable body -------------------------------------------------

/** Normalize LF, CRLF and lone CR to CRLF. */
export function normalizeCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, "\n").replace(/\n/g, "\r\n");
}

function hex2(byte: number): string {
  return `=${byte.toString(16).toUpperCase().padStart(2, "0")}`;
}

function encodeQpLine(line: string): string {
  const bytes = encoder.encode(line);
  let out = "";
  let lineLength = 0;
  let pendingWhitespace = "";
  const push = (token: string): void => {
    if (lineLength + token.length > 75) {
      out += "=\r\n";
      lineLength = 0;
    }
    out += token;
    lineLength += token.length;
  };
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09) {
      pendingWhitespace += String.fromCharCode(byte);
      continue;
    }
    for (const ch of pendingWhitespace) push(ch);
    pendingWhitespace = "";
    if (byte >= 0x21 && byte <= 0x7e && byte !== 0x3d) push(String.fromCharCode(byte));
    else push(hex2(byte));
  }
  // Trailing whitespace on a line must be encoded, or a transport could eat it.
  for (const ch of pendingWhitespace) push(hex2(ch.charCodeAt(0)));
  return out;
}

/** Encode a CRLF-normalized body as quoted-printable with lines <= 76. */
export function quotedPrintable(text: string): string {
  return text.split("\r\n").map(encodeQpLine).join("\r\n");
}

// ---- assembly --------------------------------------------------------------

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 date-time in UTC: `Sun, 18 Oct 2026 14:03:00 +0000`. */
export function rfc5322Date(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new MimeBuildError("invalid_value", "invalid date");
  }
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** Truncate on a code-point boundary, appending a marker, to fit maxBytes. */
export function truncateUtf8(text: string, maxBytes: number, marker = "\n[truncated]"): string {
  if (utf8Length(text) <= maxBytes) return text;
  let markerText = marker;
  while (markerText.length > 0 && utf8Length(markerText) > maxBytes) {
    markerText = markerText.slice(0, -1);
  }
  const budget = Math.max(0, maxBytes - utf8Length(markerText));
  let out = "";
  let used = 0;
  for (const cp of Array.from(text)) {
    const size = utf8Length(cp);
    if (used + size > budget) break;
    out += cp;
    used += size;
  }
  return out + markerText;
}

export interface DraftMessageInput {
  from: Mailbox;
  to: Mailbox[];
  cc: Mailbox[];
  bcc: Mailbox[];
  subject: string;
  /** CRLF- or LF-separated plain text; normalized here. */
  text: string;
  date: Date;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  maxBodyBytes: number;
}

export interface BuiltMessage {
  raw: Uint8Array;
  envelopeFrom: string;
  /** Envelope recipients (To ∪ Cc ∪ Bcc), deduplicated case-insensitively. */
  recipients: string[];
  subject: string;
  messageId: string;
  dateIso: string;
  text: string;
  textBytes: number;
}

/**
 * Serialize the final message. `Date`, `Message-ID` and the body bytes are
 * fixed here, so the bytes the owner approves on the page are exactly the
 * bytes the SMTP client submits.
 */
export function buildMessage(input: DraftMessageInput): BuiltMessage {
  if (typeof input.text !== "string" || input.text.includes("\u0000")) {
    throw new MimeBuildError("invalid_body", "body is missing or contains NUL");
  }
  if (!isValidAddress(input.from.address)) {
    throw new MimeBuildError("invalid_address", "sender address is not usable");
  }
  const all: Mailbox[] = [...input.to, ...input.cc, ...input.bcc];
  if (all.length === 0) {
    throw new MimeBuildError("invalid_address", "at least one recipient is required");
  }
  for (const mailbox of all) {
    if (!isValidAddress(mailbox.address)) {
      throw new MimeBuildError("invalid_address", `invalid recipient: ${JSON.stringify(mailbox.address)}`);
    }
  }
  const text = normalizeCrlf(input.text);
  const textBytes = utf8Length(text);
  if (textBytes === 0) {
    throw new MimeBuildError("invalid_body", "body is empty");
  }
  if (textBytes > input.maxBodyBytes) {
    throw new MimeBuildError("message_too_large", `body is ${textBytes} bytes, over the ${input.maxBodyBytes}-byte limit`);
  }
  if (!isMessageId(input.messageId)) {
    throw new MimeBuildError("invalid_value", "message id is malformed");
  }

  const headers: string[] = [
    `From: ${formatMailbox(input.from)}`,
    `To: ${input.to.map(formatMailbox).join(", ")}`,
  ];
  if (input.cc.length > 0) headers.push(`Cc: ${input.cc.map(formatMailbox).join(", ")}`);
  // Never a Bcc header: Bcc recipients exist only in the SMTP envelope.
  headers.push(`Subject: ${encodeSubject(input.subject)}`);
  headers.push(`Date: ${rfc5322Date(input.date)}`);
  headers.push(`Message-ID: ${input.messageId}`);
  if (isMessageId(input.inReplyTo)) headers.push(`In-Reply-To: ${input.inReplyTo}`);
  const references = buildReferences(input.references ?? [], input.inReplyTo ?? null);
  if (references.length > 0) headers.push(`References: ${references.join(" ")}`);
  headers.push("MIME-Version: 1.0");
  headers.push("Content-Type: text/plain; charset=utf-8");
  headers.push("Content-Transfer-Encoding: quoted-printable");

  const headerBlock = headers.join("\r\n");
  for (const line of headerBlock.split("\r\n")) {
    if (line.length > 998) throw new MimeBuildError("invalid_value", "header line too long");
  }

  const body = quotedPrintable(text);
  const raw = encoder.encode(`${headerBlock}\r\n\r\n${body}\r\n`);
  for (const byte of raw) {
    if (byte > 0x7f) throw new MimeBuildError("invalid_body", "serialized message is not 7-bit");
  }

  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const mailbox of all) {
    const key = mailbox.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(mailbox.address);
  }

  return {
    raw,
    envelopeFrom: input.from.address,
    recipients,
    subject: input.subject,
    messageId: input.messageId,
    dateIso: input.date.toISOString(),
    text,
    textBytes,
  };
}

/**
 * The quoted block of a forward: headers the recipient needs to understand
 * what is being forwarded, then the original body. Bounded by the caller.
 */
export function forwardQuote(
  header: { from: string | null; date: string | null; subject: string | null },
  body: string,
): string {
  const from = sanitizeDerivedHeader(header.from, 320) ?? "unknown";
  const date = sanitizeDerivedHeader(header.date, 120) ?? "unknown";
  const subject = sanitizeDerivedHeader(header.subject) ?? "(no subject)";
  return [
    "---------- Forwarded message ----------",
    `From: ${from}`,
    `Date: ${date}`,
    `Subject: ${subject}`,
    "",
    normalizeCrlf(body),
  ].join("\r\n");
}
