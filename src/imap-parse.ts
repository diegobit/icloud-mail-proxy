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
  /** Raw BODYSTRUCTURE text span, or null when absent; parsed lazily by core. */
  bodyStructure: string | null;
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
  /** Raw text of the BODYSTRUCTURE value (balanced `(...)`), or null. */
  bodyStructure: string | null;
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
      bodyStructure: captureBodyStructure(g.text),
    };
  });
}

/**
 * Capture the balanced parenthesized list that follows the `BODYSTRUCTURE `
 * token in a reconstructed FETCH response's text. Parens inside quoted strings
 * (with `\` escapes) are ignored so a filename like `"foo(bar).pdf"` cannot
 * unbalance the scan. Returns null when there is no BODYSTRUCTURE item.
 */
function captureBodyStructure(text: string): string | null {
  const key = "BODYSTRUCTURE ";
  const at = text.indexOf(key);
  if (at < 0) return null;
  let i = at + key.length;
  while (i < text.length && text[i] !== "(") i++;
  if (i >= text.length) return null;
  const start = i;
  let depth = 0;
  let inQuote = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') inQuote = true;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
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

// ---- BODYSTRUCTURE parsing -------------------------------------------------

/**
 * A node in an IMAP parenthesized list: a string (quoted string or atom), null
 * (the `NIL` atom), or a nested list. Number-ish atoms are kept as strings.
 */
export type ImapListNode = string | null | ImapListNode[];

/**
 * Parse the top-level nodes of an IMAP parenthesized-list text. Handles quoted
 * strings (with `\` escapes), bare atoms (`NIL` → null), and nested parens.
 * Literals never appear in the fetch items we parse; any leftover literal
 * sentinel is treated as opaque atom characters.
 */
export function parseImapList(text: string): ImapListNode[] {
  let pos = 0;

  function skipWs(): void {
    while (pos < text.length && (text[pos] === " " || text[pos] === "\t")) pos++;
  }

  function parseQuoted(): string {
    pos++; // opening quote
    let out = "";
    while (pos < text.length) {
      const c = text[pos];
      if (c === "\\") {
        pos++;
        if (pos < text.length) {
          out += text[pos];
          pos++;
        }
        continue;
      }
      if (c === '"') {
        pos++;
        break;
      }
      out += c;
      pos++;
    }
    return out;
  }

  function parseAtom(): string | null {
    const start = pos;
    while (pos < text.length) {
      const c = text[pos];
      if (c === " " || c === "\t" || c === "(" || c === ")" || c === '"') break;
      pos++;
    }
    const atom = text.slice(start, pos);
    return atom.toUpperCase() === "NIL" ? null : atom;
  }

  function parseNodes(): ImapListNode[] {
    const nodes: ImapListNode[] = [];
    for (;;) {
      skipWs();
      if (pos >= text.length) break;
      const c = text[pos];
      if (c === ")") break;
      if (c === "(") {
        pos++; // opening paren
        const inner = parseNodes();
        if (text[pos] === ")") pos++; // closing paren
        nodes.push(inner);
      } else if (c === '"') {
        nodes.push(parseQuoted());
      } else {
        nodes.push(parseAtom());
      }
    }
    return nodes;
  }

  return parseNodes();
}

/** A non-multipart body part. */
export interface BodyPartLeaf {
  type: string;
  subtype: string;
  params: Record<string, string>;
  id: string | null;
  description: string | null;
  encoding: string | null;
  size: number | null;
  disposition: string | null;
  dispositionParams: Record<string, string>;
  partNumber: string;
}

/** A multipart body part (its children carry the leaves). */
export interface BodyPartMultipart {
  multipart: true;
  subtype: string;
  children: BodyPart[];
  partNumber: string;
}

export type BodyPart = BodyPartLeaf | BodyPartMultipart;

function asString(node: ImapListNode | undefined): string {
  return typeof node === "string" ? node : "";
}

function asStringOrNull(node: ImapListNode | undefined): string | null {
  return typeof node === "string" ? node : null;
}

function asNumber(node: ImapListNode | undefined): number | null {
  if (typeof node !== "string") return null;
  const n = Number(node);
  return Number.isSafeInteger(n) ? n : null;
}

/** Parse a `("KEY" "VAL" ...)` parameter list into a map with lowercased keys. */
function parseParamList(node: ImapListNode | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(node)) return out;
  for (let i = 0; i + 1 < node.length; i += 2) {
    const key = node[i];
    const val = node[i + 1];
    if (typeof key === "string" && typeof val === "string") {
      out[key.toLowerCase()] = val;
    }
  }
  return out;
}

/**
 * Parse the body-part list of a BODYSTRUCTURE value into a tree. Part numbers
 * follow RFC 3501: the children of a multipart are numbered 1..n, appended to
 * the parent's number with dots; a non-multipart top-level message is part "1".
 * message/rfc822 is treated as a leaf (no recursion into the embedded body).
 */
export function parseBodyStructure(nodes: ImapListNode[]): BodyPart {
  const rootMultipart = nodes.length > 0 && Array.isArray(nodes[0]);
  return buildBodyPart(nodes, rootMultipart ? "" : "1");
}

