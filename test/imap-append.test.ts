import { describe, expect, it } from "vitest";
import { buildAppend } from "../src/imap-append";
import { ImapError, ImapSession, type ImapSocketLike } from "../src/imap";
import { ImapParseError } from "../src/imap-parse";

const bytes = new Uint8Array([1, 2, 3, 4, 5]);

describe("buildAppend", () => {
  it("frames the command text without a tag or CRLF (the session adds both)", () => {
    expect(buildAppend("Drafts", ["\\Draft"], 5)).toBe('APPEND "Drafts" (\\Draft) {5}');
    expect(buildAppend("Sent Messages", ["\\Seen"], 5)).toBe('APPEND "Sent Messages" (\\Seen) {5}');
  });

  it("omits an empty flag list", () => {
    expect(buildAppend("Drafts", [], 5)).toBe('APPEND "Drafts" {5}');
  });

  it("escapes quotes and backslashes in the mailbox name", () => {
    expect(buildAppend('We"ird\\', ["\\Draft"], 5)).toBe('APPEND "We\\"ird\\\\" (\\Draft) {5}');
  });

  it("rejects flags the proxy does not issue, empty payloads and CRLF in names", () => {
    expect(() => buildAppend("Drafts", ["\\Custom"], 5)).toThrow(ImapParseError);
    expect(() => buildAppend("Drafts", ["Draft"], 5)).toThrow(ImapParseError);
    expect(() => buildAppend("Drafts", [], 0)).toThrow(ImapParseError);
    expect(() => buildAppend("Dra\nfts", ["\\Draft"], 5)).toThrow(ImapParseError);
    expect(() => buildAppend("Dra\u0000fts", ["\\Draft"], 5)).toThrow(ImapParseError);
    void bytes;
  });
});

