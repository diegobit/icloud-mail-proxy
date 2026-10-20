import { describe, expect, it } from "vitest";
import {
  buildCopy,
  buildMove,
  buildStoreDeleted,
  buildUidExpunge,
  chooseMoveStrategy,
} from "../src/imap-mutations";
import { ImapError, ImapSession } from "../src/imap";
import { ImapParseError } from "../src/imap-parse";
import { fakeSocket, login } from "./support/scripted-imap";

describe("chooseMoveStrategy", () => {
  it("prefers MOVE, then the UIDPLUS fallback, then refuses", () => {
    expect(chooseMoveStrategy(new Set(["IMAP4REV1", "MOVE", "UIDPLUS"]))).toBe("move");
    expect(chooseMoveStrategy(new Set(["IMAP4REV1", "UIDPLUS"]))).toBe("copy-uidplus");
    expect(chooseMoveStrategy(new Set(["IMAP4REV1"]))).toBe("unsupported");
    expect(chooseMoveStrategy(new Set())).toBe("unsupported");
  });

  it("matches capability names case-insensitively", () => {
    expect(chooseMoveStrategy(new Set(["move"]))).toBe("move");
    expect(chooseMoveStrategy(new Set(["uidplus"]))).toBe("copy-uidplus");
  });
});

describe("mutation builders", () => {
  it("frames single-uid commands without a tag or CRLF", () => {
    expect(buildMove(42, "Archive")).toBe('UID MOVE 42 "Archive"');
    expect(buildCopy(42, "Deleted Messages")).toBe('UID COPY 42 "Deleted Messages"');
    expect(buildStoreDeleted(42)).toBe("UID STORE 42 +FLAGS.SILENT (\\Deleted)");
    expect(buildUidExpunge(42)).toBe("UID EXPUNGE 42");
  });

  it("escapes quotes and backslashes in the destination", () => {
    expect(buildMove(7, 'We"ird\\')).toBe('UID MOVE 7 "We\\"ird\\\\"');
    expect(buildCopy(7, 'We"ird\\')).toBe('UID COPY 7 "We\\"ird\\\\"');
  });

  it("rejects non-positive, fractional and unsafe uids", () => {
    for (const uid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => buildMove(uid, "Archive")).toThrow(ImapParseError);
      expect(() => buildCopy(uid, "Archive")).toThrow(ImapParseError);
      expect(() => buildStoreDeleted(uid)).toThrow(ImapParseError);
      expect(() => buildUidExpunge(uid)).toThrow(ImapParseError);
    }
  });

  it("rejects CR/LF, NUL and non-ASCII destinations", () => {
    expect(() => buildMove(1, "Arch\nive")).toThrow(ImapParseError);
    expect(() => buildMove(1, "Arch\u0000ive")).toThrow(ImapParseError);
    expect(() => buildMove(1, "Archivé")).toThrow(ImapParseError);
    expect(() => buildCopy(1, "Arch\rive")).toThrow(ImapParseError);
  });
});

describe("ImapSession.select", () => {
  it("issues a read-write SELECT and reuses the mailbox parser", async () => {
    const { socket, server } = fakeSocket();
    let scriptError: unknown = null;
    const script = (async () => {
      await login(server);
      expect(await server.line()).toBe('A2 SELECT "Deleted Messages"');
      await server.send("* 12 EXISTS\r\n");
      await server.send("* OK [UIDVALIDITY 1699999999] UIDs valid\r\n");
      await server.send("A2 OK [READ-WRITE] SELECT completed\r\n");
    })().catch((error) => {
      scriptError = error;
    });

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await expect(session.select("Deleted Messages")).resolves.toEqual({
      uidValidity: 1699999999,
      exists: 12,
    });
    await script;
    expect(scriptError).toBeNull();
  });
});