function buildBodyPart(list: ImapListNode[], partNumber: string): BodyPart {
  // A multipart's list begins with one or more nested body-part lists, then
  // the media subtype string; a leaf's list begins with the type string.
  if (list.length > 0 && Array.isArray(list[0])) {
    const children: BodyPart[] = [];
    let i = 0;
    while (i < list.length && Array.isArray(list[i])) {
      const n = children.length + 1;
      const childNumber = partNumber === "" ? String(n) : `${partNumber}.${n}`;
      children.push(buildBodyPart(list[i] as ImapListNode[], childNumber));
      i++;
    }
    return { multipart: true, subtype: asString(list[i]), children, partNumber };
  }

  const type = asString(list[0]);
  const subtype = asString(list[1]);
  // The first seven fields (type..size) are common to every non-multipart part.
  // The extension data that carries the disposition sits after any type-specific
  // fields: TEXT adds a line count; MESSAGE/RFC822 adds envelope+body+lines.
  const t = type.toLowerCase();
  const sub = subtype.toLowerCase();
  let extStart = 7;
  if (t === "text") extStart = 8;
  else if (t === "message" && sub === "rfc822") extStart = 10;

  // Extension data order is md5, disposition, language, location.
  let disposition: string | null = null;
  let dispositionParams: Record<string, string> = {};
  const dispNode = list[extStart + 1];
  if (Array.isArray(dispNode)) {
    disposition = asStringOrNull(dispNode[0]);
    dispositionParams = parseParamList(dispNode[1]);
  }

  return {
    type,
    subtype,
    params: parseParamList(list[2]),
    id: asStringOrNull(list[3]),
    description: asStringOrNull(list[4]),
    encoding: asStringOrNull(list[5]),
    size: asNumber(list[6]),
    disposition,
    dispositionParams,
    partNumber,
  };
}

/** One attachment part as enumerated by listAttachments. */
export interface AttachmentPart {
  partNumber: string;
  filename: string | null;
  mimeType: string;
  size: number | null;
}

/**
 * Enumerate the attachment parts of a body-structure tree. A leaf counts as an
 * attachment if its disposition is "attachment" (case-insensitive), or it has a
 * filename (disposition `filename` or content-type `name`) and is not a plain
 * text/plain|text/html body part.
 */
export function listAttachments(root: BodyPart): AttachmentPart[] {
  const out: AttachmentPart[] = [];
  const walk = (part: BodyPart): void => {
    if ("multipart" in part) {
      for (const child of part.children) walk(child);
      return;
    }
    const filename = attachmentFilename(part);
    if (isAttachmentLeaf(part, filename)) {
      out.push({
        partNumber: part.partNumber,
        filename,
        mimeType: `${part.type.toLowerCase()}/${part.subtype.toLowerCase()}`,
        size: part.size,
      });
    }
  };
  walk(root);
  return out;
}

function attachmentFilename(part: BodyPartLeaf): string | null {
  const raw = part.dispositionParams.filename ?? part.params.name ?? null;
  return raw === null ? null : decodeRfc2047(raw);
}

/**
 * The single classification rule for "is this MIME part a real attachment",
 * shared by the BODYSTRUCTURE path (search's hasAttachments, get_mail_attachment
 * indexing) and the full-message path (get_mail_message's attachment list) so
 * the two views always agree: disposition "attachment" counts; otherwise a part
 * must have a filename and not be a text/plain|text/html body. Unnamed inline
 * parts (e.g. newsletter images) are not attachments.
 */
export function isAttachmentPart(
  mimeType: string,
  disposition: string | null,
  filename: string | null,
): boolean {
  if (disposition && disposition.toLowerCase() === "attachment") return true;
  if (filename === null) return false;
  const t = mimeType.toLowerCase();
  return t !== "text/plain" && t !== "text/html";
}

function isAttachmentLeaf(part: BodyPartLeaf, filename: string | null): boolean {
  return isAttachmentPart(
    `${part.type}/${part.subtype}`,
    part.disposition,
    filename,
  );
}

const utf8Decoder = new TextDecoder("utf-8");

/**
 * Decode the common RFC 2047 encoded-word forms `=?utf-8?B?...?=` and
 * `=?utf-8?Q?...?=` (charset utf-8/us-ascii only, case-insensitive). Any word
 * with another charset, or that fails to decode, is left untouched.
 */
export function decodeRfc2047(input: string): string {
  return input.replace(
    /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
    (whole, charset: string, enc: string, data: string) => {
      const cs = charset.toLowerCase();
      if (cs !== "utf-8" && cs !== "us-ascii") return whole;
      try {
        const bytes =
          enc.toUpperCase() === "B" ? base64ToBytes(data) : qDecodeToBytes(data);
        return utf8Decoder.decode(bytes);
      } catch {
        return whole;
      }
    },
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function qDecodeToBytes(s: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "_") {
      bytes.push(0x20);
    } else if (c === "=") {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9A-Fa-f]{2}$/.test(hex)) throw new ImapParseError("bad Q-encoding");
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(c.charCodeAt(0));
    }
  }
  return new Uint8Array(bytes);
}