/** Scripted IMAP server over an in-memory duplex. */
class ScriptedServer {
  private buffer = "";
  received = "";
  constructor(
    private reader: ReadableStreamDefaultReader<Uint8Array>,
    private writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  async send(text: string): Promise<void> {
    await this.writer.write(new TextEncoder().encode(text));
  }

  async line(): Promise<string> {
    for (;;) {
      const index = this.buffer.indexOf("\r\n");
      if (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        this.received += `${line}\r\n`;
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("client closed the connection");
      if (value) this.buffer += new TextDecoder("latin1").decode(value);
    }
  }

  async bytes(count: number): Promise<string> {
    while (this.buffer.length < count) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error("client closed the connection");
      if (value) this.buffer += new TextDecoder("latin1").decode(value);
    }
    const out = this.buffer.slice(0, count);
    this.buffer = this.buffer.slice(count);
    this.received += out;
    return out;
  }
}

function fakeSocket(): { socket: ImapSocketLike; server: ScriptedServer } {
  const c2s = new TransformStream<Uint8Array, Uint8Array>();
  const s2c = new TransformStream<Uint8Array, Uint8Array>();
  const server = new ScriptedServer(c2s.readable.getReader(), s2c.writable.getWriter());
  return {
    socket: { readable: s2c.readable, writable: c2s.writable, close: async () => {} },
    server,
  };
}

const RAW = new TextEncoder().encode("Subject: x\r\n\r\nCiao\r\n");

/** Greeting + LOGIN + CAPABILITY exchange shared by the append tests. */
async function handshake(server: ScriptedServer, capabilities: string): Promise<void> {
  await server.send("* OK [CAPABILITY IMAP4rev1] ready\r\n");
  expect(await server.line()).toBe('A1 LOGIN "owner@example.com" "app-pass"');
  await server.send("A1 OK logged in\r\n");
  expect(await server.line()).toBe("A2 CAPABILITY");
  await server.send(`* CAPABILITY ${capabilities}\r\n`);
  await server.send("A2 OK done\r\n");
}

describe("ImapSession.append", () => {
  it("sends a tagged APPEND, waits for the continuation, then the literal", async () => {
    const { socket, server } = fakeSocket();
    let scriptError: unknown = null;
    const script = (async () => {
      await handshake(server, "IMAP4rev1 AUTH=PLAIN");
      expect(await server.line()).toBe(`A3 APPEND "Drafts" (\\Draft) {${RAW.byteLength}}`);
      // No LITERAL+: the client must not have sent the message yet.
      expect(server.received).not.toContain("Subject: x");
      await server.send("+ Ready for literal data\r\n");
      expect(await server.bytes(RAW.byteLength)).toBe("Subject: x\r\n\r\nCiao\r\n");
      expect(await server.line()).toBe("");
      await server.send("A3 OK [APPENDUID 100 42] appended\r\n");
    })().catch((error) => {
      scriptError = error;
    });

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await session.append("Drafts", ["\\Draft"], RAW);
    await script;
    expect(scriptError).toBeNull();
    expect(server.received).toContain(`APPEND "Drafts" (\\Draft) {${RAW.byteLength}}`);
  });

  it("sends the literal immediately when the server advertises LITERAL+", async () => {
    const { socket, server } = fakeSocket();
    let scriptError: unknown = null;
    const script = (async () => {
      await handshake(server, "IMAP4rev1 LITERAL+ AUTH=PLAIN");
      expect(await server.line()).toBe(`A3 APPEND "Sent Messages" (\\Seen) {${RAW.byteLength}}`);
      // No "+" is sent: the bytes must arrive on their own.
      expect(await server.bytes(RAW.byteLength)).toBe("Subject: x\r\n\r\nCiao\r\n");
      expect(await server.line()).toBe("");
      await server.send("A3 OK appended\r\n");
    })().catch((error) => {
      scriptError = error;
    });

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await session.append("Sent Messages", ["\\Seen"], RAW);
    await script;
    expect(scriptError).toBeNull();
  });

  it("surfaces a NO before the literal and never sends the message", async () => {
    const { socket, server } = fakeSocket();
    const script = (async () => {
      await handshake(server, "IMAP4rev1");
      expect(await server.line()).toBe(`A3 APPEND "Drafts" (\\Draft) {${RAW.byteLength}}`);
      await server.send("A3 NO [TRYCREATE] no such mailbox\r\n");
    })().catch(() => {});

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await expect(session.append("Drafts", ["\\Draft"], RAW)).rejects.toMatchObject({ code: "NO" });
    await script;
    expect(server.received).not.toContain("Subject: x");
  });

  it("reports a failed CAPABILITY as no LITERAL+ and still appends safely", async () => {
    const { socket, server } = fakeSocket();
    let scriptError: unknown = null;
    const script = (async () => {
      await server.send("* OK ready\r\n");
      expect(await server.line()).toBe('A1 LOGIN "owner@example.com" "app-pass"');
      await server.send("A1 OK logged in\r\n");
      expect(await server.line()).toBe("A2 CAPABILITY");
      await server.send("A2 NO capability unavailable\r\n");
      expect(await server.line()).toBe(`A3 APPEND "Drafts" (\\Draft) {${RAW.byteLength}}`);
      await server.send("+ go\r\n");
      expect(await server.bytes(RAW.byteLength)).toBe("Subject: x\r\n\r\nCiao\r\n");
      expect(await server.line()).toBe("");
      await server.send("A3 OK appended\r\n");
    })().catch((error) => {
      scriptError = error;
    });

    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    await session.append("Drafts", ["\\Draft"], RAW);
    await script;
    expect(scriptError).toBeNull();
  });

  it("types the append error as an ImapError", async () => {
    const { socket, server } = fakeSocket();
    const script = (async () => {
      await handshake(server, "IMAP4rev1");
      expect(await server.line()).toBe(`A3 APPEND "Drafts" (\\Draft) {${RAW.byteLength}}`);
      await server.send("A3 BAD syntax error\r\n");
    })().catch(() => {});
    const session = await ImapSession.open("owner@example.com", "app-pass", {
      connectSocket: () => socket,
      timeoutMs: 500,
    });
    const failure = await session.append("Drafts", ["\\Draft"], RAW).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ImapError);
    await script;
  });
});
