// Pure parsing/formatting helpers for the IMAP client layer.
//
// This file must NOT import from "cloudflare:sockets" (or any Workers-only
// module) so that it can be unit-tested directly under Node/vitest.

export class ImapParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImapParseError";
  }
}

/** A single envelope as returned by fetchEnvelopes. */
export interface Envelope {
  uid: number;
  size: number;
  internalDate: string | null;
  flags: string[];
  headerBytes: Uint8Array;
}

/**
 * A protocol token produced by the tokenizer: either a CRLF-terminated line
 * (decoded as latin1, CRLF stripped, but any trailing `{N}` literal marker
 * kept intact) or a raw literal payload (arbitrary bytes, never decoded).
 */
export type ImapToken =
  | { kind: "line"; text: string }
  | { kind: "literal"; bytes: Uint8Array };

/** One parsed `* n FETCH (...)` response. */
export interface FetchItem {
  seq: number;
  uid: number | null;
  size: number | null;
  internalDate: string | null;
  /** Flags from `FLAGS (...)`, or null when FLAGS was not in the response. */
  flags: string[] | null;
  sections: { name: string; bytes: Uint8Array }[];
}

/**
 * Quote a string as an IMAP quoted string: wrap in double quotes and escape
 * backslash and double-quote. IMAP quoted strings are 7-bit and cannot contain
 * CR, LF or NUL, so those (and any non-ASCII byte) are rejected outright — this
 * doubles as a command-injection guard for mailbox names and credentials.
 */
export function quoteImapString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0x00 || code === 0x0d || code === 0x0a) {
      throw new ImapParseError("control character not allowed in IMAP string");
    }
    if (code > 0x7f) {
      throw new ImapParseError("non-ASCII character not allowed in IMAP string");
    }
    const ch = s[i];
    if (ch === "\\" || ch === '"') out += "\\";
    out += ch;
  }
  return out + '"';
}

