import { describe, expect, it } from "vitest";
import {
  dotStuff,
  resolveSmtpTarget,
  sendMail,
  SmtpError,
  socketOptionsFor,
  type SmtpSocket,
  type SmtpSocketFactory,
  type SmtpTarget,
} from "../src/smtp";

const ENC = new TextEncoder();
const DEC = new TextDecoder("latin1");

/** Server side of an in-memory SMTP session with scripted behaviours. */
class ServerSide {
  private buffer = "";
  dataLines: string[] = [];
  events: string[] = [];
  constructor(
    private reader: ReadableStreamDefaultReader<Uint8Array>,
    private writer: WritableStreamDefaultWriter<Uint8Array>,
  ) {}

  async line(): Promise<string> {
    for (;;) {
      const index = this.buffer.indexOf("\r\n");
      if (index >= 0) {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 2);
        return line;
      }
      const { value, done } = await this.reader.read();
      if (done) throw new Error("client closed the connection");
      if (value) this.buffer += DEC.decode(value);
    }
  }

  async send(text: string): Promise<void> {
    await this.writer.write(ENC.encode(text));
  }

  async closeOutput(): Promise<void> {
    await this.writer.close().catch(() => {});
  }
}

interface FakeOptions {
  mode?: "plaintext" | "starttls";
  noStartTls?: boolean;
  sizeAdvertise?: number;
  greeting?: string;
  hangGreeting?: boolean;
  authReply?: string;
  mailReply?: string;
  rcptReply?: (index: number) => string;
  dataReply?: string;
  finalReply?: string;
  dropAfterDataCommand?: boolean;
  dropAfterData?: boolean;
}

function startFake(options: FakeOptions = {}) {
  const c2s = new TransformStream<Uint8Array, Uint8Array>();
  const s2c = new TransformStream<Uint8Array, Uint8Array>();
  const server = new ServerSide(c2s.readable.getReader(), s2c.writable.getWriter());
  const mode = options.mode ?? "plaintext";

  let tlsCalls = 0;
  let startTlsLocks: { readable: boolean; writable: boolean } | null = null;
  let quitSeen = false;

  const socket: SmtpSocket = {
    readable: s2c.readable,
    writable: c2s.writable,
    startTls: (tlsOptions) => {
      tlsCalls += 1;
      startTlsLocks = { readable: s2c.readable.locked, writable: c2s.writable.locked };
      (socket as { lastTlsHost?: string }).lastTlsHost = tlsOptions?.expectedServerHostname;
      return socket;
    },
    close: async () => {},
  };

  const run = async (): Promise<void> => {
    if (options.hangGreeting) {
      // Read forever so the socket stays open with no reply.
      try {
        for (;;) await server.line();
      } catch {
        return;
      }
    }
    await server.send(`${options.greeting ?? "220 fake ESMTP"}\r\n`);
    let tls = false;
    for (;;) {
      const line = await server.line();
      server.events.push(line);
      if (line.startsWith("EHLO")) {
        const middle = ["250-fake", "250-AUTH PLAIN LOGIN"];
        if (mode === "starttls" && !tls && options.noStartTls !== true) middle.push("250-STARTTLS");
        for (const entry of middle) await server.send(`${entry}\r\n`);
        await server.send(`250 SIZE ${options.sizeAdvertise ?? 1_000_000}\r\n`);
        continue;
      }
      if (line === "STARTTLS") {
        await server.send("220 go ahead\r\n");
        tls = true;
        continue;
      }
      if (line.startsWith("AUTH ")) {
        await server.send(`${options.authReply ?? "235 ok"}\r\n`);
        continue;
      }
      if (line.startsWith("MAIL FROM")) {
        await server.send(`${options.mailReply ?? "250 ok"}\r\n`);
        continue;
      }
      if (line.startsWith("RCPT TO")) {
        const index = server.events.filter((entry) => entry.startsWith("RCPT TO")).length - 1;
        await server.send(`${options.rcptReply?.(index) ?? "250 ok"}\r\n`);
        continue;
      }
      if (line === "DATA") {
        if (options.dropAfterDataCommand) {
          await server.closeOutput();
          return;
        }
        await server.send(`${options.dataReply ?? "354 go ahead"}\r\n`);
        for (;;) {
          const dataLine = await server.line();
          if (dataLine === ".") break;
          server.dataLines.push(dataLine);
        }
        if (options.dropAfterData) {
          await server.closeOutput();
          return;
        }
        await server.send(`${options.finalReply ?? "250 queued as 4242"}\r\n`);
        continue;
      }
      if (line === "QUIT") {
        quitSeen = true;
        await server.send("221 bye\r\n");
        return;
      }
    }
  };

  const runPromise = run().catch(() => {});
  const factory: SmtpSocketFactory = () => socket;
  return {
    factory,
    events: server.events,
    dataLines: server.dataLines,
    get tlsCalls() {
      return tlsCalls;
    },
    get startTlsLocks() {
      return startTlsLocks;
    },
    get lastTlsHost() {
      return (socket as { lastTlsHost?: string }).lastTlsHost;
    },
    get quitSeen() {
      return quitSeen;
    },
    runPromise,
  };
}

