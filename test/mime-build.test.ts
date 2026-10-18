import { describe, expect, it } from "vitest";
import {
  buildMessage,
  buildReferences,
  defaultForwardSubject,
  defaultReplySubject,
  encodeSubject,
  encodeWords,
  forwardQuote,
  isValidAddress,
  isMessageId,
  normalizeCrlf,
  parseMailbox,
  quotedPrintable,
  rfc5322Date,
  sanitizeDerivedHeader,
  splitReferences,
  truncateUtf8,
  utf8Length,
  MimeBuildError,
} from "../src/mime-build";

describe("isValidAddress", () => {
  it("accepts strict ASCII addr-specs", () => {
    for (const address of [
      "a@b.co",
      "first.last@example.com",
      "user+tag@sub.example.co.uk",
      "UPPER.Case@Example.COM",
      "a1!#$%&'*+/=?^_`{|}~-b@example.org",
    ]) {
      expect(isValidAddress(address), address).toBe(true);
    }
  });

  it("rejects everything the grammar cannot represent", () => {
    for (const address of [
      "",
      "no-at-sign",
      "two@@example.com",
      "a@b",
      "a@localhost",
      "a@-example.com",
      "a@example-.com",
      "a@exa_mple.com",
      "a@example.c0m",
      "a@[127.0.0.1]",
      "a@example.com ",
      " a@example.com",
      "a..b@example.com",
      ".a@example.com",
      "a.@example.com",
      '"quoted"@example.com',
      "näme@example.com",
      "a@exämple.com",
      `${"a".repeat(65)}@example.com`,
      `${"a".repeat(60)}@${"b".repeat(200)}.com`,
      "a@example.com\nBcc: evil@example.com",
    ]) {
      expect(isValidAddress(address), JSON.stringify(address)).toBe(false);
    }
  });
});

describe("parseMailbox", () => {
  it("parses bare addresses and Name <addr> forms", () => {
    expect(parseMailbox("a@b.co")).toEqual({ name: null, address: "a@b.co" });
    expect(parseMailbox("Marco Rossi <marco@example.com>")).toEqual({
      name: "Marco Rossi",
      address: "marco@example.com",
    });
    expect(parseMailbox('"Already Quoted" <q@example.com>')).toEqual({
      name: '"Already Quoted"',
      address: "q@example.com",
    });
  });

  it("rejects control characters anywhere in the input", () => {
    for (const input of ["a@b.co\r\nBcc: x@y.co", "Na\nme <a@b.co>", "a@b.co\u0000"]) {
      expect(() => parseMailbox(input), JSON.stringify(input)).toThrow(MimeBuildError);
    }
  });

  it("rejects malformed or non-ASCII addresses", () => {
    expect(() => parseMailbox("näme@example.com")).toThrow(MimeBuildError);
    expect(() => parseMailbox("<a@b.co")).toThrow(MimeBuildError);
    expect(() => parseMailbox("a@b")).toThrow(MimeBuildError);
  });

  it("keeps hostile display names as data, never as markup", () => {
    const mailbox = parseMailbox('"><script>alert(1)</script>" <a@b.co>');
    expect(mailbox.name).toContain("<script>");
    expect(mailbox.address).toBe("a@b.co");
  });
});

function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

describe("encodeWords", () => {
  it("encodes each word as short base64 and never splits a code point", () => {
    const value = "caffè 🚀 pranzo 😀😀😀 e Unicode: àèìòù ".repeat(3);
    const encoded = encodeWords(value);
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) {
      expect(word.length).toBeLessThanOrEqual(75);
      expect(word).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/]+=*\?=$/);
    }
    const decoded = words
      .map((word) => decodeBase64Utf8(word.slice("=?UTF-8?B?".length, -2)))
      .join("");
    expect(decoded).toBe(value);
  });

  it("encodes an empty string as an empty word", () => {
    expect(encodeWords("")).toBe("=?UTF-8?B??=");
  });
});

describe("encodeSubject", () => {
  it("keeps short ASCII subjects readable", () => {
    expect(encodeSubject("Pranzo domani")).toBe("Pranzo domani");
  });

  it("encodes non-ASCII, long or tabbed subjects", () => {
    expect(encodeSubject("Caffè")).toContain("=?UTF-8?B?");
    expect(encodeSubject("a".repeat(80))).toContain("=?UTF-8?B?");
    expect(encodeSubject("tab\there")).toContain("=?UTF-8?B?");
  });

  it("rejects header breaks and over-long subjects", () => {
    expect(() => encodeSubject("ok\r\nBcc: evil@example.com")).toThrow(MimeBuildError);
    expect(() => encodeSubject("x".repeat(201))).toThrow(MimeBuildError);
    expect(() => encodeSubject("nul\u0000")).toThrow(MimeBuildError);
  });
});

