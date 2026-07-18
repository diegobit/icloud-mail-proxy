import { describe, expect, it } from "vitest";
import { isAttachmentPart } from "../src/imap-parse";

// The one rule both views share: search's hasAttachments / get_mail_attachment
// (BODYSTRUCTURE path) and get_mail_message's list (postal-mime path).
describe("isAttachmentPart", () => {
  it("counts an explicit attachment disposition, filename or not", () => {
    expect(isAttachmentPart("application/pdf", "attachment", "a.pdf")).toBe(true);
    expect(isAttachmentPart("application/pdf", "attachment", null)).toBe(true);
    expect(isAttachmentPart("text/plain", "attachment", "notes.txt")).toBe(true);
    expect(isAttachmentPart("image/png", "ATTACHMENT", null)).toBe(true);
  });

  it("counts named non-body parts without a disposition", () => {
    expect(isAttachmentPart("application/pdf", null, "invoice.pdf")).toBe(true);
    expect(isAttachmentPart("image/png", "inline", "photo.png")).toBe(true);
    expect(isAttachmentPart("application/zip", "INLINE", "data.zip")).toBe(true);
  });

  it("rejects unnamed inline parts (newsletter images)", () => {
    expect(isAttachmentPart("image/png", "inline", null)).toBe(false);
    expect(isAttachmentPart("image/gif", null, null)).toBe(false);
  });

  it("keeps named text/plain and text/html parts as body, not attachments", () => {
    expect(isAttachmentPart("text/plain", null, "message.txt")).toBe(false);
    expect(isAttachmentPart("text/html", "inline", "message.html")).toBe(false);
    expect(isAttachmentPart("TEXT/HTML", null, "message.html")).toBe(false);
  });
});