describe("ImapSession.uidMove", () => {
  it("uses UID MOVE when the server advertises MOVE", async () => {
    const { socket, server } = fakeSocket();
    let scriptError: unknown = null;
    const script = (async () => {
      await login(server);
      expect(await server.line()).toBe("A2 CAPABILITY");
      await server.send("* CAPABILITY IMAP4rev1 MOVE UIDPLUS\r\n");
      await server.send("A2 OK done\r\n");
      expect(await server.line()).toBe('A3 UID MOVE 42 "Archive"');
      await server.send("A3 OK [COPYUID 1699999999 42 7] moved\r\n");
    })().catch((error) => {
      scriptError = error;
    });

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await session.uidMove(42, "Archive");
    await script;
    expect(scriptError).toBeNull();
    // The fallback commands must not be issued alongside a MOVE.
    expect(server.received).not.toContain("UID COPY");
    expect(server.received).not.toContain("EXPUNGE");
  });

  it("falls back to COPY + STORE \\Deleted + UID EXPUNGE without MOVE", async () => {
    const { socket, server } = fakeSocket();
    let scriptError: unknown = null;
    const script = (async () => {
      await login(server);
      expect(await server.line()).toBe("A2 CAPABILITY");
      await server.send("* CAPABILITY IMAP4rev1 UIDPLUS\r\n");
      await server.send("A2 OK done\r\n");
      expect(await server.line()).toBe('A3 UID COPY 42 "Deleted Messages"');
      await server.send("A3 OK [COPYUID 1699999999 42 8] copied\r\n");
      expect(await server.line()).toBe("A4 UID STORE 42 +FLAGS.SILENT (\\Deleted)");
      await server.send("A4 OK stored\r\n");
      expect(await server.line()).toBe("A5 UID EXPUNGE 42");
      await server.send("A5 OK expunged\r\n");
    })().catch((error) => {
      scriptError = error;
    });

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await session.uidMove(42, "Deleted Messages");
    await script;
    expect(scriptError).toBeNull();
    // UID EXPUNGE is scoped to this uid: no bare EXPUNGE, no uid set.
    expect(server.received).toContain("A5 UID EXPUNGE 42");
    expect(server.received).not.toMatch(/\r\nA\d+ EXPUNGE\b/);
  });

  it("refuses with UNSUPPORTED when neither MOVE nor UIDPLUS is advertised", async () => {
    const { socket, server } = fakeSocket();
    const script = (async () => {
      await login(server);
      expect(await server.line()).toBe("A2 CAPABILITY");
      await server.send("* CAPABILITY IMAP4rev1\r\n");
      await server.send("A2 OK done\r\n");
    })().catch(() => {});

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    const failure = await session.uidMove(42, "Archive").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImapError);
    expect(failure).toMatchObject({ code: "UNSUPPORTED" });
    await script;
    expect(server.received).not.toContain("COPY");
    expect(server.received).not.toContain("EXPUNGE");
    expect(server.received).not.toContain("STORE");
  });

  it("treats an unreadable CAPABILITY as unsupported rather than guessing", async () => {
    const { socket, server } = fakeSocket();
    const script = (async () => {
      await login(server);
      expect(await server.line()).toBe("A2 CAPABILITY");
      await server.send("A2 NO capability unavailable\r\n");
    })().catch(() => {});

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await expect(session.uidMove(42, "Archive")).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await script;
  });

  it("propagates a dropped connection instead of calling it unsupported", async () => {
    const { socket, server } = fakeSocket();
    const script = (async () => {
      await login(server);
      expect(await server.line()).toBe("A2 CAPABILITY");
      await server.send("* BYE server shutting down\r\n");
    })().catch(() => {});

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    // BYE reaches withRetryOnce in the core; it must not be flattened into
    // "this server supports no move" (which would not be retried).
    await expect(session.uidMove(42, "Archive")).rejects.toMatchObject({ code: "BYE" });
    await script;
  });

  it("surfaces a NO from the move itself", async () => {
    const { socket, server } = fakeSocket();
    const script = (async () => {
      await login(server);
      expect(await server.line()).toBe("A2 CAPABILITY");
      await server.send("* CAPABILITY IMAP4rev1 MOVE\r\n");
      await server.send("A2 OK done\r\n");
      expect(await server.line()).toBe('A3 UID MOVE 42 "Archive"');
      await server.send("A3 NO [TRYCREATE] no such mailbox\r\n");
    })().catch(() => {});

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await expect(session.uidMove(42, "Archive")).rejects.toMatchObject({ code: "NO" });
    await script;
  });
});
