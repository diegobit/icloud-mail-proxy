// Read-only IMAP session over a direct-TLS Cloudflare socket.
//
// The proxy only ever issues LOGIN, EXAMINE, UID SEARCH, UID FETCH (always
// BODY.PEEK, never BODY[]) and LOGOUT. Sockets are created per call to open()
// and never held at module scope.

import { connect } from "cloudflare:sockets";
import { buildAppend } from "./imap-append";
import {
  ImapParseError,
  ImapTokenizer,
  assertNoCrlf,
  parseExamineResponse,
  parseFetchSections,
  parseSearchResponse,
  quoteImapString,
  type Envelope,
  type ImapToken,
} from "./imap-parse";

export type { Envelope };

export type ImapErrorCode = "NO" | "BAD" | "BYE" | "PARSE" | "TIMEOUT" | "LIMIT";

export class ImapError extends Error {
  code: ImapErrorCode;
  constructor(code: ImapErrorCode, message: string) {
    super(message);
    this.name = "ImapError";
    this.code = code;
  }
}

const HOST = "imap.mail.me.com";
const PORT = 993;
const DEFAULT_TIMEOUT_MS = 30000;
const LOGOUT_TIMEOUT_MS = 3000;

// A ranged fetch returns at most maxBytes octets, so the announced literal
// should never exceed maxBytes; this slack only guards against server quirks.
const PARTIAL_FETCH_SLACK = 256;

// Distinct rejection value so a timed-out read can be told apart from a genuine
// stream error in the Promise.race below.
const TIMEOUT = Symbol("imap-read-timeout");

const encoder = new TextEncoder();

interface ReadResult {
  done: boolean;
  value?: Uint8Array;
}

export class ImapSession {
  private readonly socket: Socket;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly tokenizer = new ImapTokenizer();
  private timeoutMs: number;
  private tagCounter = 0;
  private closed = false;

  private constructor(
    socket: Socket,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    timeoutMs: number,
  ) {
    this.socket = socket;
    this.reader = reader;
    this.writer = writer;
    this.timeoutMs = timeoutMs;
  }

  /** Connect, read the greeting and LOGIN. Throws ImapError on any failure. */
  static async open(
    user: string,
    appPassword: string,
    opts?: { timeoutMs?: number },
  ): Promise<ImapSession> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket = connect(
      { hostname: HOST, port: PORT },
      { secureTransport: "on", allowHalfOpen: false },
    );
    const reader = socket.readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    const writer = socket.writable.getWriter() as WritableStreamDefaultWriter<Uint8Array>;
    const session = new ImapSession(socket, reader, writer, timeoutMs);

    // Greeting: an untagged status response, normally "* OK ...".
    const greeting = await session.nextToken();
    if (greeting.kind !== "line" || !greeting.text.startsWith("* OK")) {
      const text = greeting.kind === "line" ? greeting.text : "<literal>";
      await session.destroy();
      throw new ImapError("BYE", `unexpected greeting: ${text}`);
    }

