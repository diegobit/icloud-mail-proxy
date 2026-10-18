// Pages for /send/approve (plans/email-send.md, step 6). Pure rendering: all
// draft content — produced by the model, possibly echoing hostile mail — goes
// through escapeHtml, the body is shown as text inside <pre>, and nothing is
// ever rendered as HTML or fetched from the network.

import { errorPage, escapeHtml, page } from "./oauth-pages";
import type { DraftView } from "./send-ledger-core";

function errorHtml(error?: string): string {
  return error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : "";
}

function utcTime(epochMs: number): string {
  return new Date(epochMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

/** The sign-in page shown before a draft's content is revealed or acted on. */
export function approveLoginPage(options: { draftId: string; error?: string }): string {
  return page(
    "Approve a draft",
    `<h1>Approve a draft</h1>
<p>A connected app created a draft message for this mailbox. Sign in with the approval token to review it. Nothing is sent without this step.</p>
${errorHtml(options.error)}
<form method="post" action="/send/approve">
<input type="hidden" name="d" value="${escapeHtml(options.draftId)}">
<input type="hidden" name="action" value="login">
<label for="token">Approval token</label>
<input type="password" id="token" name="token" autocomplete="off" spellcheck="false" required>
<button type="submit" class="primary">Continue</button>
</form>`,
  );
}

function recipientLine(label: string, values: string[]): string {
  if (values.length === 0) return "";
  return `<p class="fact">${escapeHtml(label)}: ${values.map((value) => escapeHtml(value)).join(", ")}</p>`;
}

/**
 * The review page: every header that will be on the wire, the body exactly as
 * it will be encoded, and the three actions (send, save into iCloud's Drafts,
 * delete) as separate forms.
 */
export function approveDraftPage(options: { view: DraftView; nonce: string; notice?: string }): string {
  const { view, nonce, notice } = options;
  const fromDisplay = view.from.name ? `${view.from.name} <${view.from.address}>` : view.from.address;
  const expired = view.status === "ready" && view.expiresAt < Date.now();
  const warning =
    view.status !== "ready"
      ? `<p class="warn">This draft is ${escapeHtml(view.status)} and can no longer be sent.</p>`
      : expired
        ? `<p class="warn">This draft expired. Create a new one from the app.</p>`
        : "";
  const actions =
    view.status === "ready" && !expired
      ? `<div class="buttons">
<form method="post" action="/send/approve">
<input type="hidden" name="d" value="${escapeHtml(view.id)}">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<button type="submit" name="action" value="send" class="primary">Send now</button>
</form>
<form method="post" action="/send/approve">
<input type="hidden" name="d" value="${escapeHtml(view.id)}">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<button type="submit" name="action" value="save">Save in Drafts</button>
</form>
<form method="post" action="/send/approve">
<input type="hidden" name="d" value="${escapeHtml(view.id)}">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<button type="submit" name="action" value="discard">Delete</button>
</form>
</div>`
      : "";

  return page(
    "Send this draft?",
    `<h1>Send this draft?</h1>
${notice ? `<p class="warn" role="alert">${escapeHtml(notice)}</p>` : ""}
${warning}
<p class="fact">Status: ${escapeHtml(view.status)} — expires ${escapeHtml(utcTime(view.expiresAt))}</p>
<p class="fact">From: ${escapeHtml(fromDisplay)}</p>
${recipientLine("To", view.to)}
${recipientLine("Cc", view.cc)}
${recipientLine("Bcc", view.bcc)}
<p class="fact">Subject: ${escapeHtml(view.subject)}</p>
<p class="fact">Date: ${escapeHtml(view.dateIso)}</p>
<p class="fact mono">Message-ID: ${escapeHtml(view.messageId)}</p>
<p>Body exactly as it will be sent:</p>
<pre class="body">${escapeHtml(view.text)}</pre>
<p class="warn">Sending submits exactly this message through iCloud SMTP. Review the recipient and the text first.</p>
${actions}`,
  );
}

/** A terminal outcome: sent, saved, discarded, or a refused action. */
export function approveResultPage(options: { title: string; message: string; status?: number; draftId?: string }): string {
  const back = options.draftId
    ? `<p><a href="/send/approve?d=${escapeHtml(options.draftId)}">Back to the draft</a></p>`
    : "";
  return page(
    options.title,
    `<h1>${escapeHtml(options.title)}</h1>
<p>${escapeHtml(options.message)}</p>
${back}`,
  );
}

export { errorPage };
