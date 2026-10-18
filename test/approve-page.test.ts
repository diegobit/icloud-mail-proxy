import { describe, expect, it } from "vitest";
import { approveDraftPage, approveLoginPage, approveResultPage } from "../src/approve-page";
import type { DraftView } from "../src/send-ledger-core";

const NOW = Date.now();

const VIEW: DraftView = {
  id: "draft-1234567890",
  status: "ready",
  createdAt: NOW,
  updatedAt: NOW,
  expiresAt: NOW + 3_600_000,
  from: { name: "Diego", address: "diego@example.com" },
  to: ["Marco <marco@example.org>"],
  cc: [],
  bcc: ["hidden@example.org"],
  subject: "Pranzo venerdì",
  dateIso: new Date(NOW).toISOString(),
  messageId: "<m@example.com>",
  text: "Ciao,\r\nci vediamo venerdì.",
  textBytes: 26,
  recipientCount: 2,
};

describe("approveLoginPage", () => {
  it("asks for the API token and carries only the draft id", () => {
    const html = approveLoginPage({ draftId: VIEW.id });
    expect(html).toContain("Approve a draft");
    expect(html).toContain('method="post" action="/send/approve"');
    expect(html).toContain(`name="d" value="${VIEW.id}"`);
    expect(html).toContain('name="action" value="login"');
    expect(html).toContain('type="password"');
  });

  it("shows the error and escapes hostile ids", () => {
    const html = approveLoginPage({ draftId: `"><script>alert(1)</script>`, error: `<b>nope</b>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;b&gt;nope&lt;/b&gt;");
  });
});

describe("approveDraftPage", () => {
  it("renders the exact recipient list, subject and body with the three actions", () => {
    const html = approveDraftPage({ view: VIEW, nonce: "nonce-1" });
    expect(html).toContain("Send this draft?");
    expect(html).toContain("To: Marco &lt;marco@example.org&gt;");
    expect(html).toContain("Bcc: hidden@example.org");
    expect(html).toContain("Subject: Pranzo venerdì");
    expect(html).toContain("ci vediamo venerdì.");
    expect(html).toContain('name="nonce" value="nonce-1"');
    for (const action of ["send", "save", "discard"]) {
      expect(html).toContain(`name="action" value="${action}"`);
    }
  });

  it("escapes hostile draft content everywhere", () => {
    const html = approveDraftPage({
      view: {
        ...VIEW,
        subject: `"><script>alert(1)</script>`,
        text: `<img src=x onerror=alert(2)>`,
        to: [`"><b>evil</b> <e@example.org>`],
      },
      nonce: `"><script>`,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>evil</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(2)&gt;");
  });

  it("offers no actions once the draft is not sendable", () => {
    for (const view of [
      { ...VIEW, status: "sent" as const },
      { ...VIEW, status: "ready" as const, expiresAt: NOW - 1_000 },
    ]) {
      const html = approveDraftPage({ view, nonce: "nonce-1" });
      expect(html).not.toContain('name="action" value="send"');
      expect(html).not.toContain('name="action" value="save"');
      expect(html).not.toContain('name="action" value="discard"');
    }
    expect(approveDraftPage({ view: { ...VIEW, status: "sent" }, nonce: "n" })).toContain("can no longer be sent");
    expect(approveDraftPage({ view: { ...VIEW, expiresAt: NOW - 1_000 }, nonce: "n" })).toContain("expired");
  });

  it("shows a notice when one is passed", () => {
    const html = approveDraftPage({ view: VIEW, nonce: "n", notice: "<b>retry</b>" });
    expect(html).toContain("&lt;b&gt;retry&lt;/b&gt;");
  });
});

describe("approveResultPage", () => {
  it("escapes the title and message and links back to the draft", () => {
    const html = approveResultPage({
      title: "Message sent",
      message: "accepted <b>ok</b>",
      draftId: VIEW.id,
    });
    expect(html).toContain("Message sent");
    expect(html).toContain("accepted &lt;b&gt;ok&lt;/b&gt;");
    expect(html).toContain(`href="/send/approve?d=${VIEW.id}"`);
  });

  it("omits the back link without a draft id", () => {
    expect(approveResultPage({ title: "x", message: "y" })).not.toContain("Back to the draft");
  });
});
