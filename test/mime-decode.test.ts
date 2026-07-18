import { describe, it, expect } from "vitest";
import { ImapParseError } from "../src/imap-parse";
import { decodeTransferEncoding } from "../src/mime-decode";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** base64 of a string's UTF-8 bytes (with standard padding). */
function b64(s: string): string {
  const bytes = enc.encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("decodeTransferEncoding: base64", () => {
  it("decodes a simple base64 string", () => {
    const out = decodeTransferEncoding(enc.encode(b64("Hello, world!")), "base64");
    expect(dec.decode(out)).toBe("Hello, world!");
  });

  it("is case-insensitive on the encoding name", () => {
    const out = decodeTransferEncoding(enc.encode(b64("hi")), "BASE64");
    expect(dec.decode(out)).toBe("hi");
  });

  it("ignores CRLF line wrapping", () => {
    const wrapped = b64("The quick brown fox jumps over the lazy dog").replace(
      /(.{8})/g,
      "$1\r\n",
    );
    const out = decodeTransferEncoding(enc.encode(wrapped), "base64");
    expect(dec.decode(out)).toBe("The quick brown fox jumps over the lazy dog");
  });

  it("ignores bare LF and spaces/tabs between chars", () => {
    const raw = b64("padded");
    const spaced = raw.split("").join(" ").replace(/ /g, (_m, i) => (i % 3 === 0 ? "\n" : " "));
    const out = decodeTransferEncoding(enc.encode(spaced), "base64");
    expect(dec.decode(out)).toBe("padded");
  });

  it("tolerates missing padding (2-sextet tail -> 1 byte)", () => {
    // "M" -> "TQ==" normally; without padding it is "TQ".
    const out = decodeTransferEncoding(enc.encode("TQ"), "base64");
    expect(dec.decode(out)).toBe("M");
  });

  it("tolerates missing padding (3-sextet tail -> 2 bytes)", () => {
    // "Ma" -> "TWE=" normally; without padding it is "TWE".
    const out = decodeTransferEncoding(enc.encode("TWE"), "base64");
    expect(dec.decode(out)).toBe("Ma");
  });

  it("decodes binary bytes exactly", () => {
    const bytes = new Uint8Array([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f]);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const out = decodeTransferEncoding(enc.encode(btoa(bin)), "base64");
    expect(Array.from(out)).toEqual([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x7f]);
  });

  it("throws ImapParseError on invalid characters", () => {
    expect(() => decodeTransferEncoding(enc.encode("not*base64!"), "base64")).toThrow(
      ImapParseError,
    );
  });

  it("throws ImapParseError on a truncated single-sextet tail", () => {
    // 5 alphabet chars: one full group of 4 plus a stray sextet.
    expect(() => decodeTransferEncoding(enc.encode("TWFuX"), "base64")).toThrow(
      ImapParseError,
    );
  });
});

describe("decodeTransferEncoding: quoted-printable", () => {
  it("decodes =XX hex escapes", () => {
    const out = decodeTransferEncoding(enc.encode("caf=C3=A9"), "quoted-printable");
    expect(dec.decode(out)).toBe("café");
  });

  it("decodes =3D as an equals sign", () => {
    const out = decodeTransferEncoding(enc.encode("a=3Db"), "quoted-printable");
    expect(dec.decode(out)).toBe("a=b");
  });

  it("removes CRLF soft line breaks", () => {
    const out = decodeTransferEncoding(
      enc.encode("the lazy=\r\n dog"),
      "quoted-printable",
    );
    expect(dec.decode(out)).toBe("the lazy dog");
  });

  it("removes bare LF soft line breaks", () => {
    const out = decodeTransferEncoding(enc.encode("the lazy=\n dog"), "quoted-printable");
    expect(dec.decode(out)).toBe("the lazy dog");
  });

  it("handles a trailing soft break at end of input", () => {
    const out = decodeTransferEncoding(enc.encode("tail=\r\n"), "quoted-printable");
    expect(dec.decode(out)).toBe("tail");
  });

  it("is lenient: passes invalid = sequences through literally", () => {
    // "=" not followed by two hex digits or a line break is kept verbatim.
    const out = decodeTransferEncoding(enc.encode("a=Zb and 3=4"), "quoted-printable");
    expect(dec.decode(out)).toBe("a=Zb and 3=4");
  });

  it("passes a lone trailing = through", () => {
    const out = decodeTransferEncoding(enc.encode("value="), "quoted-printable");
    expect(dec.decode(out)).toBe("value=");
  });

  it("passes ordinary bytes through unchanged", () => {
    const out = decodeTransferEncoding(enc.encode("plain text 123"), "quoted-printable");
    expect(dec.decode(out)).toBe("plain text 123");
  });
});

describe("decodeTransferEncoding: passthrough encodings", () => {
  const bytes = new Uint8Array([0x00, 0x41, 0xff, 0x0a]);

  it("returns bytes unchanged for 7bit / 8bit / binary", () => {
    for (const e of ["7bit", "8bit", "binary", "7BIT", "Binary"]) {
      expect(Array.from(decodeTransferEncoding(bytes, e))).toEqual(Array.from(bytes));
    }
  });

  it("returns bytes unchanged for null and unknown encodings", () => {
    expect(Array.from(decodeTransferEncoding(bytes, null))).toEqual(Array.from(bytes));
    expect(Array.from(decodeTransferEncoding(bytes, "x-uuencode"))).toEqual(
      Array.from(bytes),
    );
  });
});
