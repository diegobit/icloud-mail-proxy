// Minimal SMTP submission client over an injected socket
// (plans/email-send.md, step 3).
//
// One connection per message: greet, EHLO, STARTTLS (mandatory outside the
// loopback test override), AUTH PLAIN with the app-specific password, MAIL
// FROM, one RCPT TO per envelope recipient (all-or-nothing), DATA, QUIT.
// No PIPELINING, no CHUNKING. The transport is injected, so the unit tests
// drive an in-memory duplex; src/smtp-socket.ts provides the Cloudflare
// socket factory, which is the only part that needs `cloudflare:sockets`.

export type SmtpErrorCode =
  | "smtp_unavailable" // 4xx, 421, connection problems before the message was accepted
  | "smtp_auth_failed" // 535 / 5xx during AUTH
  | "smtp_sender_rejected" // 5xx on MAIL FROM
  | "smtp_recipient_rejected" // 5xx on RCPT TO
  | "smtp_too_large" // announced SIZE over the server limit
  | "smtp_rejected" // 5xx after DATA (or a 5xx greeting)
  | "smtp_tls_failed" // STARTTLS missing or the handshake failed
  | "smtp_protocol" // malformed server replies
  | "send_status_unknown"; // connection lost after the final dot: may have been queued

export class SmtpError extends Error {
  code: SmtpErrorCode;
  phase: string;
  replyCode?: number;
  recipientIndex?: number;
  constructor(code: SmtpErrorCode, phase: string, message: string, extra?: { replyCode?: number; recipientIndex?: number }) {
    super(message);
    this.name = "SmtpError";
    this.code = code;
    this.phase = phase;
    this.replyCode = extra?.replyCode;
    this.recipientIndex = extra?.recipientIndex;
  }
}

export interface SmtpTarget {
  host: string;
  port: number;
  /** "starttls" for real iCloud; "plaintext" only for a loopback test server. */
  mode: "starttls" | "plaintext";
}

/**
 * The production endpoint is hard-coded. SMTP_HOST/SMTP_PORT are honoured only
 * for the literal loopback names, and only then is TLS skipped: a deployment
 * with a hostile SMTP_HOST value can redirect the connection but can never
 * make the client speak plaintext to a non-loopback host.
 */
export function resolveSmtpTarget(env: { SMTP_HOST?: string; SMTP_PORT?: string }): SmtpTarget {
  const host = (env.SMTP_HOST ?? "").trim();
  const portText = (env.SMTP_PORT ?? "").trim();
  if ((host === "127.0.0.1" || host === "localhost") && /^\d{1,5}$/.test(portText)) {
    const port = Number(portText);
    if (Number.isSafeInteger(port) && port > 0 && port < 65_536) {
      return { host, port, mode: "plaintext" };
    }
  }
  return { host: "smtp.mail.me.com", port: 587, mode: "starttls" };
}

/** The slice of the Workers socket API this client uses. */
export interface SmtpSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  startTls(options?: { expectedServerHostname?: string }): SmtpSocket;
  close(): Promise<void>;
}

export type SmtpSocketFactory = (target: SmtpTarget) => SmtpSocket;

const DEFAULT_TIMEOUT_MS = 30_000;
const DATA_TIMEOUT_MS = 60_000;
const QUIT_TIMEOUT_MS = 3_000;

const encoder = new TextEncoder();

interface Reply {
  code: number;
  lines: string[];
}

/** A transient read failure inside a phase, mapped by the caller. */
class DisconnectError extends Error {}

function lineToLatin1(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A byte-oriented CRLF line reader over a socket stream. */
class LineReader {
  private buffer = "";
  private reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(readable: ReadableStream<Uint8Array>) {
    this.reader = readable.getReader();
  }

  async readLine(timeoutMs: number): Promise<string> {
    for (;;) {
      const index = this.buffer.indexOf("\r\n");
      if (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        return line;
      }
      const chunk = await withTimeout(this.reader.read(), timeoutMs, () => new DisconnectError("read timed out"));
      if (chunk.done) throw new DisconnectError("connection closed by server");
      this.buffer += lineToLatin1(chunk.value);
    }
  }

  release(): void {
    try {
      this.reader.releaseLock();
    } catch {
      // already released
    }
  }
}

async function readReply(reader: LineReader, timeoutMs: number): Promise<Reply> {
  const lines: string[] = [];
  const first = await reader.readLine(timeoutMs);
  lines.push(first);
  const match = /^(\d{3})([ -])(.*)$/.exec(first);
  if (!match) throw new SmtpError("smtp_protocol", "greeting", `malformed reply line: ${first.slice(0, 100)}`);
  const code = Number(match[1]);
  let continued = match[2] === "-";
  while (continued) {
    const line = await reader.readLine(timeoutMs);
    lines.push(line);
    const next = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!next) throw new SmtpError("smtp_protocol", "reply", `malformed reply line: ${line.slice(0, 100)}`);
    if (Number(next[1]) !== code) throw new SmtpError("smtp_protocol", "reply", "reply codes do not match");
    continued = next[2] === "-";
  }
  return { code, lines };
}

