// Worker-side composition and operations for outgoing mail
// (plans/email-send.md, steps 5 and 7).
//
// This module validates caller input, fetches what replies and forwards need,
// builds the final message bytes and talks to the SendLedger Durable Object.
// It never sends: the only call that can reach SMTP is `approveSend`, used by
// the approval page after the owner signed in and the nonce was checked.

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
import { bytesToBase64, type DraftMeta, type DraftView } from "./send-ledger-core";
import type { NewDraftInput, SendLedger, SendReport } from "./send-ledger";
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

export function ledgerStub(env: Env): DurableObjectStub<SendLedger> {
  return env.SEND_LEDGER.get(env.SEND_LEDGER.idFromName("deployment"));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomToken(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

const LEDGER_STATUS: Record<string, number> = {
  draft_not_found: 404,
  draft_expired: 410,
  already_sent: 409,
  already_saved: 409,
  send_in_progress: 409,
  send_status_unknown: 409,
  draft_not_ready: 409,
  invalid_nonce: 403,
  daily_limit_reached: 429,
  too_many_drafts: 429,
  send_not_configured: 500,
};

/** Map a ledger error code to the API error the tools and the page render. */
export function ledgerApiError(code: string, message: string): ApiError {
  return new ApiError(LEDGER_STATUS[code] ?? 500, code, message);
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

/**
 * Build the draft's final bytes, store them in the ledger and return the
 * preview. Nothing here touches SMTP; the returned id is what the owner
 * approves later on the Worker's own page.
 */
export async function createDraft(env: Env, principal: string, input: ComposeRequest): Promise<DraftView> {
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
    const date = new Date();
    const built = buildMessage({
      from,
      to,
      cc,
      bcc,
      subject,
      text,
      date,
      messageId,
      inReplyTo,
      references,
      maxBodyBytes: caps.maxBodyBytes,
    });

    const meta: DraftMeta = {
      fromName: from.name,
      fromAddr: from.address,
      toDisplay: to.map((mailbox) => displayOf(mailbox)),
      ccDisplay: cc.map((mailbox) => displayOf(mailbox)),
      bccDisplay: bcc.map((mailbox) => displayOf(mailbox)),
      subject: built.subject,
      dateIso: built.dateIso,
      messageId: built.messageId,
      inReplyTo,
      text: built.text,
      textBytes: built.textBytes,
    };
    const draftId = randomToken(16);
    const nonce = randomToken(16);
    const newDraft: NewDraftInput = {
      id: draftId,
      principal,
      rawB64: bytesToBase64(built.raw),
      envelopeFrom: built.envelopeFrom,
      recipients: built.recipients,
      meta,
      nonce,
      ttlSeconds: caps.draftTtlSeconds,
    };
    const result = await ledgerStub(env).createDraft(newDraft);
    if (!result.ok) throw ledgerApiError(result.code, result.message);
    return result.value;
  } catch (error) {
    throw asApiError(error);
  }
}

function displayOf(mailbox: Mailbox): string {
  return mailbox.name === null ? mailbox.address : `${mailbox.name} <${mailbox.address}>`;
}

export async function listDrafts(env: Env, principal: string): Promise<DraftView[]> {
  return ledgerStub(env).listDrafts(principal);
}

export async function getDraft(env: Env, principal: string, id: string): Promise<DraftView> {
  const view = await ledgerStub(env).getDraft(principal, id);
  if (!view) throw new ApiError(404, "draft_not_found", `no draft with id ${JSON.stringify(id)}`);
  return view;
}

export async function discardDraft(env: Env, principal: string, id: string): Promise<{ discarded: true }> {
  const result = await ledgerStub(env).discardDraft(id, { principal });
  if (!result.ok) throw ledgerApiError(result.code, result.message);
  return { discarded: true };
}

/**
 * Append the draft to iCloud's Drafts mailbox so it can be finished from any
 * mail app; the draft then stops being approvable, which is what keeps it
 * from being sent twice.
 */
export async function saveDraftToIcloud(env: Env, principal: string, id: string): Promise<{ saved: true; mailbox: string }> {
  const result = await ledgerStub(env).saveDraft(id, { principal });
  if (!result.ok) throw ledgerApiError(result.code, result.message);
  return { saved: true, mailbox: DRAFTS_MAILBOX };
}

// ---- approval-page operations (nonce-bound, no principal) ------------------

export async function draftForApproval(env: Env, id: string): Promise<{ view: DraftView; nonce: string } | null> {
  return ledgerStub(env).getDraftForApproval(id);
}

export async function approveDraft(env: Env, id: string, nonce: string): Promise<SendReport> {
  return ledgerStub(env).approveSend(id, nonce);
}

export async function saveDraftFromPage(env: Env, id: string, nonce: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await ledgerStub(env).saveDraft(id, { nonce });
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}

export async function discardDraftFromPage(env: Env, id: string, nonce: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await ledgerStub(env).discardDraft(id, { nonce });
  return result.ok ? { ok: true } : { ok: false, message: result.message };
}
