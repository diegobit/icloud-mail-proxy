// Outgoing mail end to end against a real local workerd: the MCP draft tools,
// the /send/approve page, the SendLedger Durable Object and the SMTP client,
// with a scripted fake SMTP server on loopback (the SMTP_HOST/SMTP_PORT
// override is honored only for 127.0.0.1/localhost). iCloud is never
// contacted: the only network endpoints are the local Worker and the fake
// server.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  freePort,
  hidden,
  mcpToolCall,
  mcpToolsList,
  oauthExchange,
  postForm,
  startWorker,
  TOKEN_A,
  TOKEN_B,
} from "./support/oauth-flow.mjs";

/** A scripted SMTP server: enough of the protocol to drive every path. */
function startFakeSmtp() {
  const state = { mode: "ok", connections: 0, sessions: [] };
  const server = net.createServer((socket) => {
    const session = { auth: null, mailFrom: null, recipients: [], data: [], completed: false };
    state.connections += 1;
    state.sessions.push(session);
    let buffer = "";
    let inData = false;
    const write = (line) => socket.write(`${line}\r\n`);
    write("220 fake ESMTP");
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1");
      for (;;) {
        const index = buffer.indexOf("\r\n");
        if (index < 0) return;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line.startsWith("EHLO")) {
          write("250-fake");
          write("250-AUTH PLAIN LOGIN");
          write("250 SIZE 10485760");
          continue;
        }
        if (line.startsWith("AUTH ")) {
          session.auth = line;
          write("235 ok");
          continue;
        }
        if (line.startsWith("MAIL FROM:")) {
          session.mailFrom = line;
          write("250 ok");
          continue;
        }
        if (line.startsWith("RCPT TO:")) {
          session.recipients.push(line.slice("RCPT TO:<".length, -1));
          const failFirst = state.mode === "rcptFail" && session.recipients.length === 1;
          write(failFirst ? "550 5.1.1 no such user" : "250 ok");
          continue;
        }
        if (line === "DATA") {
          if (state.mode === "dropAfterDataCommand") {
            socket.destroy();
            return;
          }
          write("354 go ahead");
          inData = true;
          continue;
        }
        if (inData) {
          if (line === ".") {
            inData = false;
            if (state.mode === "dropAfterData") {
              socket.destroy();
              return;
            }
            session.completed = true;
            write("250 2.0.0 queued as 4242");
            continue;
          }
          session.data.push(line);
          continue;
        }
        if (line === "QUIT") {
          write("221 bye");
          socket.end();
          return;
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        state,
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
        last: () => state.sessions[state.sessions.length - 1],
      });
    });
  });
}

async function createDraft(base, token, args) {
  const result = await mcpToolCall(base, token, "create_draft", args);
  expect(result.isError, result.text).toBe(false);
  return result.json;
}

function signIn(base, draftId, token) {
  return postForm(`${base}/send/approve`, { d: draftId, action: "login", token });
}

async function openDraft(base, draftId, cookie) {
  const res = await fetch(`${base}/send/approve?d=${draftId}`, cookie ? { headers: { Cookie: cookie } } : undefined);
  return { res, html: await res.text() };
}

function sendDraft(base, draftId, nonce, cookie) {
  return postForm(`${base}/send/approve`, { d: draftId, action: "send", nonce }, { headers: { Cookie: cookie } });
}

async function signInAndOpen(base, draftId, token) {
  const login = await signIn(base, draftId, token);
  const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  const opened = await openDraft(base, draftId, cookie);
  return { login, cookie, html: opened.html, nonce: hidden(opened.html, "nonce") };
}

