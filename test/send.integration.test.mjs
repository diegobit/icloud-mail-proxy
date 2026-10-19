// Direct send against a real local workerd: the MCP tools, the SendLedger
// Durable Object and the SMTP client, with a scripted fake SMTP server on
// loopback (the SMTP_HOST/SMTP_PORT override is honored only for
// 127.0.0.1/localhost). iCloud is never contacted: save_draft's APPEND and the
// read path would need a fake IMAP server, so the live checks cover them.

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  freePort,
  mcpToolCall,
  mcpToolsListDetailed,
  oauthExchange,
  startWorker,
  TOKEN_A,
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

async function sendMail(base, token, args) {
  return mcpToolCall(base, token, "send_mail", { to: ["marco@example.org"], text: "Ciao", ...args });
}

const APPROVAL_TOOLS = ["create_draft", "list_drafts", "get_draft", "discard_draft", "save_draft_to_icloud"];

describe("direct send end to end", () => {
  let dir;
  let current;
  let smtp;

  beforeAll(async () => {
    smtp = await startFakeSmtp();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-send-"));
    current = await startWorker(TOKEN_A, path.join(dir, "state"), await freePort(), {
      SMTP_HOST: { type: "plain_text", value: "127.0.0.1" },
      SMTP_PORT: { type: "plain_text", value: String(smtp.port) },
      SEND_MAX_PER_DAY: { type: "plain_text", value: "8" },
    });
  }, 180_000);

  afterAll(async () => {
    await current?.worker.dispose();
    await smtp?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it("exposes send_mail and save_draft, and none of the approval tools", async () => {
    const listed = await mcpToolsListDetailed(current.base, TOKEN_A);
    const tools = listed.map((tool) => tool.name);
    expect(tools).toContain("send_mail");
    expect(tools).toContain("save_draft");
    for (const name of APPROVAL_TOOLS) expect(tools).not.toContain(name);
    expect(smtp.state.connections).toBe(0);

    // Clients rely on the annotations to decide how to prompt: the read tools
    // must be marked read-only, the sending ones explicitly not.
    const byName = new Map(listed.map((tool) => [tool.name, tool]));
    for (const readTool of ["list_mailboxes", "search_mail", "get_mail_message", "get_mail_attachment"]) {
      expect(byName.get(readTool)?.annotations?.readOnlyHint, readTool).toBe(true);
    }
    const send = byName.get("send_mail")?.annotations;
    expect(send?.readOnlyHint).toBe(false);
    expect(send?.openWorldHint).toBe(true);
    expect(send?.idempotentHint).toBe(false);
    const save = byName.get("save_draft")?.annotations;
    expect(save?.readOnlyHint).toBe(false);
    expect(save?.openWorldHint).toBe(false);
  }, 60_000);

  it("sends immediately, once, with every envelope recipient and no Bcc header", async () => {
    const before = smtp.state.connections;
    const result = await sendMail(current.base, TOKEN_A, {
      to: ["marco@example.org"],
      cc: ["anna@example.net"],
      bcc: ["hidden@example.org"],
      subject: "Pranzo",
      text: "Ciao, ci vediamo venerdì.",
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.json.status).toBe("sent");
    expect(result.json.messageId).toMatch(/^<[0-9a-f-]+@example\.com>$/);
    expect(result.json.recipients).toBe(3);
    expect(smtp.state.connections).toBe(before + 1);

    const session = smtp.last();
    expect(session.completed).toBe(true);
    expect(session.mailFrom).toMatch(/^MAIL FROM:<owner@example\.com>( SIZE=\d+)?$/);
    expect(session.recipients).toEqual(["marco@example.org", "anna@example.net", "hidden@example.org"]);
    const wire = session.data.join("\r\n");
    expect(wire).toContain("To: marco@example.org");
    expect(wire).toContain("Cc: anna@example.net");
    expect(wire).not.toContain("Bcc:");
    expect(wire).toContain("Subject: Pranzo");
    expect(wire).toContain("ci vediamo venerd=C3=AC.");
    expect(wire).toContain(`Message-ID: ${result.json.messageId}`);
  }, 60_000);

  it("refuses the identical message within a minute unless allowDuplicate is set", async () => {
    const before = smtp.state.connections;
    const args = { to: ["marco@example.org"], subject: "Doppione", text: "una volta sola" };
    const first = await sendMail(current.base, TOKEN_A, args);
    expect(first.isError, first.text).toBe(false);
    expect(smtp.state.connections).toBe(before + 1);

    // Same content, later attempt: a fresh Date and Message-ID must not hide
    // the duplicate.
    const again = await sendMail(current.base, TOKEN_A, args);
    expect(again.isError).toBe(true);
    expect(again.text).toContain("duplicate_send");
    expect(smtp.state.connections).toBe(before + 1);

    const forced = await sendMail(current.base, TOKEN_A, { ...args, allowDuplicate: true });
    expect(forced.isError, forced.text).toBe(false);
    expect(smtp.state.connections).toBe(before + 2);
  }, 60_000);

  it("reports an SMTP rejection and lets the same message be retried", async () => {
    const before = smtp.state.connections;
    const args = { to: ["marco@example.org"], subject: "Rifiutata", text: "prima volta no" };
    smtp.state.mode = "rcptFail";
    const rejected = await sendMail(current.base, TOKEN_A, args);
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("smtp_recipient_rejected");
    expect(smtp.state.connections).toBe(before + 1);

    // The failure released both the quota and the duplicate claim.
    smtp.state.mode = "ok";
    const retried = await sendMail(current.base, TOKEN_A, args);
    expect(retried.isError, retried.text).toBe(false);
    expect(smtp.state.connections).toBe(before + 2);
  }, 60_000);

  it("keeps an ambiguous outcome from being retried blindly", async () => {
    const before = smtp.state.connections;
    const args = { to: ["marco@example.org"], subject: "Incerta", text: "forse partita" };
    smtp.state.mode = "dropAfterData";
    const unknown = await sendMail(current.base, TOKEN_A, args);
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("send_status_unknown");
    expect(smtp.state.connections).toBe(before + 1);

    // The hash is kept, so an identical resend is refused rather than sent twice.
    smtp.state.mode = "ok";
    const blindRetry = await sendMail(current.base, TOKEN_A, args);
    expect(blindRetry.isError).toBe(true);
    expect(blindRetry.text).toContain("duplicate_send");
    expect(smtp.state.connections).toBe(before + 1);
  }, 60_000);

  it("validates recipients, subjects and caps before touching SMTP", async () => {
    const connections = smtp.state.connections;
    const badRecipient = await sendMail(current.base, TOKEN_A, {
      to: ["a@b.co\r\nBcc: evil@example.com"],
      text: "x",
    });
    expect(badRecipient.isError).toBe(true);
    expect(badRecipient.text).toContain("invalid_address");

    const badSubject = await sendMail(current.base, TOKEN_A, { subject: "ok\r\nBcc: evil@example.com", text: "x" });
    expect(badSubject.isError).toBe(true);

    const tooMany = await sendMail(current.base, TOKEN_A, {
      to: Array.from({ length: 6 }, (_, index) => `u${index}@example.com`),
      text: "x",
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toContain("recipients");

    expect(smtp.state.connections).toBe(connections);
  }, 60_000);

  it("exposes save_draft, which validates without contacting anything", async () => {
    const invalid = await mcpToolCall(current.base, TOKEN_A, "save_draft", {
      to: ["not an address"],
      text: "x",
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.text).toContain("invalid_address");
    // A valid save_draft would APPEND to the real iCloud Drafts folder; that
    // path is covered by the session tests and the live acceptance run.
    expect(invalid.isError).toBe(true);
  }, 60_000);

  it("lets an OAuth grant send as well", async () => {
    const before = smtp.state.connections;
    const tokens = await oauthExchange(current.base, TOKEN_A);
    const result = await sendMail(current.base, tokens.access_token, {
      subject: "Da OAuth",
      text: "ciao dal grant",
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.json.status).toBe("sent");
    expect(smtp.state.connections).toBe(before + 1);
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

  it("uses the configured From and refuses past the daily cap, releasing a failed attempt", async () => {
    const args = { to: ["marco@example.org"], subject: "Uno", text: "prima" };

    // With a cap of one message, a failed attempt must give the quota back...
    smtp.state.mode = "rcptFail";
    const rejected = await sendMail(current.base, TOKEN_A, args);
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("smtp_recipient_rejected");
    expect(smtp.state.connections).toBe(1);

    // ...so the retry of the very same message goes through, using the alias.
    smtp.state.mode = "ok";
    const first = await sendMail(current.base, TOKEN_A, args);
    expect(first.isError, first.text).toBe(false);
    expect(smtp.state.connections).toBe(2);
    const session = smtp.last();
    expect(session.mailFrom).toMatch(/^MAIL FROM:<alias@icloud\.com>( SIZE=\d+)?$/);
    expect(session.data.join("\r\n")).toContain('From: "Diego" <alias@icloud.com>');

    // The cap is now genuinely consumed: a different message is refused.
    const blocked = await sendMail(current.base, TOKEN_A, { subject: "Due", text: "seconda" });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("daily_limit_reached");
    expect(smtp.state.connections).toBe(2);
  }, 60_000);
});