describe("message ids and references", () => {
  it("accepts only the strict angle-bracket grammar", () => {
    expect(isMessageId("<abc@example.com>")).toBe(true);
    expect(isMessageId("<a.b-c_d@example.com>")).toBe(true);
    for (const value of ["abc@example.com", "<a b@c>", "<a>b>", "<a\r\nb>", "<>", 42, null]) {
      expect(isMessageId(value), String(value)).toBe(false);
    }
  });

  it("splits a References header and drops invalid ids", () => {
    expect(splitReferences("<a@x> <bad id> <b@y>\r\n <c@z>")).toEqual(["<a@x>", "<b@y>", "<c@z>"]);
    expect(splitReferences(null)).toEqual([]);
  });

  it("builds references with the parent id, trimmed to first + last 9", () => {
    expect(buildReferences([], "<p@x>")).toEqual(["<p@x>"]);
    expect(buildReferences(["<a@x>"], "<p@x>")).toEqual(["<a@x>", "<p@x>"]);
    expect(buildReferences(["<a@x>"], "<a@x>")).toEqual(["<a@x>"]);
    const many = Array.from({ length: 12 }, (_, i) => `<m${i}@x>`);
    const built = buildReferences(many, "<p@x>");
    expect(built).toHaveLength(10);
    expect(built[0]).toBe("<m0@x>");
    expect(built[built.length - 1]).toBe("<p@x>");
  });
});

describe("normalizeCrlf and quotedPrintable", () => {
  it("normalizes lone CR and LF to CRLF", () => {
    expect(normalizeCrlf("a\nb\rc\r\nd")).toBe("a\r\nb\r\nc\r\nd");
  });

  it("encodes specials, non-ASCII bytes and trailing whitespace", () => {
    expect(quotedPrintable("hello")).toBe("hello");
    expect(quotedPrintable("a=b")).toBe("a=3Db");
    expect(quotedPrintable("a \r\nb")).toBe("a=20\r\nb");
    expect(quotedPrintable("a\t\r\nb")).toBe("a=09\r\nb");
    expect(quotedPrintable("caffè")).toBe("caff=C3=A8");
    expect(quotedPrintable("line\r\n.\r\nend")).toBe("line\r\n.\r\nend");
  });

  it("soft-wraps long lines to at most 76 characters", () => {
    const encoded = quotedPrintable("x".repeat(200));
    for (const line of encoded.split("\r\n")) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(encoded).toContain("=\r\n");
  });
});

describe("rfc5322Date", () => {
  it("formats a UTC date-time", () => {
    expect(rfc5322Date(new Date("2026-10-18T14:03:00Z"))).toBe("Sun, 18 Oct 2026 14:03:00 +0000");
  });
});

describe("sanitizeDerivedHeader", () => {
  it("collapses controls from fetched values instead of failing", () => {
    expect(sanitizeDerivedHeader("Re: q3\r\nBcc: evil@x.co")).toBe("Re: q3 Bcc: evil@x.co");
    expect(sanitizeDerivedHeader("   ")).toBeNull();
    expect(sanitizeDerivedHeader(null)).toBeNull();
    expect(sanitizeDerivedHeader("x".repeat(500))?.length).toBe(200);
  });
});

describe("subject defaults", () => {
  it("does not double Re: and Fwd:", () => {
    expect(defaultReplySubject("Piano")).toBe("Re: Piano");
    expect(defaultReplySubject("RE: Piano")).toBe("RE: Piano");
    expect(defaultReplySubject(null)).toBe("Re:");
    expect(defaultForwardSubject("Piano")).toBe("Fwd: Piano");
    expect(defaultForwardSubject("FWD: Piano")).toBe("FWD: Piano");
  });
});

describe("truncateUtf8", () => {
  it("never exceeds the cap and never splits a code point", () => {
    const text = "€".repeat(10);
    const out = truncateUtf8(text, 20);
    expect(utf8Length(out)).toBeLessThanOrEqual(20);
    expect(out.endsWith("[truncated]")).toBe(true);
    expect(out).toBe("€€\n[truncated]");
  });

  it("returns short text untouched and handles tiny caps", () => {
    expect(truncateUtf8("abc", 10)).toBe("abc");
    expect(utf8Length(truncateUtf8("abcdef", 3))).toBeLessThanOrEqual(3);
  });
});