describe("sending mail end to end", () => {
  let dir;
  let current;
  let smtp;
  let first;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-send-"));
    current = await startWorker(TOKEN_A, path.join(dir, "state"), await freePort(), {
      SMTP_HOST: { type: "plain_text", value: "127.0.0.1" },
      SMTP_PORT: { type: "plain_text", value: String(smtp.port) },
    });
  }, 180_000);

  afterAll(async () => {
    await current?.worker.dispose();
    await smtp?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("exposes the draft tools and never touches SMTP when a draft is created", async () => {
    const tools = await mcpToolsList(current.base, TOKEN_A);
    for (const name of ["create_draft", "list_drafts", "get_draft", "discard_draft", "save_draft_to_icloud"]) {
      expect(tools).toContain(name);
    }

    first = await createDraft(current.base, TOKEN_A, {
      to: ["marco@example.org"],
      cc: ["anna@example.net"],
      bcc: ["hidden@example.org"],
      subject: "Pranzo",
      text: "Ciao, ci vediamo venerdì.",
    });
    expect(first.status).toBe("ready");
    expect(first.approveUrl).toBe(`${current.base}/send/approve?d=${first.draftId}`);
    expect(first.preview.subject).toBe("Pranzo");
    expect(first.preview.bcc).toEqual(["hidden@example.org"]);
    expect(first.preview.text).toContain("venerdì");
    expect(smtp.state.connections).toBe(0);
  }, 60_000);

  it("keeps the draft hidden until the owner signs in with the API token", async () => {
    const anonymous = await openDraft(current.base, first.draftId);
    expect(anonymous.res.status).toBe(200);
    expect(anonymous.html).toContain("Approve a draft");
    expect(anonymous.html).not.toContain("Pranzo");
    expect(anonymous.res.headers.get("cache-control")).toBe("private, no-store");

    const wrong = await signIn(current.base, first.draftId, "not-the-token");
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const session = await signInAndOpen(current.base, first.draftId, TOKEN_A);
    expect(session.login.status).toBe(303);
    expect(session.login.headers.get("location")).toBe(`/send/approve?d=${first.draftId}`);
    expect(session.cookie.startsWith("__Host-send=")).toBe(true);
    expect(session.html).toContain("Pranzo");
    expect(session.html).toContain("ci vediamo venerdì.");
    expect(session.html).toContain('name="action" value="send"');
    first.cookie = session.cookie;
    first.nonce = session.nonce;
  }, 60_000);

  it("sends exactly the stored message once the owner confirms", async () => {
    const sent = await sendDraft(current.base, first.draftId, first.nonce, first.cookie);
    expect(sent.status).toBe(200);
    expect(await sent.text()).toContain("Message sent");
    expect(smtp.state.connections).toBe(1);

    const session = smtp.last();
    expect(session.completed).toBe(true);
    expect(session.auth).toMatch(/^AUTH PLAIN /);
    expect(session.mailFrom).toMatch(/^MAIL FROM:<owner@example\.com>( SIZE=\d+)?$/);
    expect(session.recipients).toEqual(["marco@example.org", "anna@example.net", "hidden@example.org"]);
    const wire = session.data.join("\r\n");
    expect(wire).toContain("To: marco@example.org");
    expect(wire).toContain("Cc: anna@example.net");
    expect(wire).not.toContain("Bcc:");
    expect(wire).toContain("Subject: Pranzo");
    expect(wire).toContain("ci vediamo venerd=C3=AC.");
    expect(wire).toContain("Content-Transfer-Encoding: quoted-printable");
  }, 60_000);

  it("never sends the same draft twice", async () => {
    const again = await sendDraft(current.base, first.draftId, first.nonce, first.cookie);
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("Already sent");
    expect(smtp.state.connections).toBe(1);
  }, 60_000);

  it("refuses a wrong nonce, reports an SMTP rejection, then blocks the draft", async () => {
    const second = await createDraft(current.base, TOKEN_A, {
      to: ["marco@example.org"],
      subject: "Bozza 2",
      text: "seconda",
    });
    const opened = await openDraft(current.base, second.draftId, first.cookie);
    const nonce = hidden(opened.html, "nonce");

    const wrongNonce = await sendDraft(current.base, second.draftId, "not-the-nonce", first.cookie);
    expect(wrongNonce.status).toBe(403);
    expect(smtp.state.connections).toBe(1);
    expect((await openDraft(current.base, second.draftId, first.cookie)).html).toContain('name="action" value="send"');

    smtp.state.mode = "rcptFail";
    const rejected = await sendDraft(current.base, second.draftId, nonce, first.cookie);
    expect(rejected.status).toBe(502);
    expect(await rejected.text()).toContain("Rejected");
    expect(smtp.state.connections).toBe(2);
    expect((await openDraft(current.base, second.draftId, first.cookie)).html).toContain("can no longer be sent");
    smtp.state.mode = "ok";
  }, 60_000);

  it("records an ambiguous outcome when the connection drops after DATA", async () => {
    const third = await createDraft(current.base, TOKEN_A, {
      to: ["marco@example.org"],
      subject: "Bozza 3",
      text: "terza",
    });
    const opened = await openDraft(current.base, third.draftId, first.cookie);
    const nonce = hidden(opened.html, "nonce");

    smtp.state.mode = "dropAfterData";
    const unknown = await sendDraft(current.base, third.draftId, nonce, first.cookie);
    expect(unknown.status).toBe(200);
    expect(await unknown.text()).toContain("Delivery state unknown");
    expect(smtp.state.connections).toBe(3);

    const retry = await sendDraft(current.base, third.draftId, nonce, first.cookie);
    expect(await retry.text()).toContain("Delivery state unknown");
    expect(smtp.state.connections).toBe(3);
    smtp.state.mode = "ok";
  }, 60_000);

  it("validates recipients, subjects and caps before storing anything", async () => {
    const badRecipient = await mcpToolCall(current.base, TOKEN_A, "create_draft", {
      to: ["a@b.co\r\nBcc: evil@example.com"],
      text: "x",
    });
    expect(badRecipient.isError).toBe(true);
    expect(badRecipient.text).toContain("invalid_address");

    const badSubject = await mcpToolCall(current.base, TOKEN_A, "create_draft", {
      to: ["a@example.com"],
      subject: "ok\r\nBcc: evil@example.com",
      text: "x",
    });
    expect(badSubject.isError).toBe(true);

    const tooMany = await mcpToolCall(current.base, TOKEN_A, "create_draft", {
      to: Array.from({ length: 6 }, (_, index) => `u${index}@example.com`),
      text: "x",
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain("recipients");

    expect(smtp.state.connections).toBe(3);
  }, 60_000);

  it("binds drafts to the OAuth client that created them", async () => {
    const tokens = await oauthExchange(current.base, TOKEN_A);
    const draft = await createDraft(current.base, tokens.access_token, {
      to: ["marco@example.org"],
      subject: "OAuth draft",
      text: "ciao",
    });
    expect(draft.draftId).toBeTruthy();

    const other = await mcpToolCall(current.base, TOKEN_A, "get_draft", { draftId: draft.draftId });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("draft_not_found");

    const own = await mcpToolCall(current.base, tokens.access_token, "get_draft", { draftId: draft.draftId });
    expect(own.isError).toBe(false);
    expect(own.json.draftId).toBe(draft.draftId);

    const listed = await mcpToolCall(current.base, TOKEN_A, "list_drafts", {});
    expect(listed.isError).toBe(false);
    expect(listed.json.drafts.map((entry) => entry.draftId)).not.toContain(draft.draftId);

    const discarded = await mcpToolCall(current.base, tokens.access_token, "discard_draft", {
      draftId: draft.draftId,
    });
    expect(discarded.isError).toBe(false);
    expect(discarded.json).toEqual({ discarded: true });
  }, 120_000);
});

describe("daily cap and From identity", () => {
  let dir;
  let current;
  let smtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-send-cap-"));
    current = await startWorker(TOKEN_A, path.join(dir, "state"), await freePort(), {
      SMTP_HOST: { type: "plain_text", value: "127.0.0.1" },
      SMTP_PORT: { type: "plain_text", value: String(smtp.port) },
      SEND_MAX_PER_DAY: { type: "plain_text", value: "1" },
      SEND_FROM: { type: "plain_text", value: "alias@icloud.com" },
      SEND_FROM_NAME: { type: "plain_text", value: "Diego" },
    });
  }, 180_000);

  afterAll(async () => {
    await current?.worker.dispose();
    await smtp?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("uses the configured From and refuses past the daily cap", async () => {
    const firstDraft = await createDraft(current.base, TOKEN_A, {
      to: ["marco@example.org"],
      subject: "Uno",
      text: "prima",
    });
    expect(firstDraft.preview.from).toBe("Diego <alias@icloud.com>");

    const session = await signInAndOpen(current.base, firstDraft.draftId, TOKEN_A);
    const sent = await sendDraft(current.base, firstDraft.draftId, session.nonce, session.cookie);
    expect(await sent.text()).toContain("Message sent");
    expect(smtp.last().mailFrom).toMatch(/^MAIL FROM:<alias@icloud\.com>( SIZE=\d+)?$/);
    expect(smtp.state.connections).toBe(1);

    const secondDraft = await createDraft(current.base, TOKEN_A, {
      to: ["marco@example.org"],
      subject: "Due",
      text: "seconda",
    });
    const second = await openDraft(current.base, secondDraft.draftId, session.cookie);
    const blocked = await sendDraft(
      current.base,
      secondDraft.draftId,
      hidden(second.html, "nonce"),
      session.cookie,
    );
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("Daily limit reached");
    expect(smtp.state.connections).toBe(1);
  }, 60_000);
});

describe("draft expiry", () => {
  let dir;
  let current;
  let smtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-send-ttl-"));
    current = await startWorker(TOKEN_A, path.join(dir, "state"), await freePort(), {
      SMTP_HOST: { type: "plain_text", value: "127.0.0.1" },
      SMTP_PORT: { type: "plain_text", value: String(smtp.port) },
      SEND_DRAFT_TTL_SECONDS: { type: "plain_text", value: "1" },
    });
  }, 180_000);

  afterAll(async () => {
    await current?.worker.dispose();
    await smtp?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("refuses to send an expired draft", async () => {
    const draft = await createDraft(current.base, TOKEN_A, {
      to: ["marco@example.org"],
      subject: "Scade",
      text: "prima che scada",
    });
    const session = await signInAndOpen(current.base, draft.draftId, TOKEN_A);
    await new Promise((resolve) => setTimeout(resolve, 1_300));

    const late = await sendDraft(current.base, draft.draftId, session.nonce, session.cookie);
    expect(late.status).toBe(410);
    expect(await late.text()).toContain("expired");
    expect(smtp.state.connections).toBe(0);
  }, 60_000);
});

describe("rotation revokes approval sessions", () => {
  let dir;
  let current;
  let smtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-send-rotate-"));
    current = await startWorker(TOKEN_A, path.join(dir, "state"), await freePort(), {
      SMTP_HOST: { type: "plain_text", value: "127.0.0.1" },
      SMTP_PORT: { type: "plain_text", value: String(smtp.port) },
    });
  }, 180_000);

  afterAll(async () => {
    await current?.worker.dispose();
    await smtp?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("invalidates the cookie, keeps the draft and sends after re-signing in", async () => {
    const draft = await createDraft(current.base, TOKEN_A, {
      to: ["marco@example.org"],
      subject: "Rotazione",
      text: "sopravvive al restart",
    });
    const session = await signInAndOpen(current.base, draft.draftId, TOKEN_A);

    const origin = current.port;
    await current.worker.dispose();
    current = await startWorker(TOKEN_B, path.join(dir, "state"), origin, {
      SMTP_HOST: { type: "plain_text", value: "127.0.0.1" },
      SMTP_PORT: { type: "plain_text", value: String(smtp.port) },
    });

    const stale = await sendDraft(current.base, draft.draftId, session.nonce, session.cookie);
    expect(stale.status).toBe(401);
    expect(await stale.text()).toContain("Sign in to continue");
    expect(smtp.state.connections).toBe(0);

    const again = await signInAndOpen(current.base, draft.draftId, TOKEN_B);
    expect(again.login.status).toBe(303);
    const sent = await sendDraft(current.base, draft.draftId, again.nonce, again.cookie);
    expect(await sent.text()).toContain("Message sent");
    expect(smtp.state.connections).toBe(1);
  }, 180_000);
});
