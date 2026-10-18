// Composition-level tests for src/send.ts: what the duplicate window hashes,
// and what a draft carries that a submission does not. No network: a plain
// message never fetches anything, and the ledger is not involved.

import { describe, expect, it } from "vitest";
import PostalMime from "postal-mime";
import { composeMessage } from "../src/send";
import type { Env } from "../src/types";

const ENV = {
  ICLOUD_USER: "owner@example.com",
  SEND_MAX_PER_DAY: "20",
  SEND_MAX_RCPTS_PER_DAY: "50",
  SEND_MAX_RCPTS_PER_MESSAGE: "5",
  SEND_MAX_BODY_BYTES: "65536",
} as unknown as Env;

const BASE = { to: ["marco@example.org"], subject: "Pranzo", text: "Ciao" };

describe("composeMessage hashing", () => {
  it("is stable across attempts, which carry a fresh Date and Message-ID", async () => {
    const first = await composeMessage(ENV, BASE);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    const second = await composeMessage(ENV, BASE);
    expect(second.hash).toBe(first.hash);
    expect(second.messageId).not.toBe(first.messageId);
    const firstText = new TextDecoder().decode(first.raw);
    const secondText = new TextDecoder().decode(second.raw);
    expect(firstText).not.toBe(secondText);
  });

  it("keeps the recipient roles apart, so to/cc/bcc are different messages", async () => {
    const variants = await Promise.all([
      composeMessage(ENV, { ...BASE, to: ["a@example.com"], cc: ["b@example.com"] }),
      composeMessage(ENV, { ...BASE, to: ["a@example.com"], bcc: ["b@example.com"] }),
      composeMessage(ENV, { ...BASE, to: ["a@example.com", "b@example.com"] }),
      composeMessage(ENV, { ...BASE, to: ["a@example.com"], cc: ["b@example.com"], text: "Ciao!" }),
    ]);
    const hashes = variants.map((variant) => variant.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("ignores display-name and case differences in addresses", async () => {
    const plain = await composeMessage(ENV, { ...BASE, to: ["marco@example.org"] });
    const decorated = await composeMessage(ENV, { ...BASE, to: ["Marco Rossi <MARCO@example.org>"] });
    expect(decorated.hash).toBe(plain.hash);
  });
});

describe("composeMessage Bcc handling", () => {
  it("never puts Bcc in a submission, but keeps it in a draft", async () => {
    const args = { ...BASE, bcc: ["hidden@example.org"] };
    const submission = await composeMessage(ENV, args);
    const submissionText = new TextDecoder().decode(submission.raw);
    expect(submissionText).not.toContain("Bcc:");
    // The envelope still carries it, which is what the SMTP client uses.
    expect(submission.recipients).toContain("hidden@example.org");

    const draft = await composeMessage(ENV, args, { includeBcc: true });
    const draftText = new TextDecoder().decode(draft.raw);
    expect(draftText).toContain("Bcc: hidden@example.org");
    const parsed = await new PostalMime().parse(draft.raw);
    // A draft has no envelope to fall back on: the header is the only record.
    expect(parsed.to?.map((entry) => entry.address)).toEqual(["marco@example.org"]);
    const reparsed = new TextDecoder().decode(draft.raw);
    expect(reparsed).toContain("hidden@example.org");
  });

  it("validates before serializing anything", async () => {
    await expect(composeMessage(ENV, { ...BASE, to: ["not an address"] })).rejects.toMatchObject({
      code: "invalid_address",
    });
    await expect(composeMessage(ENV, { ...BASE, to: [], text: "x" })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    await expect(composeMessage(ENV, { ...BASE, subject: "ok\r\nBcc: evil@example.com" })).rejects.toMatchObject({
      code: "invalid_value",
    });
    await expect(
      composeMessage(ENV, { ...BASE, to: ["a@example.com"], cc: ["b@example.com"], bcc: ["c@example.com"], text: "x" }),
    ).resolves.toBeTruthy();
    await expect(
      composeMessage(ENV, {
        ...BASE,
        to: Array.from({ length: 6 }, (_, index) => `u${index}@example.com`),
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
  });
});