describe("buildMessage", () => {
  const base = {
    from: { name: "Diego", address: "diego@example.com" },
    to: [{ name: "Marco", address: "marco@example.org" }],
    cc: [],
    bcc: [],
    subject: "Pranzo",
    text: "Ciao, ci vediamo venerdì.",
    date: new Date("2026-10-18T14:03:00Z"),
    messageId: "<11111111-2222-3333-4444-555555555555@example.com>",
    maxBodyBytes: 65_536,
  };

  it("serializes a complete 7-bit message with no Bcc header", () => {
    const built = buildMessage({
      ...base,
      cc: [{ name: "Anna", address: "anna@example.net" }],
      bcc: [{ name: null, address: "hidden@example.org" }],
    });
    const text = new TextDecoder().decode(built.raw);
    expect(text).toBe(
      "From: \"Diego\" <diego@example.com>\r\n" +
        "To: \"Marco\" <marco@example.org>\r\n" +
        "Cc: \"Anna\" <anna@example.net>\r\n" +
        "Subject: Pranzo\r\n" +
        "Date: Sun, 18 Oct 2026 14:03:00 +0000\r\n" +
        "Message-ID: <11111111-2222-3333-4444-555555555555@example.com>\r\n" +
        "MIME-Version: 1.0\r\n" +
        "Content-Type: text/plain; charset=utf-8\r\n" +
        "Content-Transfer-Encoding: quoted-printable\r\n" +
        "\r\n" +
        "Ciao, ci vediamo venerd=C3=AC.\r\n",
    );
    expect(text).not.toContain("Bcc:");
    // Every envelope recipient is present, deduplicated, including the Bcc one.
    expect(built.recipients).toEqual(["marco@example.org", "anna@example.net", "hidden@example.org"]);
    expect(built.envelopeFrom).toBe("diego@example.com");
    for (const byte of built.raw) expect(byte).toBeLessThanOrEqual(0x7f);
  });

  it("deduplicates recipients case-insensitively, keeping the first spelling", () => {
    const built = buildMessage({
      ...base,
      to: [{ name: null, address: "A@Example.com" }],
      cc: [{ name: null, address: "a@example.com" }],
      bcc: [{ name: null, address: "b@example.com" }],
    });
    expect(built.recipients).toEqual(["A@Example.com", "b@example.com"]);
  });

  it("adds threading headers for replies from a hostile parent", () => {
    const built = buildMessage({
      ...base,
      subject: "Re: Piano",
      inReplyTo: "<parent@example.com>",
      references: ["<old@example.com>", "<bad id>", "<parent2@example.com>"],
    });
    const text = new TextDecoder().decode(built.raw);
    expect(text).toContain("In-Reply-To: <parent@example.com>\r\n");
    expect(text).toContain("References: <old@example.com> <parent2@example.com> <parent@example.com>\r\n");
  });

  it("drops an invalid parent id instead of failing the reply", () => {
    const built = buildMessage({ ...base, inReplyTo: "<bad\r\nid>", references: ["<bad id>"] });
    const text = new TextDecoder().decode(built.raw);
    expect(text).not.toContain("In-Reply-To:");
    expect(text).not.toContain("References:");
  });

  it("encodes a Unicode subject and normalizes the body", () => {
    const built = buildMessage({ ...base, subject: "Caffè ☕", text: "riga1\nriga2" });
    const text = new TextDecoder().decode(built.raw);
    expect(text).toContain("Subject: =?UTF-8?B?");
    expect(text).toContain("riga1\r\nriga2\r\n");
    expect(built.text).toBe("riga1\r\nriga2");
  });

  it("rejects NUL, empty and oversized bodies", () => {
    expect(() => buildMessage({ ...base, text: "a\u0000b" })).toThrow(MimeBuildError);
    expect(() => buildMessage({ ...base, text: "" })).toThrow(MimeBuildError);
    expect(() => buildMessage({ ...base, text: "x".repeat(100), maxBodyBytes: 10 })).toThrow(MimeBuildError);
  });

  it("rejects malformed recipients and senders", () => {
    expect(() => buildMessage({ ...base, to: [{ name: null, address: "not-an-address" }] })).toThrow(MimeBuildError);
    expect(() => buildMessage({ ...base, from: { name: null, address: "bad" } })).toThrow(MimeBuildError);
    expect(() => buildMessage({ ...base, to: [] })).toThrow(MimeBuildError);
  });
});

describe("forwardQuote", () => {
  it("builds the quoted block and collapses hostile header values", () => {
    const quote = forwardQuote(
      { from: "Marco <marco@example.org>", date: "Sun, 18 Oct 2026 12:00:00 +0000", subject: "Q3\r\nBcc: evil@x.co" },
      "corpo originale",
    );
    expect(quote).toContain("---------- Forwarded message ----------");
    expect(quote).toContain("From: Marco <marco@example.org>");
    expect(quote).toContain("Subject: Q3 Bcc: evil@x.co");
    expect(quote).toContain("corpo originale");
    expect(quote.split("\r\n")[3]).toBe("Subject: Q3 Bcc: evil@x.co");
  });
});
