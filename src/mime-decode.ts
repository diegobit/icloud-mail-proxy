// Content-Transfer-Encoding decoders for attachment bodies.
//
// Pure logic: this file must NOT import from "cloudflare:sockets" (or any
// Workers-only module) so it can be unit-tested directly under Node/vitest.

import { ImapParseError } from "./imap-parse";

// base64 alphabet -> 6-bit value; -1 for everything else.
const B64_VALUE = new Int16Array(256).fill(-1);
{
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  for (let i = 0; i < alphabet.length; i++) {
    B64_VALUE[alphabet.charCodeAt(i)] = i;
  }
}

function isAsciiWhitespace(byte: number): boolean {
  // space, tab, CR, LF, form-feed, vertical-tab
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0d ||
    byte === 0x0a ||
    byte === 0x0c ||
    byte === 0x0b
  );
}

function isHexDigit(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x46) || // A-F
    (byte >= 0x61 && byte <= 0x66) // a-f
  );
}

function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return byte - 0x61 + 10; // a-f
}

/**
 * Decode a base64 byte stream. ASCII whitespace/CRLF and `=` padding are
 * skipped, so line-wrapped base64 and streams with missing padding both decode
 * (the byte length is derived from the sextet count, not the padding). Any
 * other non-alphabet byte is a hard error. Throws ImapParseError on failure.
 */
function decodeBase64(bytes: Uint8Array): Uint8Array {
  // Collect the 6-bit values, skipping whitespace and padding.
  const sextets: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (isAsciiWhitespace(b) || b === 0x3d /* = */) continue;
    const v = B64_VALUE[b];
    if (v < 0) {
      throw new ImapParseError("invalid base64 character in attachment body");
    }
    sextets.push(v);
  }
  // 4 sextets -> 3 bytes; a trailing group of 2 sextets -> 1 byte, 3 -> 2
  // bytes. A trailing single sextet carries no full byte and is malformed.
  const full = sextets.length >> 2;
  const rem = sextets.length & 3;
  if (rem === 1) {
    throw new ImapParseError("truncated base64 group in attachment body");
  }
  const outLen = full * 3 + (rem === 0 ? 0 : rem - 1);
  const out = new Uint8Array(outLen);
  let o = 0;
  let s = 0;
  for (let g = 0; g < full; g++) {
    const n = (sextets[s] << 18) | (sextets[s + 1] << 12) | (sextets[s + 2] << 6) | sextets[s + 3];
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
    s += 4;
  }
  if (rem === 2) {
    const n = (sextets[s] << 18) | (sextets[s + 1] << 12);
    out[o++] = (n >> 16) & 0xff;
  } else if (rem === 3) {
    const n = (sextets[s] << 18) | (sextets[s + 1] << 12) | (sextets[s + 2] << 6);
    out[o++] = (n >> 16) & 0xff;
    out[o++] = (n >> 8) & 0xff;
  }
  return out;
}

/**
 * Decode a quoted-printable body. `=XX` hex escapes become their byte value;
 * soft line breaks (`=\r\n` and `=\n`) are removed; every other byte passes
 * through. Invalid `=` sequences are passed through literally (lenient — this
 * is body QP, not the stricter RFC 2047 word encoding).
 */
function decodeQuotedPrintable(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b !== 0x3d /* = */) {
      out.push(b);
      continue;
    }
    const n1 = bytes[i + 1];
    const n2 = bytes[i + 2];
    if (n1 === 0x0d && n2 === 0x0a) {
      i += 2; // soft break: =CRLF
    } else if (n1 === 0x0a) {
      i += 1; // soft break: =LF
    } else if (n1 !== undefined && n2 !== undefined && isHexDigit(n1) && isHexDigit(n2)) {
      out.push((hexValue(n1) << 4) | hexValue(n2));
      i += 2;
    } else {
      out.push(b); // lenient: pass a lone/invalid '=' through
    }
  }
  return new Uint8Array(out);
}

/**
 * Decode attachment bytes according to their Content-Transfer-Encoding.
 * "base64" and "quoted-printable" are decoded (case-insensitively); "7bit",
 * "8bit", "binary", null and any unknown token return the bytes unchanged.
 * Throws ImapParseError when base64 content cannot be decoded.
 */
export function decodeTransferEncoding(
  bytes: Uint8Array,
  encoding: string | null,
): Uint8Array {
  const enc = (encoding ?? "").trim().toLowerCase();
  if (enc === "base64") return decodeBase64(bytes);
  if (enc === "quoted-printable") return decodeQuotedPrintable(bytes);
  return bytes;
}
