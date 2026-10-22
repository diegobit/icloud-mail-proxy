// IMAP session over a direct-TLS Cloudflare socket.
//
// The proxy only ever issues LOGIN, EXAMINE, SELECT (mutations only), UID
// SEARCH, UID FETCH (always BODY.PEEK, never BODY[]), APPEND, the mutation
// commands framed in imap-mutations.ts and LOGOUT. Sockets are created per call
// to open() and never held at module scope.

import { buildAppend } from "./imap-append";
import {
  buildCopy,
  buildMove,
  buildStoreDeleted,
  buildUidExpunge,
  chooseMoveStrategy,
} from "./imap-mutations";
import { defaultImapSocketFactory } from "./imap-socket";
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

export type ImapErrorCode =
  | "NO"
  | "BAD"
  | "BYE"
  | "PARSE"
  | "TIMEOUT"
  | "LIMIT"
  | "UNSUPPORTED"
  | "UNKNOWN";

export class ImapError extends Error {
  code: ImapErrorCode;
  constructor(code: ImapErrorCode, message: string) {
    super(message);
    this.name = "ImapError";
    this.code = code;
  }
}

/** The slice of the Workers socket API ImapSession uses. */
export interface ImapSocketLike {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export type ImapSocketFactory = (address: { hostname: string; port: number }) => ImapSocketLike;

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
  private readonly socket: ImapSocketLike;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly tokenizer = new ImapTokenizer();
  private timeoutMs: number;
  private tagCounter = 0;
  private closed = false;