const PLAINTEXT: SmtpTarget = { host: "127.0.0.1", port: 2525, mode: "plaintext" };
const STARTTLS: SmtpTarget = { host: "smtp.mail.me.com", port: 587, mode: "starttls" };

function decodeBase64Latin1(base64: string): string {
  return atob(base64);
}

function mail(overrides: Partial<Parameters<typeof sendMail>[0]> & Pick<Parameters<typeof sendMail>[0], "connectSocket">): Parameters<typeof sendMail>[0] {
  return {
    target: PLAINTEXT,
    user: "owner@example.com",
    appPassword: "app-pass",
    envelopeFrom: "owner@example.com",
    recipients: ["a@example.com"],
    raw: ENC.encode("Subject: x\r\n\r\nhello\r\n"),
    timeoutMs: 500,
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; message: string; recipientIndex?: number }> {
  try {
    await promise;
    throw new Error("expected a SmtpError");
  } catch (error) {
    if (!(error instanceof SmtpError)) throw error;
    return { code: error.code, message: error.message, recipientIndex: error.recipientIndex };
  }
}

describe("dotStuff", () => {
  it("prefixes leading dots, keeps CRLF and ensures a trailing terminator", () => {
    expect(DEC.decode(dotStuff(ENC.encode("a\r\n.\r\n..b\r\n")))).toBe("a\r\n..\r\n...b\r\n");
    expect(DEC.decode(dotStuff(ENC.encode("no terminator")))).toBe("no terminator\r\n");
  });
});

describe("resolveSmtpTarget", () => {
  it("falls back to the real iCloud endpoint with STARTTLS", () => {
    expect(resolveSmtpTarget({})).toEqual({ host: "smtp.mail.me.com", port: 587, mode: "starttls" });
    expect(resolveSmtpTarget({ SMTP_HOST: "smtp.evil.example", SMTP_PORT: "2525" })).toEqual({
      host: "smtp.mail.me.com",
      port: 587,
      mode: "starttls",
    });
    expect(resolveSmtpTarget({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "0" }).mode).toBe("starttls");
    expect(resolveSmtpTarget({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "99999" }).mode).toBe("starttls");
  });

  it("honours the loopback test override only", () => {
    expect(resolveSmtpTarget({ SMTP_HOST: "127.0.0.1", SMTP_PORT: "2525" })).toEqual({
      host: "127.0.0.1",
      port: 2525,
      mode: "plaintext",
    });
    expect(resolveSmtpTarget({ SMTP_HOST: "localhost", SMTP_PORT: "2525" }).mode).toBe("plaintext");
  });
});

describe("socketOptionsFor", () => {
  it("requires the starttls socket mode Cloudflare needs for startTls()", () => {
    // Cloudflare only allows startTls() on a socket created with
    // secureTransport: "starttls"; "off" would make every production send
    // throw before AUTH.
    expect(socketOptionsFor({ host: "smtp.mail.me.com", port: 587, mode: "starttls" })).toEqual({
      secureTransport: "starttls",
      allowHalfOpen: false,
    });
    expect(socketOptionsFor({ host: "127.0.0.1", port: 2525, mode: "plaintext" })).toEqual({
      secureTransport: "off",
      allowHalfOpen: false,
    });
  });
});

describe("sendMail (plaintext loopback)", () => {
  it("submits the message with AUTH PLAIN, SIZE, every recipient and QUIT", async () => {
    const fake = startFake();
    const raw = ENC.encode("Subject: x\r\n\r\nline\r\n.\r\nend\r\n");
    const result = await sendMail(
      mail({ raw, recipients: ["a@example.com", "b@example.com"], connectSocket: fake.factory }),
    );
    expect(result.replyCode).toBe(250);
    expect(await fake.runPromise).toBeUndefined();
    expect(fake.quitSeen).toBe(true);

    const authLine = fake.events.find((line) => line.startsWith("AUTH PLAIN "));
    expect(authLine).toBeDefined();
    expect(decodeBase64Latin1(authLine!.slice("AUTH PLAIN ".length))).toBe(
      "\u0000owner@example.com\u0000app-pass",
    );
    expect(fake.events).toContain(`MAIL FROM:<owner@example.com> SIZE=${raw.byteLength}`);
    expect(fake.events.filter((line) => line.startsWith("RCPT TO"))).toEqual([
      "RCPT TO:<a@example.com>",
      "RCPT TO:<b@example.com>",
    ]);
    // The lone-dot line arrives dot-stuffed, and the terminator is separate.
    expect(fake.dataLines).toContain("..");
    expect(fake.dataLines).toContain("end");
  });

  it("never leaks the password in an auth failure", async () => {
    const fake = startFake({ authReply: "535 5.7.8 authentication failed" });
    const failure = await codeOf(sendMail(mail({ connectSocket: fake.factory })));
    expect(failure.code).toBe("smtp_auth_failed");
    expect(failure.message).not.toContain("app-pass");
    expect(failure.message).not.toContain("owner@example.com");
  });

  it("maps MAIL, RCPT and DATA failures to their codes", async () => {
    expect((await codeOf(sendMail(mail({ connectSocket: startFake({ mailReply: "550 5.1.8 sender rejected" }).factory })))).code).toBe(
      "smtp_sender_rejected",
    );
    const recipient = await codeOf(
      sendMail(
        mail({
          recipients: ["a@example.com", "b@example.com"],
          connectSocket: startFake({ rcptReply: (index) => (index === 1 ? "550 no such user" : "250 ok") }).factory,
        }),
      ),
    );
    expect(recipient.code).toBe("smtp_recipient_rejected");
    expect(recipient.recipientIndex).toBe(1);
    expect((await codeOf(sendMail(mail({ connectSocket: startFake({ rcptReply: () => "452 try later" }).factory })))).code).toBe(
      "smtp_unavailable",
    );
    expect((await codeOf(sendMail(mail({ connectSocket: startFake({ mailReply: "552 too big" }).factory })))).code).toBe(
      "smtp_too_large",
    );
    expect((await codeOf(sendMail(mail({ connectSocket: startFake({ finalReply: "554 5.7.1 rejected" }).factory })))).code).toBe(
      "smtp_rejected",
    );
  });

  it("honours the advertised SIZE limit before MAIL FROM", async () => {
    const fake = startFake({ sizeAdvertise: 10 });
    const failure = await codeOf(sendMail(mail({ connectSocket: fake.factory })));
    expect(failure.code).toBe("smtp_too_large");
    expect(fake.events.some((line) => line.startsWith("MAIL FROM"))).toBe(false);
  });

  it("reports an ambiguous outcome when the connection drops after the final dot", async () => {
    const fake = startFake({ dropAfterData: true });
    const failure = await codeOf(sendMail(mail({ connectSocket: fake.factory })));
    expect(failure.code).toBe("send_status_unknown");
  });

  it("treats an unreadable reply after the final dot as unknown, never a retry", async () => {
    const fake = startFake({ finalReply: "this is not an SMTP reply" });
    const failure = await codeOf(sendMail(mail({ connectSocket: fake.factory })));
    expect(failure.code).toBe("send_status_unknown");
  });

  it("times out a write that never completes instead of hanging the approval", async () => {
    const c2s = new TransformStream<Uint8Array, Uint8Array>();
    const s2c = new TransformStream<Uint8Array, Uint8Array>();
    const writer = s2c.writable.getWriter();
    const reader = c2s.readable.getReader();
    // Greet, then consume everything while the client's writes hang. The
    // write is not awaited: a TransformStream's write resolves only once a
    // reader attaches.
    void writer.write(ENC.encode("220 fake ESMTP\r\n"));
    const drain = (async () => {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    })().catch(() => {});
    const stuck: SmtpSocket = {
      readable: s2c.readable,
      writable: new WritableStream<Uint8Array>({
        write: () => new Promise(() => {
          /* never resolves */
        }),
      }),
      startTls: () => stuck,
      close: async () => {},
    };
    const failure = await codeOf(
      sendMail(mail({ connectSocket: () => stuck, timeoutMs: 50, dataTimeoutMs: 50 })),
    );
    expect(failure.code).toBe("smtp_unavailable");
    void drain;
  });

  it("rejects the message when the connection drops before DATA is accepted", async () => {
    const fake = startFake({ dropAfterDataCommand: true });
    const failure = await codeOf(sendMail(mail({ connectSocket: fake.factory })));
    expect(failure.code).toBe("smtp_unavailable");
  });

  it("times out as temporarily unavailable when the server never greets", async () => {
    const fake = startFake({ hangGreeting: true });
    const failure = await codeOf(sendMail(mail({ connectSocket: fake.factory, timeoutMs: 50 })));
    expect(failure.code).toBe("smtp_unavailable");
  });
});

describe("sendMail (STARTTLS)", () => {
  it("refuses to authenticate when the server does not offer STARTTLS", async () => {
    const fake = startFake({ mode: "starttls", noStartTls: true });
    const failure = await codeOf(sendMail(mail({ target: STARTTLS, connectSocket: fake.factory })));
    expect(failure.code).toBe("smtp_tls_failed");
    expect(fake.events.some((line) => line.startsWith("AUTH"))).toBe(false);
    expect(fake.tlsCalls).toBe(0);
  });

  it("releases the streams before upgrading and re-EHLOs over TLS", async () => {
    const fake = startFake({ mode: "starttls" });
    const result = await sendMail(mail({ target: STARTTLS, connectSocket: fake.factory }));
    expect(result.replyCode).toBe(250);
    expect(fake.tlsCalls).toBe(1);
    expect(fake.startTlsLocks).toEqual({ readable: false, writable: false });
    expect(fake.lastTlsHost).toBe("smtp.mail.me.com");
    expect(fake.events.filter((line) => line.startsWith("EHLO"))).toHaveLength(2);
    expect(fake.events.indexOf("STARTTLS")).toBeGreaterThan(0);
    const authIndex = fake.events.findIndex((line) => line.startsWith("AUTH"));
    expect(authIndex).toBeGreaterThan(fake.events.indexOf("STARTTLS"));
  });
});
