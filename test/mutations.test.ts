import { describe, expect, it } from "vitest";
import { mutateMessage } from "../src/core";
import { handleRest } from "../src/rest";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    ICLOUD_USER: "owner@example.com",
    ICLOUD_APP_PASSWORD: "app-pass",
    API_TOKEN: "token",
    ALLOWED_MAILBOXES: "INBOX,Archive,Sent Messages",
    MAX_RESULTS: "20",
    MAX_MESSAGE_BYTES: "3145728",
    MAX_SEARCH_DAYS: "90",
    ALLOWED_ATTACHMENT_TYPES: "application/pdf,image/,text/",
    MAX_ATTACHMENT_BYTES: "2097152",
    ...overrides,
  } as unknown as Env;
}

function post(path: string): Request {
  return new Request(`https://mail.example.com${path}`, { method: "POST" });
}

// Every case below is rejected before any socket is opened, so these tests
// need no IMAP seam: the client-side contract is what they pin down.
describe("mutateMessage", () => {
  it("rejects a source mailbox outside ALLOWED_MAILBOXES", async () => {
    await expect(mutateMessage(makeEnv(), "archive", "Trash", 1, 1)).rejects.toMatchObject({
      status: 400,
      code: "mailbox_not_allowed",
    });
  });

  it("rejects an invalid uidValidity or uid", async () => {
    await expect(mutateMessage(makeEnv(), "archive", "INBOX", 0, 1)).rejects.toMatchObject({
      status: 400,
      code: "invalid_uidvalidity",
    });
    await expect(mutateMessage(makeEnv(), "archive", "INBOX", 1, 0)).rejects.toMatchObject({
      status: 400,
      code: "invalid_uid",
    });
    await expect(mutateMessage(makeEnv(), "trash", "INBOX", 1.5, 1)).rejects.toMatchObject({
      status: 400,
      code: "invalid_uidvalidity",
    });
  });

  it("refuses to archive a message that is already in the archive", async () => {
    await expect(mutateMessage(makeEnv(), "archive", "Archive", 1, 42)).rejects.toMatchObject({
      status: 400,
      code: "destination_is_source",
    });
  });

  it("refuses to trash a message that is already in the configured trash", async () => {
    const env = makeEnv({ ALLOWED_MAILBOXES: "INBOX,Deleted Messages" });
    await expect(mutateMessage(env, "trash", "Deleted Messages", 1, 42)).rejects.toMatchObject({
      status: 400,
      code: "destination_is_source",
    });
  });

  it("takes the destination from config, never from the caller", async () => {
    const env = makeEnv({ ALLOWED_ARCHIVE_MAILBOX: "INBOX" });
    await expect(mutateMessage(env, "archive", "INBOX", 1, 42)).rejects.toMatchObject({
      status: 400,
      code: "destination_is_source",
    });
  });

  it("treats a blank destination as unset and falls back to the default", async () => {
    const env = makeEnv({ ALLOWED_ARCHIVE_MAILBOX: "   " });
    // Falls back to "Archive", so archiving from INBOX is not a self-move; the
    // next step would open IMAP, which this Node test must not do.
    await expect(mutateMessage(env, "archive", "INBOX", 1, 42)).rejects.not.toMatchObject({
      code: "destination_is_source",
    });
  });

  it("rejects a destination that is not a valid IMAP mailbox name", async () => {
    const env = makeEnv({ ALLOWED_TRASH_MAILBOX: "Deleted\nMessages" });
    await expect(mutateMessage(env, "trash", "INBOX", 1, 42)).rejects.toMatchObject({
      status: 500,
      code: "invalid_mutation_destination",
    });
  });

  it("restores only from the archive or the configured trash", async () => {
    const env = makeEnv();
    await expect(mutateMessage(env, "restore", "INBOX", 1, 42)).rejects.toMatchObject({
      status: 400,
      code: "restore_source_not_allowed",
    });
    // In ALLOWED_MAILBOXES, but not one of the two folders this server files
    // into, so it is not a restore source either.
    await expect(mutateMessage(env, "restore", "Sent Messages", 1, 42)).rejects.toMatchObject({
      status: 400,
      code: "restore_source_not_allowed",
    });
  });

  it("accepts the trash as a restore source even when it is not readable", async () => {
    const env = makeEnv({ ALLOWED_MAILBOXES: "INBOX,Archive" });
    // Past the source check the next rejection is the uid: opening IMAP is
    // what this Node test must avoid, not what it is asserting.
    await expect(mutateMessage(env, "restore", "Deleted Messages", 1, 0)).rejects.toMatchObject({
      status: 400,
      code: "invalid_uid",
    });
  });

  it("refuses a restore whose source is also the destination", async () => {
    const env = makeEnv({ ALLOWED_ARCHIVE_MAILBOX: "INBOX" });
    await expect(mutateMessage(env, "restore", "INBOX", 1, 42)).rejects.toMatchObject({
      status: 400,
      code: "destination_is_source",
    });
  });
});

describe("mutation routes", () => {
  it("accepts only POST on the archive/trash paths", async () => {
    const url = new URL("https://mail.example.com/v1/messages/INBOX/1/1/archive");
    const response = await handleRest(new Request(url, { method: "GET" }), makeEnv());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("rejects non-integer uidValidity/uid in the path", async () => {
    const response = await handleRest(post("/v1/messages/INBOX/x/1/trash"), makeEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request" } });
  });

  it("rejects a zero uid through the core's client-side validation", async () => {
    const response = await handleRest(post("/v1/messages/INBOX/1/0/trash"), makeEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_uid" } });
  });

  it("enforces the mailbox allowlist", async () => {
    const response = await handleRest(post("/v1/messages/Trash/1/1/trash"), makeEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "mailbox_not_allowed" } });
  });

  it("reports a self-move instead of touching the mailbox", async () => {
    const env = makeEnv({ ALLOWED_ARCHIVE_MAILBOX: "INBOX" });
    const response = await handleRest(post("/v1/messages/INBOX/1/1/archive"), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "destination_is_source" } });
  });

  it("does not treat an unknown trailing segment as a mutation", async () => {
    const response = await handleRest(post("/v1/messages/INBOX/1/1/frobnicate"), makeEnv());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("routes the restore path to the same handler", async () => {
    const response = await handleRest(post("/v1/messages/Archive/1/0/restore"), makeEnv());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_uid" } });
  });
});
