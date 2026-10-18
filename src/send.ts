// Composition and the two send-side operations (plans/email-send.md,
// "Owner revision": direct send and a real iCloud draft; no approval page).
//
// This module validates caller input, fetches what replies and forwards need,
// builds the final message bytes and hands them to the SendLedger Durable
// Object, which is the only place that talks to SMTP or IMAP.

import { ApiError, fetchParentForComposition } from "./core";
import {
  buildMessage,
  defaultForwardSubject,
  defaultReplySubject,
  forwardQuote,
  MimeBuildError,
  parseMailbox,
  truncateUtf8,
  utf8Length,
  type Mailbox,
} from "./mime-build";
import { readSendConfig } from "./send-policy";
import { bytesToBase64, type LedgerErrorCode } from "./send-ledger-core";
import type { DirectSendReport, SaveDraftReport, SendLedger } from "./send-ledger";
import type { Env } from "./types";

export const DRAFTS_MAILBOX = "Drafts";

export interface ComposeRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text: string;
  inReplyTo?: { mailbox: string; uidValidity: number; uid: number };
  forwardOf?: { mailbox: string; uidValidity: number; uid: number };
}

export interface SendMailRequest extends ComposeRequest {
  allowDuplicate?: boolean;
}

export function ledgerStub(env: Env): DurableObjectStub<SendLedger> {
  return env.SEND_LEDGER.get(env.SEND_LEDGER.idFromName("deployment"));
}

const LEDGER_STATUS: Record<string, number> = {
  daily_limit_reached: 429,
  duplicate_send: 409,
  send_not_configured: 500,
};

/** Map a ledger error code to the API error the tools render. */
export function ledgerApiError(code: string, message: string): ApiError {
  return new ApiError(LEDGER_STATUS[code] ?? 500, code as LedgerErrorCode | string, message);
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof MimeBuildError) {
    const status = error.code === "message_too_large" ? 413 : 400;
    return new ApiError(status, error.code, error.message);
  }
  return new ApiError(500, "internal_error", "unexpected send error");
}

function parseRecipientList(list: unknown, field: string): Mailbox[] {
  if (!Array.isArray(list)) {
    throw new ApiError(400, "invalid_argument", `${field} must be an array of address strings`);
  }
  return list.map((entry) => {
    if (typeof entry !== "string") {
      throw new ApiError(400, "invalid_address", `${field}: every recipient must be a string`);
    }
    try {
      return parseMailbox(entry);
    } catch (error) {
      if (error instanceof MimeBuildError) {
        throw new ApiError(400, "invalid_address", `${field}: ${error.message}`);
      }
      throw error;
    }
  });
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => {
    let hex = "";
    for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, "0");
    return hex;
  });
}

interface ComposedMessage {
  raw: Uint8Array;
  recipients: string[];
  messageId: string;
  /** Stable content hash for the duplicate window: the same recipient list,
   * subject, body and parent — never the per-attempt Date or Message-ID. */
  hash: string;
}

/**
 * Validate the request, pull in whatever a reply or a forward needs, and
 * serialize the final message. Nothing here talks to SMTP.
 */
