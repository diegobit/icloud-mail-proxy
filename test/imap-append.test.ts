import { describe, expect, it } from "vitest";
import { buildAppend } from "../src/imap-append";
import { ImapParseError } from "../src/imap-parse";

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

describe("buildAppend", () => {
  it("frames a literal with a quoted mailbox and flags", () => {
    expect(buildAppend("Drafts", ["\\Draft"], bytes)).toBe('APPEND "Drafts" (\\Draft) {5}\r\n');
    expect(buildAppend("Sent Messages", ["\\Seen"], bytes)).toBe('APPEND "Sent Messages" (\\Seen) {5}\r\n');
  });

  it("omits an empty flag list", () => {
    expect(buildAppend("Drafts", [], bytes)).toBe('APPEND "Drafts" {5}\r\n');
  });

  it("escapes quotes and backslashes in the mailbox name", () => {
    expect(buildAppend('We"ird\\', ["\\Draft"], bytes)).toBe('APPEND "We\\"ird\\\\" (\\Draft) {5}\r\n');
  });

  it("rejects flags the proxy does not issue, empty payloads and CRLF in names", () => {
    expect(() => buildAppend("Drafts", ["\\Custom"], bytes)).toThrow(ImapParseError);
    expect(() => buildAppend("Drafts", ["Draft"], bytes)).toThrow(ImapParseError);
    expect(() => buildAppend("Drafts", [], new Uint8Array(0))).toThrow(ImapParseError);
    expect(() => buildAppend("Dra\nfts", ["\\Draft"], bytes)).toThrow(ImapParseError);
    expect(() => buildAppend("Dra\u0000fts", ["\\Draft"], bytes)).toThrow(ImapParseError);
  });
});