/** Reject strings containing CR or LF (used to guard raw search criteria). */
export function assertNoCrlf(s: string): void {
  if (s.indexOf("\r") !== -1 || s.indexOf("\n") !== -1) {
    throw new ImapParseError("CR/LF not allowed");
  }
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Format a date as IMAP date-text ("01-Jul-2026"), in UTC, zero-padded day. */
export function toImapDate(d: Date): string {
  const day = String(d.getUTCDate()).padStart(2, "0");
  const month = MONTHS[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day}-${month}-${year}`;
}

/**
 * Extract UIDs from one or more `* SEARCH 4 8 15 ...` untagged lines.
 * Multiple SEARCH lines are concatenated; returns [] when there are none.
 */
export function parseSearchResponse(untaggedLines: string[]): number[] {
  const uids: number[] = [];
  for (const line of untaggedLines) {
    const m = line.match(/^\* SEARCH\b(.*)$/);
    if (!m) continue;
    for (const part of m[1].trim().split(/\s+/)) {
      if (part === "") continue;
      const n = Number(part);
      if (Number.isSafeInteger(n)) uids.push(n);
    }
  }
  return uids;
}

/**
 * Parse the untagged responses of an EXAMINE: UIDVALIDITY (from the
 * `* OK [UIDVALIDITY n] ...` status-response) and the EXISTS count.
 * Throws if UIDVALIDITY is absent.
 */
export function parseExamineResponse(
  untaggedLines: string[],
): { uidValidity: number; exists: number } {
  let uidValidity: number | null = null;
  let exists = 0;
  for (const line of untaggedLines) {
    const uv = line.match(/\[UIDVALIDITY (\d+)\]/);
    if (uv) uidValidity = Number(uv[1]);
    const ex = line.match(/^\* (\d+) EXISTS\b/);
    if (ex) exists = Number(ex[1]);
  }
  if (uidValidity === null) {
    throw new ImapParseError("UIDVALIDITY missing from EXAMINE response");
  }
  return { uidValidity, exists };
}

// Sentinel used to mark where a literal's bytes sit inside a reconstructed
// FETCH response's text. Uses a private-use codepoint that cannot appear in
// protocol text.
const LIT_OPEN = "LIT";
const LIT_CLOSE = "";

interface FetchGroup {
  text: string;
  literals: Uint8Array[];
}

/**
 * Net change in top-level paren depth for one physical line, ignoring parens
 * inside quoted strings (`"..."`) and inside body-section brackets (`[...]`),
 * e.g. the parens in `BODY[HEADER.FIELDS (DATE FROM ...)]`.
 */
function countTopLevelParenDelta(text: string): number {
  let depth = 0;
  let inQuote = false;
  let inBracket = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inQuote = false;
      continue;
    }
    if (inBracket) {
      if (c === "]") inBracket = false;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === "[") inBracket = true;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
  }
  return depth;
}

/**
 * Reconstruct each `* n FETCH (...)` response from the flat token stream. A
 * response may span several physical lines and embed literals; literal bytes
 * are pulled out and replaced by a placeholder in the reconstructed text so the
 * text can be regex-parsed while the raw bytes stay intact.
 */
function groupFetchResponses(tokens: ImapToken[]): FetchGroup[] {
  const groups: FetchGroup[] = [];
  let i = 0;
  while (i < tokens.length) {
    const start = tokens[i];
    if (start.kind !== "line" || !/^\* \d+ FETCH /.test(start.text)) {
      i++;
      continue;
    }
    let text = "";
    const literals: Uint8Array[] = [];
    let depth = 0;
    let done = false;
    while (i < tokens.length && !done) {
      const tok = tokens[i];
      if (tok.kind === "literal") {
        // A literal with no preceding marker on this line: still keep it.
        const idx = literals.length;
        literals.push(tok.bytes);
        text += LIT_OPEN + idx + LIT_CLOSE;
        i++;
        continue;
      }
      let lineText = tok.text;
      const marker = lineText.match(/\{(\d+)\}$/);
      const expectLiteral = marker !== null;
      if (expectLiteral) lineText = lineText.slice(0, marker!.index);
      if (text.length > 0) text += " ";
      if (expectLiteral) {
        text += lineText + LIT_OPEN + literals.length + LIT_CLOSE;
      } else {
        text += lineText;
      }
      depth += countTopLevelParenDelta(lineText);
      i++;
      if (expectLiteral) {
        const lit = tokens[i];
        if (lit && lit.kind === "literal") {
          literals.push(lit.bytes);
          i++;
        }
        continue;
      }
      if (depth <= 0) done = true;
    }
    groups.push({ text, literals });
  }
  return groups;
}

/**
 * Parse the untagged FETCH responses (lines plus captured literals) into one
 * FetchItem per message. Attributes are matched wherever they appear, since the
 * server chooses the order within the parenthesized list.
 */
export function parseFetchSections(tokens: ImapToken[]): FetchItem[] {
  return groupFetchResponses(tokens).map((g) => {
    const seqM = g.text.match(/^\* (\d+) FETCH/);
    const uidM = g.text.match(/\bUID (\d+)/);
    const sizeM = g.text.match(/\bRFC822\.SIZE (\d+)/);
    const dateM = g.text.match(/\bINTERNALDATE "([^"]*)"/);
    // FLAGS is a nested parenthesized list inside the FETCH list; flags are
    // atoms (never contain parens or quotes) so a non-greedy scan to the first
    // ")" is exact. `FLAGS ()` yields [].
    const flagsM = g.text.match(/\bFLAGS \(([^)]*)\)/);
    const flags = flagsM
      ? flagsM[1].split(/\s+/).filter((f) => f.length > 0)
      : null;
    const sections: { name: string; bytes: Uint8Array }[] = [];
    const re = /BODY\[([^\]]*)\]\s*LIT(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(g.text)) !== null) {
      const li = Number(m[2]);
      sections.push({ name: m[1], bytes: g.literals[li] ?? new Uint8Array(0) });
    }
    return {
      seq: seqM ? Number(seqM[1]) : 0,
      uid: uidM ? Number(uidM[1]) : null,
      size: sizeM ? Number(sizeM[1]) : null,
      internalDate: dateM ? dateM[1] : null,
      flags,
      sections,
    };
  });
}

/** Decode bytes as latin1 (byte value == codepoint); safe for protocol lines. */
export function latin1Decode(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

function indexOfCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) return i;
  }
  return -1;
}

/**
 * Pull-based tokenizer. Feed it byte chunks with push(); call next() to pull
 * the next complete token, or null if more bytes are needed. Handles literals
 * that split across chunk boundaries: after a line ending in `{N}` it reads
 * exactly N raw bytes as a literal token before resuming line mode.
 */
export class ImapTokenizer {
  private buf: Uint8Array = new Uint8Array(0);
  private inLiteral = false;
  private need = 0;

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    if (this.buf.length === 0) {
      this.buf = chunk;
      return;
    }
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
  }

  next(): ImapToken | null {
    if (this.inLiteral) {
      if (this.buf.length < this.need) return null;
      const bytes = this.buf.slice(0, this.need);
      this.buf = this.buf.slice(this.need);
      this.inLiteral = false;
      this.need = 0;
      return { kind: "literal", bytes };
    }
    const idx = indexOfCrlf(this.buf);
    if (idx < 0) return null;
    const text = latin1Decode(this.buf.subarray(0, idx));
    this.buf = this.buf.slice(idx + 2);
    const marker = text.match(/\{(\d+)\}$/);
    if (marker) {
      this.inLiteral = true;
      this.need = Number(marker[1]);
    }
    return { kind: "line", text };
  }
}