async function composeMessage(env: Env, input: ComposeRequest): Promise<ComposedMessage> {
  try {
    const config = readSendConfig(env);
    if (!config.ok) throw new ApiError(500, "send_not_configured", config.error);
    const { caps } = config.config;

    if (input.inReplyTo && input.forwardOf) {
      throw new ApiError(400, "invalid_argument", "inReplyTo and forwardOf are mutually exclusive");
    }
    const to = parseRecipientList(input.to, "to");
    const cc = parseRecipientList(input.cc ?? [], "cc");
    const bcc = parseRecipientList(input.bcc ?? [], "bcc");
    if (to.length === 0) throw new ApiError(400, "invalid_argument", "at least one recipient is required");
    const recipientCount = to.length + cc.length + bcc.length;
    if (recipientCount > caps.maxRcptsPerMessage) {
      throw new ApiError(400, "invalid_argument", `at most ${caps.maxRcptsPerMessage} recipients per message`);
    }
    if (typeof input.text !== "string" || input.text.length === 0) {
      throw new ApiError(400, "invalid_argument", "text must be a non-empty string");
    }
    if (utf8Length(input.text) > caps.maxBodyBytes) {
      throw new ApiError(413, "message_too_large", `body over the ${caps.maxBodyBytes}-byte limit`);
    }

    let subject = typeof input.subject === "string" ? input.subject : "";
    let inReplyTo: string | null = null;
    let references: string[] = [];
    let text = input.text;

    if (input.inReplyTo) {
      const parent = await fetchParentForComposition(
        env,
        input.inReplyTo.mailbox,
        input.inReplyTo.uidValidity,
        input.inReplyTo.uid,
      );
      inReplyTo = parent.messageId;
      references = parent.references;
      if (subject.trim() === "") subject = defaultReplySubject(parent.subject);
    } else if (input.forwardOf) {
      const parent = await fetchParentForComposition(
        env,
        input.forwardOf.mailbox,
        input.forwardOf.uidValidity,
        input.forwardOf.uid,
      );
      if (subject.trim() === "") subject = defaultForwardSubject(parent.subject);
      let quote = forwardQuote(
        { from: parent.fromDisplay, date: parent.date, subject: parent.subject },
        parent.text ?? "(no text content)",
      );
      if (parent.attachmentNames.length > 0) {
        quote += `\r\n\r\n[${parent.attachmentNames.length} attachment(s) not included: ${parent.attachmentNames.join(", ")}]`;
      }
      const separator = "\r\n\r\n";
      const budget = caps.maxBodyBytes - utf8Length(input.text) - utf8Length(separator);
      if (budget <= 0) {
        throw new ApiError(413, "message_too_large", "text leaves no room for the forwarded message");
      }
      text = `${input.text}${separator}${truncateUtf8(quote, budget)}`;
    }

    const from: Mailbox = { name: config.config.fromName, address: config.config.from };
    const domain = from.address.slice(from.address.lastIndexOf("@") + 1);
    const messageId = `<${crypto.randomUUID()}@${domain}>`;
    const built = buildMessage({
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      date: new Date(),
      messageId,
      inReplyTo,
      references,
      maxBodyBytes: caps.maxBodyBytes,
    });
    const hash = await sha256Hex(
      new TextEncoder().encode(
        [built.recipients.map((address) => address.toLowerCase()).join(","), subject, built.text, inReplyTo ?? ""].join(
          "\u0000",
        ),
      ),
    );
    return {
      raw: built.raw,
      recipients: built.recipients,
      messageId: built.messageId,
      hash,
    };
  } catch (error) {
    throw asApiError(error);
  }
}

export interface SendMailResult {
  status: "sent";
  messageId: string;
  recipients: number;
  replyCode: number;
}

/** Compose and submit immediately. */
export async function sendMailFromTool(
  env: Env,
  principal: string,
  input: SendMailRequest,
): Promise<SendMailResult> {
  const composed = await composeMessage(env, input);
  const report: DirectSendReport = await ledgerStub(env).send({
    rawB64: bytesToBase64(composed.raw),
    recipients: composed.recipients,
    hash: composed.hash,
    allowDuplicate: input.allowDuplicate === true,
    principal,
  });
  switch (report.status) {
    case "sent":
      return {
        status: "sent",
        messageId: composed.messageId,
        recipients: composed.recipients.length,
        replyCode: report.replyCode ?? 250,
      };
    case "unknown":
      throw new ApiError(
        504,
        "send_status_unknown",
        "the connection dropped after the message was submitted; it may already be queued — check the recipient or Sent before trying again",
      );
    case "refused":
      throw ledgerApiError(report.code ?? "internal_error", report.message ?? "refused");
    default:
      throw new ApiError(report.retryable ? 503 : 502, report.code ?? "smtp_error", report.message ?? "send failed");
  }
}

export interface SaveDraftResult {
  saved: true;
  mailbox: string;
  messageId: string;
}

/** Compose and put the message into iCloud's real Drafts mailbox. */
export async function saveDraftFromTool(env: Env, principal: string, input: ComposeRequest): Promise<SaveDraftResult> {
  const composed = await composeMessage(env, input);
  const report: SaveDraftReport = await ledgerStub(env).saveDraft({
    rawB64: bytesToBase64(composed.raw),
    recipientCount: composed.recipients.length,
    principal,
  });
  if (report.status !== "saved") {
    throw new ApiError(502, report.code ?? "imap_error", report.message ?? "the draft could not be saved");
  }
  return { saved: true, mailbox: DRAFTS_MAILBOX, messageId: composed.messageId };
}