function is4xx(code: number): boolean {
  return code >= 400 && code <= 499;
}

function is5xx(code: number): boolean {
  return code >= 500 && code <= 599;
}

/** Prefix a dot to any line that starts with one, and ensure CRLF ending. */
export function dotStuff(raw: Uint8Array): Uint8Array {
  const out: number[] = [];
  let atLineStart = true;
  for (const byte of raw) {
    if (atLineStart && byte === 0x2e) out.push(0x2e);
    out.push(byte);
    atLineStart = byte === 0x0a;
  }
  if (out.length < 2 || out[out.length - 1] !== 0x0a || out[out.length - 2] !== 0x0d) {
    out.push(0x0d, 0x0a);
  }
  return new Uint8Array(out);
}

function base64Ascii(value: string): string {
  let binary = "";
  for (const byte of encoder.encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function capabilitiesOf(reply: Reply): Map<string, string> {
  const caps = new Map<string, string>();
  for (const line of reply.lines.slice(1)) {
    const text = line.slice(4);
    const [token, ...rest] = text.split(/\s+/);
    if (token) caps.set(token.toUpperCase(), rest.join(" "));
  }
  return caps;
}

export interface SendMailOptions {
  target: SmtpTarget;
  user: string;
  appPassword: string;
  envelopeFrom: string;
  recipients: string[];
  raw: Uint8Array;
  connectSocket: SmtpSocketFactory;
  timeoutMs?: number;
  dataTimeoutMs?: number;
}

export interface SendMailResult {
  replyCode: number;
  reply: string;
}

/**
 * Submit one message. Throws SmtpError with a stable code; every failure
 * before the final dot means nothing was delivered, while a connection loss
 * after the dot is reported as `send_status_unknown` and must never be
 * retried automatically.
 */
export async function sendMail(options: SendMailOptions): Promise<SendMailResult> {
  const factory = options.connectSocket;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dataTimeoutMs = options.dataTimeoutMs ?? DATA_TIMEOUT_MS;
  const domain = options.envelopeFrom.split("@").pop() || "localhost";
  const ehloHost = domain;

  let socket: SmtpSocket | null = null;
  let reader: LineReader | null = null;
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;

  const writeLine = async (line: string, phase: string): Promise<void> => {
    if (!writer) throw new SmtpError("smtp_protocol", phase, "no connection");
    try {
      await writer.write(encoder.encode(`${line}\r\n`));
    } catch (e) {
      const message = `write failed: ${messageOf(e)}`;
      if (phase === "tls" || phase === "starttls") throw new SmtpError("smtp_tls_failed", phase, message);
      if (phase === "data-final") throw new SmtpError("send_status_unknown", phase, message);
      throw new SmtpError("smtp_unavailable", phase, message);
    }
  };

  const writeRaw = async (bytes: Uint8Array, phase: string): Promise<void> => {
    if (!writer) throw new SmtpError("smtp_protocol", phase, "no connection");
    try {
      await writer.write(bytes);
    } catch (e) {
      const message = `write failed: ${messageOf(e)}`;
      // A failure while (or after) writing the terminating dot is ambiguous:
      // the message may already have been submitted, so it is never retried.
      if (phase === "data-final") throw new SmtpError("send_status_unknown", phase, message);
      throw new SmtpError("smtp_unavailable", phase, message);
    }
  };

  const expect = async (phase: string, expected: number[]): Promise<Reply> => {
    if (!reader) throw new SmtpError("smtp_protocol", phase, "no connection");
    let reply: Reply;
    try {
      reply = await readReply(reader, phase === "data-final" ? dataTimeoutMs : timeoutMs);
    } catch (e) {
      if (e instanceof SmtpError) throw e;
      if (e instanceof DisconnectError) {
        if (phase === "data-final") {
          throw new SmtpError("send_status_unknown", phase, "connection lost after the message was submitted");
        }
        if (phase === "tls" || phase === "starttls") {
          throw new SmtpError("smtp_tls_failed", phase, `TLS step failed: ${e.message}`);
        }
        throw new SmtpError("smtp_unavailable", phase, `connection failed: ${e.message}`);
      }
      throw e;
    }
    if (!expected.includes(Math.floor(reply.code / 100))) {
      throw mapReplyError(phase, reply);
    }
    return reply;
  };

  try {
    try {
      socket = factory(options.target);
    } catch (e) {
      throw new SmtpError("smtp_unavailable", "connect", `could not open a connection: ${messageOf(e)}`);
    }
    reader = new LineReader(socket.readable);
    writer = socket.writable.getWriter();

    await expect("greeting", [2]);

    // EHLO over the plaintext connection, read before any TLS decision so a
    // missing STARTTLS fails closed before AUTH is attempted.
    await writeLine(`EHLO ${ehloHost}`, "ehlo");
    const ehloPlain = await expect("ehlo", [2]);
    let caps = capabilitiesOf(ehloPlain);

    if (options.target.mode === "starttls") {
      if (!caps.has("STARTTLS")) {
        throw new SmtpError("smtp_tls_failed", "starttls", "the server did not offer STARTTLS");
      }
      await writeLine("STARTTLS", "starttls");
      await expect("starttls", [2]);
      // The streams must be unlocked before upgrading.
      reader.release();
      writer.releaseLock();
      writer = null;
      try {
        socket = socket.startTls({ expectedServerHostname: options.target.host });
      } catch (e) {
        throw new SmtpError("smtp_tls_failed", "tls", `TLS upgrade failed: ${messageOf(e)}`);
      }
      reader = new LineReader(socket.readable);
      writer = socket.writable.getWriter();
      await writeLine(`EHLO ${ehloHost}`, "tls");
      const ehloTls = await expect("tls", [2]);
      caps = capabilitiesOf(ehloTls);
    }

    const auth = caps.get("AUTH") ?? "";
    if (!/(^|\s)PLAIN(\s|$)/i.test(auth)) {
      throw new SmtpError("smtp_auth_failed", "auth", "the server does not advertise AUTH PLAIN");
    }
    await writeLine(`AUTH PLAIN ${base64Ascii(`\u0000${options.user}\u0000${options.appPassword}`)}`, "auth");
    await expect("auth", [2]);

    let sizeSuffix = "";
    const sizeLimit = Number((caps.get("SIZE") ?? "").trim());
    if (Number.isSafeInteger(sizeLimit) && sizeLimit > 0) {
      if (options.raw.byteLength > sizeLimit) {
        throw new SmtpError("smtp_too_large", "mail", `message is ${options.raw.byteLength} bytes, over the server limit`);
      }
      sizeSuffix = ` SIZE=${options.raw.byteLength}`;
    }
    await writeLine(`MAIL FROM:<${options.envelopeFrom}>${sizeSuffix}`, "mail");
    await expect("mail", [2]);

    for (let index = 0; index < options.recipients.length; index += 1) {
      await writeLine(`RCPT TO:<${options.recipients[index]}>`, "rcpt");
      try {
        await expect("rcpt", [2]);
      } catch (e) {
        if (e instanceof SmtpError && e.code === "smtp_recipient_rejected") {
          e.recipientIndex = index;
        }
        throw e;
      }
    }

    await writeLine("DATA", "data");
    await expect("data", [3]);

    await writeRaw(dotStuff(options.raw), "data");
    await writeRaw(encoder.encode(".\r\n"), "data-final");
    const final = await expect("data-final", [2]);

    try {
      await writeLine("QUIT", "quit");
      // Best effort, short timeout, never fatal.
      await withTimeout(readReply(reader, QUIT_TIMEOUT_MS), QUIT_TIMEOUT_MS, () => new DisconnectError("quit timed out"));
    } catch {
      // ignore
    }

    return { replyCode: final.code, reply: final.lines.join(" ") };
  } finally {
    try {
      writer?.releaseLock();
    } catch {
      // ignore
    }
    reader?.release();
    try {
      await socket?.close();
    } catch {
      // ignore
    }
  }
}

function mapReplyError(phase: string, reply: Reply): SmtpError {
  const code = reply.code;
  const summary = reply.lines.join(" ");
  if (phase === "auth") {
    return is4xx(code)
      ? new SmtpError("smtp_unavailable", phase, `temporary authentication failure (${code})`, { replyCode: code })
      : new SmtpError("smtp_auth_failed", phase, `authentication was rejected (${code})`, { replyCode: code });
  }
  if (phase === "mail") {
    if (code === 552) return new SmtpError("smtp_too_large", phase, `the server rejected the message size (${code})`, { replyCode: code });
    return is4xx(code)
      ? new SmtpError("smtp_unavailable", phase, `mail submission is temporarily unavailable (${code})`, { replyCode: code })
      : new SmtpError("smtp_sender_rejected", phase, `the sender address was rejected (${code})`, { replyCode: code });
  }
  if (phase === "rcpt") {
    if (code === 552) return new SmtpError("smtp_too_large", phase, `the server rejected the message size (${code})`, { replyCode: code });
    return is4xx(code)
      ? new SmtpError("smtp_unavailable", phase, `recipient delivery is temporarily unavailable (${code})`, { replyCode: code })
      : new SmtpError("smtp_recipient_rejected", phase, `a recipient was rejected (${code})`, { replyCode: code });
  }
  if (phase === "data-final") {
    return is4xx(code)
      ? new SmtpError("smtp_unavailable", phase, `the message was not accepted (${code})`, { replyCode: code })
      : new SmtpError("smtp_rejected", phase, `the message was rejected (${code})`, { replyCode: code });
  }
  if (phase === "greeting" && is5xx(code)) {
    return new SmtpError("smtp_rejected", phase, `the server refused the connection (${code})`, { replyCode: code });
  }
  if (phase === "data" && is5xx(code)) {
    return new SmtpError("smtp_rejected", phase, `the server refused the message (${code})`, { replyCode: code });
  }
  if (is4xx(code)) {
    return new SmtpError("smtp_unavailable", phase, `temporary SMTP failure (${code}: ${summary.slice(0, 120)})`, { replyCode: code });
  }
  return new SmtpError("smtp_rejected", phase, `SMTP failure (${code}: ${summary.slice(0, 120)})`, { replyCode: code });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