    // LOGIN — the command text carries the password, so it is never surfaced.
    let loginCmd: string;
    try {
      loginCmd = `LOGIN ${quoteImapString(user)} ${quoteImapString(appPassword)}`;
    } catch (e) {
      await session.destroy();
      throw toImapError(e);
    }
    try {
      await session.command(loginCmd, "LOGIN");
    } catch (e) {
      await session.destroy();
      throw e;
    }
    return session;
  }

  /** EXAMINE (read-only SELECT). Returns UIDVALIDITY and the EXISTS count. */
  async examine(mailbox: string): Promise<{ uidValidity: number; exists: number }> {
    try {
      const untagged = await this.command(
        `EXAMINE ${quoteImapString(mailbox)}`,
        "EXAMINE",
      );
      return parseExamineResponse(textLines(untagged));
    } catch (e) {
      throw toImapError(e);
    }
  }

  /**
   * UID SEARCH <criteria>. The criteria string is assembled by the caller from
   * validated parts; we still reject any CR/LF as a defence-in-depth guard.
   */
  async uidSearch(criteria: string): Promise<number[]> {
    try {
      assertNoCrlf(criteria);
      const untagged = await this.command(`UID SEARCH ${criteria}`, "UID SEARCH");
      return parseSearchResponse(textLines(untagged));
    } catch (e) {
      throw toImapError(e);
    }
  }

  /** UID FETCH of envelope metadata + peeked header fields. */
  async fetchEnvelopes(uids: number[]): Promise<Envelope[]> {
    if (uids.length === 0) return [];
    const set = this.uidSet(uids);
    const untagged = await this.command(
      `UID FETCH ${set} (UID FLAGS RFC822.SIZE INTERNALDATE BODYSTRUCTURE ` +
        `BODY.PEEK[HEADER.FIELDS (DATE FROM TO CC SUBJECT MESSAGE-ID)])`,
      "UID FETCH",
    );
    const items = parseFetchSections(untagged);
    return items.map((it) => {
      if (it.uid === null) {
        throw new ImapError("PARSE", "FETCH response missing UID");
      }
      return {
        uid: it.uid,
        size: it.size ?? 0,
        internalDate: it.internalDate,
        flags: it.flags ?? [],
        headerBytes: it.sections[0]?.bytes ?? new Uint8Array(0),
        bodyStructure: it.bodyStructure,
      };
    });
  }

  /** UID FETCH n (UID RFC822.SIZE) -> size in bytes. */
  async fetchSize(uid: number): Promise<number> {
    assertUid(uid);
    const untagged = await this.command(`UID FETCH ${uid} (UID RFC822.SIZE)`, "UID FETCH");
    const items = parseFetchSections(untagged);
    const item = items.find((x) => x.uid === uid) ?? items[0];
    if (!item || item.size === null) {
      throw new ImapError("PARSE", "FETCH response missing RFC822.SIZE");
    }
    return item.size;
  }

  /**
   * UID FETCH n (BODY.PEEK[]) -> raw RFC822 bytes. If the announced literal
   * size exceeds maxBytes the socket is closed and ImapError "LIMIT" is thrown
   * before the payload is buffered.
   */
  async fetchRaw(uid: number, maxBytes: number): Promise<Uint8Array> {
    assertUid(uid);
    const tag = this.nextTag();
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[])\r\n`);
    let body: Uint8Array | null = null;
    for (;;) {
      const tok = await this.nextToken();
      if (tok.kind === "literal") {
        body = tok.bytes;
        continue;
      }
      const text = tok.text;
      if (text.startsWith(`${tag} `)) {
        this.checkTagged(text, "UID FETCH");
        break;
      }
      if (text.startsWith("* BYE")) {
        await this.destroy();
        throw new ImapError("BYE", text);
      }
      const marker = text.match(/\{(\d+)\}$/);
      if (marker) {
        const n = Number(marker[1]);
        if (n > maxBytes) {
          await this.destroy();
          throw new ImapError("LIMIT", `message body ${n} bytes exceeds limit ${maxBytes}`);
        }
      }
    }
    if (body === null) throw new ImapError("PARSE", "FETCH returned no body");
    return body;
  }

  /**
   * UID FETCH n (BODY.PEEK[]<0.maxBytes>) -> the first `maxBytes` bytes of the
   * raw RFC822 message. The ranged section spec makes the server return at most
   * maxBytes octets, so an oversized message can be fetched partially instead of
   * refused. The response's section header carries an origin octet (e.g.
   * `BODY[]<0>`), which the literal-capture loop ignores just like fetchRaw. As
   * a backstop, if the announced literal exceeds maxBytes (plus a little slack)
   * the socket is closed and ImapError "LIMIT" is thrown before buffering.
   */
  async fetchRawPartial(uid: number, maxBytes: number): Promise<Uint8Array> {
    assertUid(uid);
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new ImapError("PARSE", `invalid maxBytes: ${maxBytes}`);
    }
    const tag = this.nextTag();
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[]<0.${maxBytes}>)\r\n`);
    let body: Uint8Array | null = null;
    for (;;) {
      const tok = await this.nextToken();
      if (tok.kind === "literal") {
        body = tok.bytes;
        continue;
      }
      const text = tok.text;
      if (text.startsWith(`${tag} `)) {
        this.checkTagged(text, "UID FETCH");
        break;
      }
      if (text.startsWith("* BYE")) {
        await this.destroy();
        throw new ImapError("BYE", text);
      }
      const marker = text.match(/\{(\d+)\}$/);
      if (marker) {
        const n = Number(marker[1]);
        if (n > maxBytes + PARTIAL_FETCH_SLACK) {
          await this.destroy();
          throw new ImapError("LIMIT", `partial body ${n} bytes exceeds limit ${maxBytes}`);
        }
      }
    }
    if (body === null) throw new ImapError("PARSE", "FETCH returned no body");
    return body;
  }

  /**
   * UID FETCH n (BODYSTRUCTURE) -> the raw BODYSTRUCTURE text span, or null
   * when the UID has no FETCH data (e.g. the message no longer exists).
   */
  async fetchBodyStructure(uid: number): Promise<string | null> {
    assertUid(uid);
    const untagged = await this.command(`UID FETCH ${uid} (BODYSTRUCTURE)`, "UID FETCH");
    const items = parseFetchSections(untagged);
    const item = items.find((x) => x.uid === uid) ?? items[0];
    return item?.bodyStructure ?? null;
  }

  /**
   * UID FETCH n (BODY.PEEK[<partNumber>]) -> the raw bytes of a single MIME
   * part, still in its Content-Transfer-Encoding. The part number is validated
   * against RFC 3501 dotted-integer syntax before interpolation (a hard
   * command-injection guard). The response section spec echoes the part number
   * (`BODY[2] {N}`), which the literal-capture loop ignores like fetchRaw. If
   * the announced literal exceeds maxBytes (plus a little slack) the socket is
   * closed and ImapError "LIMIT" is thrown before the payload is buffered.
   */
  async fetchPart(uid: number, partNumber: string, maxBytes: number): Promise<Uint8Array> {
    assertUid(uid);
    if (!/^\d+(\.\d+)*$/.test(partNumber)) {
      throw new ImapError("PARSE", `invalid part number: ${partNumber}`);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new ImapError("PARSE", `invalid maxBytes: ${maxBytes}`);
    }
    const tag = this.nextTag();
    await this.write(`${tag} UID FETCH ${uid} (BODY.PEEK[${partNumber}])\r\n`);
    let body: Uint8Array | null = null;
    for (;;) {
      const tok = await this.nextToken();
      if (tok.kind === "literal") {
        body = tok.bytes;
        continue;
      }
      const text = tok.text;
      if (text.startsWith(`${tag} `)) {
        this.checkTagged(text, "UID FETCH");
        break;
      }
      if (text.startsWith("* BYE")) {
        await this.destroy();
        throw new ImapError("BYE", text);
      }
      const marker = text.match(/\{(\d+)\}$/);
      if (marker) {
        const n = Number(marker[1]);
        if (n > maxBytes + PARTIAL_FETCH_SLACK) {
          await this.destroy();
          throw new ImapError("LIMIT", `attachment part ${n} bytes exceeds limit ${maxBytes}`);
        }
      }
    }
    if (body === null) throw new ImapError("PARSE", "FETCH returned no body");
    return body;
  }

  /**
   * APPEND a message literal to a mailbox (plans/email-send.md, step 8). The
   * one write command this proxy issues: used to save a draft into iCloud's
   * Drafts mailbox, and optionally to file a sent copy. Flags are restricted
   * by buildAppend; the literal is the exact serialized message.
   */
  async append(mailbox: string, flags: string[], raw: Uint8Array): Promise<void> {
    let head: string;
    try {
      head = buildAppend(mailbox, flags, raw);
    } catch (e) {
      throw toImapError(e);
    }
    const tag = head.slice(0, head.indexOf(" "));
    await this.write(head);
    await this.writeBytes(raw);
    await this.write("\r\n");
    for (;;) {
      const tok = await this.nextToken();
      if (tok.kind === "line" && tok.text.startsWith(`${tag} `)) {
        this.checkTagged(tok.text, "APPEND");
        return;
      }
      if (tok.kind === "line" && tok.text.startsWith("* BYE")) {
        await this.destroy();
        throw new ImapError("BYE", tok.text);
      }
    }
  }

  /** Best-effort LOGOUT then socket close. Never throws. */
  async logout(): Promise<void> {
    try {
      const tag = this.nextTag();
      await this.write(`${tag} LOGOUT\r\n`);
      const saved = this.timeoutMs;
      this.timeoutMs = LOGOUT_TIMEOUT_MS;
      try {
        for (;;) {
          const tok = await this.nextToken();
          if (tok.kind === "line" && tok.text.startsWith(`${tag} `)) break;
        }
      } finally {
        this.timeoutMs = saved;
      }
    } catch {
      // Swallow every error — logout is best-effort.
    }
    await this.destroy();
  }

  // ---- internals -----------------------------------------------------------

  private nextTag(): string {
    this.tagCounter += 1;
    return `A${this.tagCounter}`;
  }

  private uidSet(uids: number[]): string {
    for (const uid of uids) assertUid(uid);
    return uids.join(",");
  }

  private async write(line: string): Promise<void> {
    await this.writer.write(encoder.encode(line));
  }

  private async writeBytes(bytes: Uint8Array): Promise<void> {
    await this.writer.write(bytes);
  }

  /**
   * Send a tagged command and collect every untagged token until the tagged
   * response arrives. NO/BAD become ImapError; an untagged "* BYE" first
   * becomes ImapError "BYE".
   */
  private async command(cmd: string, opName: string): Promise<ImapToken[]> {
    const tag = this.nextTag();
    await this.write(`${tag} ${cmd}\r\n`);
    const untagged: ImapToken[] = [];
    for (;;) {
      const tok = await this.nextToken();
      if (tok.kind === "line" && tok.text.startsWith(`${tag} `)) {
        this.checkTagged(tok.text, opName);
        return untagged;
      }
      if (tok.kind === "line" && tok.text.startsWith("* BYE")) {
        await this.destroy();
        throw new ImapError("BYE", tok.text);
      }
      untagged.push(tok);
    }
  }

  private checkTagged(line: string, opName: string): void {
    const m = line.match(/^\S+ (OK|NO|BAD)\b ?(.*)$/);
    if (!m) throw new ImapError("PARSE", `malformed tagged response: ${line}`);
    if (m[1] === "OK") return;
    const code: ImapErrorCode = m[1] === "NO" ? "NO" : "BAD";
    throw new ImapError(code, `${opName} failed: ${m[2] ?? ""}`);
  }

  /** Pull the next token, reading from the socket (with timeout) as needed. */
  private async nextToken(): Promise<ImapToken> {
    for (;;) {
      const tok = this.tokenizer.next();
      if (tok) return tok;
      const result = await this.readWithTimeout();
      if (result.done) {
        await this.destroy();
        throw new ImapError("BYE", "connection closed by server");
      }
      if (result.value) this.tokenizer.push(result.value);
    }
  }

  private async readWithTimeout(): Promise<ReadResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(TIMEOUT), this.timeoutMs);
    });
    try {
      return await Promise.race([this.reader.read(), timeout]);
    } catch (e) {
      if (e === TIMEOUT) {
        await this.destroy();
        throw new ImapError("TIMEOUT", "read timed out");
      }
      throw e;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** Close the socket and release stream locks. Never throws. */
  private async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.reader.cancel();
    } catch {
      // ignore
    }
    // Not awaited: closing the writer on a broken socket can stall, and
    // destroy() runs on error paths that must not hang.
    this.writer.close().catch(() => {});
    try {
      await this.socket.close();
    } catch {
      // ignore
    }
  }
}

function assertUid(uid: number): void {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new ImapError("PARSE", `invalid UID: ${uid}`);
  }
}

function textLines(tokens: ImapToken[]): string[] {
  const lines: string[] = [];
  for (const tok of tokens) if (tok.kind === "line") lines.push(tok.text);
  return lines;
}

function toImapError(e: unknown): ImapError {
  if (e instanceof ImapError) return e;
  if (e instanceof ImapParseError) return new ImapError("PARSE", e.message);
  return new ImapError("PARSE", e instanceof Error ? e.message : String(e));
}