  private constructor(
    socket: ImapSocketLike,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    writer: WritableStreamDefaultWriter<Uint8Array>,
    timeoutMs: number,
  ) {
    this.socket = socket;
    this.reader = reader;
    this.writer = writer;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Connect, read the greeting and LOGIN. Throws ImapError on any failure.
   * `connectSocket` is a test seam: production always uses the default
   * implicit-TLS factory, tests drive an in-memory duplex.
   */
  static async open(
    user: string,
    appPassword: string,
    opts?: { timeoutMs?: number; connectSocket?: ImapSocketFactory },
  ): Promise<ImapSession> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const socket = (opts?.connectSocket ?? defaultImapSocketFactory)({ hostname: HOST, port: PORT });
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
   * SELECT (read-write), needed before a mutation. The untagged responses are
   * the same as EXAMINE's, so they share the parser.
   */
  async select(mailbox: string): Promise<{ uidValidity: number; exists: number }> {
    try {
      const untagged = await this.command(`SELECT ${quoteImapString(mailbox)}`, "SELECT");
      return parseExamineResponse(textLines(untagged));
    } catch (e) {
      throw toImapError(e);
    }
  }

  /**
   * File one message into `destination` (a fixed, configured mailbox — never
   * request input): `UID MOVE` when the server advertises MOVE, otherwise
   * COPY + `\Deleted` + `UID EXPUNGE` when it advertises UIDPLUS.
   *
   * Without either capability this throws ImapError "UNSUPPORTED" instead of
   * falling back to a plain EXPUNGE, which would remove every `\Deleted`
   * message in the mailbox rather than just this uid. The caller selects the
   * mailbox first; this method issues no SELECT of its own.
   */
  async uidMove(uid: number, destination: string): Promise<void> {
    assertUid(uid);
    let capabilities: Set<string>;
    try {
      capabilities = await this.capability();
    } catch (e) {
      // A dropped connection must reach the caller's BYE retry: reporting it
      // as "unsupported" would hide a transient failure. Any other unreadable
      // capability list means "no MOVE and no UIDPLUS": the conservative
      // branch below refuses rather than guessing.
      if (e instanceof ImapError && e.code === "BYE") throw e;
      capabilities = new Set();
    }
    const strategy = chooseMoveStrategy(capabilities);
    let copyCommand: string | null = null;
    if (strategy === "copy-uidplus") {
      try {
        copyCommand = buildCopy(uid, destination);
      } catch (e) {
        // Framing happens before anything reaches the server, so this is a
        // definite failure, not an ambiguous mutation.
        throw toImapError(e);
      }
    }

    let copyApplied = false;
    try {
      if (strategy === "move") {
        await this.command(buildMove(uid, destination), "UID MOVE");
        return;
      }
      if (copyCommand === null) {
        throw new ImapError(
          "UNSUPPORTED",
          "server advertises neither MOVE nor UIDPLUS; refusing to EXPUNGE the whole mailbox",
        );
      }
      // The UIDPLUS fallback is three commands, not one atomic MOVE. Once the
      // COPY succeeds the state is genuinely unknown unless all three finish:
      // the copy may be in the destination while the message is still in the
      // source, so a blind retry would file a second copy. A NO or timeout on
      // STORE/EXPUNGE is just as ambiguous as a dropped connection. Surface
      // every post-COPY failure as UNKNOWN (not BYE, which the caller retries)
      // and let it check both mailboxes.
      await this.command(copyCommand, "UID COPY");
      copyApplied = true;
      await this.command(buildStoreDeleted(uid), "UID STORE");
      await this.command(buildUidExpunge(uid), "UID EXPUNGE");
    } catch (e) {
      const error = toImapError(e);
      // A lost response before COPY was acknowledged is ambiguous too: the
      // server may have applied the COPY. NO and BAD are definite refusals,
      // so those stay safe to report and retry.
      const uncertainCopyFailure =
        !copyApplied && (error.code === "BYE" || error.code === "TIMEOUT" || error.code === "PARSE");
      if (copyApplied || (strategy === "copy-uidplus" && uncertainCopyFailure)) {
        throw new ImapError(
          "UNKNOWN",
          `the move did not finish; the message may already be filed: ${error.message}`,
        );
      }
      throw error;
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
   * The CAPABILITY list from an untagged `* CAPABILITY ...` response. Best
   * effort: a failure yields an empty set, which makes the caller choose the
   * conservative (synchronizing) behaviour.
   */
  async capability(): Promise<Set<string>> {
    const untagged = await this.command("CAPABILITY", "CAPABILITY");
    const caps = new Set<string>();
    for (const tok of untagged) {
      if (tok.kind !== "line") continue;
      const m = /^\* CAPABILITY\s+(.*)$/i.exec(tok.text);
      if (!m) continue;
      for (const name of m[1].trim().split(/\s+/)) {
        if (name !== "") caps.add(name.toUpperCase());
      }
    }
    return caps;
  }

  /**
   * APPEND a message literal to a mailbox (plans/email-send.md, step 8):
   * saving a draft into iCloud's Drafts mailbox, and optionally filing a sent
   * copy. Flags are restricted by buildAppend; the literal is the exact
   * serialized message.
   *
   * The literal is synchronizing (`{n}`) unless the server advertises
   * LITERAL+, in which case it is sent as the non-synchronizing `{n+}`: with
   * `{n}` the client must wait for the `+` continuation before the bytes,
   * and with `{n+}` it must not (RFC 2088) — getting this backwards either
   * writes the message before the server accepts it or deadlocks.
   */
  async append(mailbox: string, flags: string[], raw: Uint8Array): Promise<void> {
    let nonSynchronizing = false;
    try {
      nonSynchronizing = (await this.capability()).has("LITERAL+");
    } catch {
      // Treat an unreadable capability list as "no LITERAL+".
      nonSynchronizing = false;
    }

    let command: string;
    try {
      command = buildAppend(mailbox, flags, raw.byteLength, { nonSynchronizing });
    } catch (e) {
      throw toImapError(e);
    }

    const tag = this.nextTag();
    await this.write(`${tag} ${command}\r\n`);
    if (!nonSynchronizing) {
      for (;;) {
        const tok = await this.nextToken();
        if (tok.kind === "literal") continue;
        if (tok.text.startsWith("+")) break;
        if (tok.text.startsWith(`${tag} `)) {
          // The server refused before the literal: surface its NO/BAD.
          this.checkTagged(tok.text, "APPEND");
          throw new ImapError("PARSE", "APPEND server accepted without a continuation");
        }
        if (tok.text.startsWith("* BYE")) {
          await this.destroy();
          throw new ImapError("BYE", tok.text);
        }
      }
    }
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
