import { afterEach, describe, expect, it, vi } from "vitest";
import { markMessageRead } from "../src/core";
import { ImapError, ImapSession } from "../src/imap";
import { handleRest } from "../src/rest";
import type { Env } from "../src/types";
import { fakeSocket, login } from "./support/scripted-imap";

const env = {
  ICLOUD_USER: "owner@example.com",
  ICLOUD_APP_PASSWORD: "app-pass",
  ALLOWED_MAILBOXES: "INBOX,Archive,Sent Messages",
} as Env;

function request(path = "INBOX/1/42/read", method = "POST") {
  return new Request(`https://mail.example.com/v1/messages/${path}`, { method });
}

function mockSession() {
  const session = {
    select: vi.fn().mockResolvedValue({ uidValidity: 1, exists: 1 }),
    fetchSize: vi.fn().mockResolvedValue(100),
    uidMarkRead: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
  };
  vi.spyOn(ImapSession, "open").mockResolvedValue(session as unknown as ImapSession);
  return session;
}

afterEach(() => vi.restoreAllMocks());

describe("mark mail read", () => {
  it("runs the REST request through SELECT, an existence check and additive Seen STORE", async () => {
    const { socket, server } = fakeSocket();
    const script = (async () => {
      await login(server);
      expect(await server.line()).toBe('A2 SELECT "Sent Messages"');
      await server.send("* 1 EXISTS\r\n* OK [UIDVALIDITY 1] valid\r\nA2 OK [READ-WRITE] selected\r\n");
      expect(await server.line()).toBe("A3 UID FETCH 42 (UID RFC822.SIZE)");
      await server.send("* 1 FETCH (UID 42 RFC822.SIZE 100)\r\nA3 OK fetched\r\n");
      // +FLAGS preserves existing flags such as Flagged and Answered.
      expect(await server.line()).toBe("A4 UID STORE 42 +FLAGS.SILENT (\\Seen)");
      await server.send("A4 OK stored\r\n");
      expect(await server.line()).toBe("A5 LOGOUT");
      await server.send("* BYE logging out\r\nA5 OK logout\r\n");
    })();
    const scriptOutcome = script.then(() => null, (error: unknown) => error);
    const session = await ImapSession.open(env.ICLOUD_USER, env.ICLOUD_APP_PASSWORD, {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    vi.spyOn(ImapSession, "open").mockResolvedValue(session);
    const audit = vi.spyOn(console, "log").mockImplementation(() => {});

    const response = await handleRest(request("Sent%20Messages/1/42/read"), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, action: "read", mailbox: "Sent Messages", uid: 42, seen: true,
    });
    expect(await scriptOutcome).toBeNull();
    expect(audit).toHaveBeenCalledWith("mail_mutation", JSON.stringify({
      principal: "bearer", action: "read", mailbox: "Sent Messages", uid: 42,
    }));
  });

  it.each([
    ["Other/1/42/read", "mailbox_not_allowed"],
    ["INBOX/0/42/read", "invalid_uidvalidity"],
    ["INBOX/1/0/read", "invalid_uid"],
    ["INBOX/1/9007199254740992/read", "invalid_uid"],
    ["INBOX/x/42/read", "invalid_request"],
    ["%ZZ/1/42/read", "invalid_request"],
  ])("rejects invalid target %s before connecting", async (path, code) => {
    const open = vi.spyOn(ImapSession, "open");
    const response = await handleRest(request(path), env);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(open).not.toHaveBeenCalled();
  });

  it("requires POST", async () => {
    expect((await handleRest(request(undefined, "GET"), env)).status).toBe(404);
  });

  it("refuses a stale UIDVALIDITY before changing any flags and logs out", async () => {
    const session = mockSession();
    session.select.mockResolvedValue({ uidValidity: 2, exists: 1 });
    const response = await handleRest(request(), env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "uidvalidity_mismatch" } });
    expect(session.fetchSize).not.toHaveBeenCalled();
    expect(session.uidMarkRead).not.toHaveBeenCalled();
    expect(session.logout).toHaveBeenCalledOnce();
  });

  it("returns 404 for a missing message without issuing STORE", async () => {
    const session = mockSession();
    session.fetchSize.mockRejectedValue(new ImapError("PARSE", "no FETCH data"));
    const response = await handleRest(request(), env);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "message_not_found" } });
    expect(session.uidMarkRead).not.toHaveBeenCalled();
    expect(session.logout).toHaveBeenCalledOnce();
  });

  it("can be repeated for an already read message", async () => {
    const session = mockSession();
    vi.spyOn(console, "log").mockImplementation(() => {});
    for (let i = 0; i < 2; i++) {
      await expect(markMessageRead(env, "INBOX", 1, 42)).resolves.toMatchObject({ seen: true });
    }
    expect(session.uidMarkRead).toHaveBeenCalledTimes(2);
  });

  it("retries a dropped connection once because adding Seen is idempotent", async () => {
    const session = mockSession();
    vi.spyOn(console, "log").mockImplementation(() => {});
    session.uidMarkRead.mockRejectedValueOnce(new ImapError("BYE", "connection dropped"));
    await expect(markMessageRead(env, "INBOX", 1, 42)).resolves.toMatchObject({ seen: true });
    expect(ImapSession.open).toHaveBeenCalledTimes(2);
    expect(session.logout).toHaveBeenCalledTimes(2);
  });

  it.each([["NO", 502], ["TIMEOUT", 504]] as const)("surfaces STORE %s without retrying", async (code, status) => {
    const session = mockSession();
    session.uidMarkRead.mockRejectedValue(new ImapError(code, "STORE failed"));
    const response = await handleRest(request(), env);
    expect(response.status).toBe(status);
    expect(ImapSession.open).toHaveBeenCalledOnce();
    expect(session.logout).toHaveBeenCalledOnce();
  });
});
