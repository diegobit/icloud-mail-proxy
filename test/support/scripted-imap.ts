// A scripted IMAP server over an in-memory duplex, for Node tests of
// ImapSession. The test decides what the server sends line by line; the helper
// records everything the client wrote so assertions can look at the exact
// command text.

import { expect } from "vitest";
import type { ImapSocketLike } from "../../src/imap";

/** Scripted IMAP server over an in-memory duplex. */
export class ScriptedServer {
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

/** A duplex socket plus the scripted server driving the other end. */
export function fakeSocket(): { socket: ImapSocketLike; server: ScriptedServer } {
  const c2s = new TransformStream<Uint8Array, Uint8Array>();
  const s2c = new TransformStream<Uint8Array, Uint8Array>();
  const server = new ScriptedServer(c2s.readable.getReader(), s2c.writable.getWriter());
  return {
    socket: { readable: s2c.readable, writable: c2s.writable, close: async () => {} },
    server,
  };
}

/** The greeting + LOGIN exchange every ImapSession.open() test starts with. */
export async function login(server: ScriptedServer): Promise<void> {
  await server.send("* OK [CAPABILITY IMAP4rev1] ready\r\n");
  expect(await server.line()).toBe('A1 LOGIN "owner@example.com" "app-pass"');
  await server.send("A1 OK logged in\r\n");
}
