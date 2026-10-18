// /send/approve: the owner's page and the only path that can send
// (plans/email-send.md, step 6).
//
// GET  ?d=<draftId>  sign-in form, then the exact message with Send / Save /
//                    Delete buttons.
// POST               action=login (API token -> 15-minute __Host-send cookie),
//                    send, save or discard (cookie + one-time nonce).
//
// Every response is HTML with the same CSP as the OAuth pages; the outer
// dispatch adds `private, no-store`.

import { approvalSecret, hasSendSession, sendSessionCookie, tokenMatches } from "./auth";
import { approveDraftPage, approveLoginPage, approveResultPage } from "./approve-page";
import { errorPage, htmlHeaders } from "./oauth-pages";
import { approveDraft, discardDraftFromPage, draftForApproval, saveDraftFromPage } from "./send";
import type { Env } from "./types";

const FORM_UNREADABLE = "The form could not be read. Open the approval link again.";
const DRAFT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NO_DEDICATED_TOKEN =
  "This deployment has no dedicated SEND_APPROVAL_TOKEN, so the same API token that connected apps " +
  "hold can approve drafts. Set the secret to make this step owner-only.";

function htmlResponse(html: string, status: number, headers?: HeadersInit): Response {
  return new Response(html, { status, headers: { ...htmlHeaders(), ...headers } });
}

/** The fallback warning shown only while the dedicated secret is unset. */
function approvalWarning(env: Env): string | undefined {
  return approvalSecret(env) === env.API_TOKEN ? NO_DEDICATED_TOKEN : undefined;
}

function readForm(request: Request): Promise<FormData | null> {
  return request.formData().catch(() => null);
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

async function handleGet(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const draftId = url.searchParams.get("d") ?? "";
  if (!DRAFT_ID_RE.test(draftId)) {
    return htmlResponse(errorPage("Missing or invalid draft id.", 404), 404);
  }
  if (!(await hasSendSession(request, env))) {
    return htmlResponse(approveLoginPage({ draftId, warning: approvalWarning(env) }), 200);
  }
  const draft = await draftForApproval(env, draftId);
  if (!draft) {
    return htmlResponse(errorPage("No such draft, or it expired.", 404), 404);
  }
  return htmlResponse(approveDraftPage({ view: draft.view, nonce: draft.nonce }), 200);
}

async function handleLogin(form: FormData, env: Env): Promise<Response> {
  const draftId = formValue(form, "d");
  const token = formValue(form, "token");
  if (!(await tokenMatches(token, approvalSecret(env)))) {
    return htmlResponse(
      approveLoginPage({ draftId, warning: approvalWarning(env), error: "That token does not match this deployment." }),
      401,
    );
  }
  const cookie = await sendSessionCookie(env);
  return new Response(null, {
    status: 303,
    headers: {
      Location: `/send/approve?d=${encodeURIComponent(draftId)}`,
      "Set-Cookie": cookie,
      "Cache-Control": "private, no-store",
    },
  });
}

/** Render the outcome of `approveSend`. */
function reportResponse(report: Awaited<ReturnType<typeof approveDraft>>, draftId: string): Response {
  switch (report.status) {
    case "sent":
      return htmlResponse(
        approveResultPage({
          title: "Message sent",
          message: `iCloud accepted the message (SMTP ${report.replyCode ?? 250}). It is on its way.`,
          draftId,
        }),
        200,
      );
    case "unknown":
      return htmlResponse(
        approveResultPage({
          title: "Delivery state unknown",
          message:
            "The connection dropped after the message was submitted, so it may already be queued. " +
            "This draft will not be retried automatically: check the recipient or the Sent mailbox " +
            "before creating a new draft.",
          draftId,
        }),
        200,
      );
    case "ready":
      return htmlResponse(
        approveResultPage({
          title: "Not sent",
          message: `${report.message ?? "The message was not submitted"} Nothing was delivered; you can try again from this link.`,
          draftId,
        }),
        502,
      );
    case "failed":
      return htmlResponse(
        approveResultPage({
          title: "Rejected",
          message: `${report.message ?? "The server rejected the message"} (${report.code ?? "smtp_error"})`,
          draftId,
        }),
        502,
      );
    default: {
      const code = report.code ?? "error";
      if (code === "send_status_unknown") {
        return htmlResponse(
          approveResultPage({
            title: "Delivery state unknown",
            message:
              "The last attempt ended after the message was submitted, so it may already be queued. " +
              "This draft will not be retried automatically: check the recipient or the Sent mailbox " +
              "before creating a new draft.",
            draftId,
          }),
          200,
        );
      }
      const status =
        code === "draft_not_found"
          ? 404
          : code === "draft_expired"
            ? 410
            : code === "already_sent"
              ? 200
              : code === "invalid_nonce"
                ? 403
                : code === "daily_limit_reached"
                  ? 429
                  : code === "send_not_configured"
                    ? 500
                    : 409;
      const title =
        code === "already_sent"
          ? "Already sent"
          : code === "draft_expired"
            ? "Draft expired"
            : code === "daily_limit_reached"
              ? "Daily limit reached"
              : code === "invalid_nonce"
                ? "Form expired"
                : "Not sent";
      return htmlResponse(
        approveResultPage({ title, message: report.message ?? `Action refused (${code})`, draftId }),
        status,
      );
    }
  }
}

async function handlePost(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (!form) return htmlResponse(errorPage(FORM_UNREADABLE, 400), 400);
  const action = formValue(form, "action");
  const draftId = formValue(form, "d");

  if (action === "login") {
    return handleLogin(form, env);
  }

  if (!DRAFT_ID_RE.test(draftId)) {
    return htmlResponse(errorPage("Missing or invalid draft id.", 404), 404);
  }
  if (!(await hasSendSession(request, env))) {
    return htmlResponse(approveLoginPage({ draftId, warning: approvalWarning(env), error: "Sign in to continue." }), 401);
  }
  const nonce = formValue(form, "nonce");

  if (action === "send") {
    return reportResponse(await approveDraft(env, draftId, nonce), draftId);
  }
  if (action === "save") {
    const result = await saveDraftFromPage(env, draftId, nonce);
    return result.ok
      ? htmlResponse(
          approveResultPage({
            title: "Saved in Drafts",
            message: "The message is in the Drafts mailbox now; finish or delete it from any mail app.",
            draftId,
          }),
          200,
        )
      : htmlResponse(
          approveResultPage({ title: "Not saved", message: result.message, draftId }),
          502,
        );
  }
  if (action === "discard") {
    const result = await discardDraftFromPage(env, draftId, nonce);
    return result.ok
      ? htmlResponse(
          approveResultPage({ title: "Draft deleted", message: "The draft was discarded; nothing was sent.", draftId }),
          200,
        )
      : htmlResponse(approveResultPage({ title: "Not deleted", message: result.message, draftId }), 409);
  }
  return htmlResponse(errorPage("Unrecognized action.", 400), 400);
}

export async function handleApprove(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.pathname !== "/send/approve") {
      return htmlResponse(errorPage("Not found.", 404), 404);
    }
    if (request.method === "GET") return await handleGet(request, env);
    if (request.method === "POST") return await handlePost(request, env);
    return htmlResponse(errorPage("Method not allowed.", 405), 405);
  } catch (error) {
    console.error("approve_unexpected_error", error instanceof Error ? error.message : String(error));
    return htmlResponse(errorPage("Something went wrong. Nothing was sent.", 500), 500);
  }
}
