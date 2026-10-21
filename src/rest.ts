// REST surface for the proxy. Small hand-rolled router with a single
// error-mapping helper. Bodies are validated with zod v4 before any IMAP work
// happens.

import { z } from "zod";
import { CalDavError } from "./caldav";
import { calendarsEnabled, reminderListsEnabled } from "./calendar-config";
import { listCollections, type CollectionKind } from "./calendar-core";
import {
  ApiError,
  getAttachment,
  getMessage,
  healthCheck,
  listMailboxes,
  mutateMessage,
  searchMail,
  type MutationAction,
} from "./core";
import { ImapError } from "./imap";
import type { Env, SearchParams } from "./types";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorBody(code: string, message: string, status: number): Response {
  return json({ error: { code, message } }, status);
}

// zod v4 schema mirroring SearchParams. `.strict()` rejects unknown keys.
const searchSchema = z
  .object({
    mailbox: z.string().min(1),
    after: z.string().optional(),
    before: z.string().optional(),
    from: z.string().optional(),
    subject: z.string().optional(),
    text: z.string().optional(),
    limit: z.number().int().positive().optional(),
    unseen: z.boolean().optional(),
    beforeUid: z.number().int().positive().optional(),
  })
  .strict();

/** Translate any thrown value into a JSON error Response. */
function mapError(e: unknown): Response {
  if (e instanceof ApiError) {
    return errorBody(e.code, e.message, e.status);
  }
  if (e instanceof ImapError) {
    if (e.code === "TIMEOUT") {
      return errorBody("upstream_timeout", "the mail server timed out", 504);
    }
    if (e.code === "LIMIT") {
      return errorBody("message_too_large", e.message, 413);
    }
    // Server text is safe to surface: it never contains credentials.
    return errorBody("upstream_imap_error", e.message, 502);
  }
  if (e instanceof CalDavError) {
    switch (e.code) {
      case "unauthorized":
      case "forbidden":
        return errorBody("upstream_unauthorized", e.message, 502);
      case "not_found":
        return errorBody("not_found", e.message, 404);
      case "conflict":
        return errorBody("conflict", e.message, 409);
      case "too_many_resources":
        return errorBody("too_many_resources", e.message, 422);
      case "recurrence_too_complex":
        return errorBody("recurrence_too_complex", e.message, 422);
      case "mutation_state_unknown":
        return errorBody("mutation_state_unknown", e.message, 502);
      case "malformed":
        return errorBody("malformed", e.message, 502);
      case "invalid_argument":
        return errorBody("invalid_request", e.message, 400);
      default:
        return errorBody("upstream_error", e.message, 502);
    }
  }
  if (e instanceof z.ZodError) {
    return errorBody("invalid_request", z.prettifyError(e), 400);
  }
  if (e instanceof SyntaxError) {
    return errorBody("invalid_json", "request body is not valid JSON", 400);
  }
  console.error("rest_unexpected_error", e instanceof Error ? e.message : String(e));
  return errorBody("internal_error", "internal error", 500);
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorBody("invalid_json", "request body is not valid JSON", 400);
  }
  const params = searchSchema.parse(raw) satisfies SearchParams;
  const result = await searchMail(env, params);
  return json(result);
}

async function handleGetMessage(
  segments: string[],
  env: Env,
): Promise<Response> {
  // /v1/messages/:mailbox/:uidValidity/:uid
  const [mailboxEnc, uidValidityStr, uidStr] = segments;
  let mailbox: string;
  try {
    mailbox = decodeURIComponent(mailboxEnc);
  } catch {
    return errorBody("invalid_request", "mailbox path segment is not valid", 400);
  }
  if (!/^\d+$/.test(uidValidityStr) || !/^\d+$/.test(uidStr)) {
    return errorBody("invalid_request", "uidValidity and uid must be integers", 400);
  }
  const detail = await getMessage(env, mailbox, Number(uidValidityStr), Number(uidStr));
  return json(detail);
}

/**
 * Choose a safe Content-Type for a served attachment. The core has already
 * enforced the type allowlist, so this only guards the HTTP layer: a type
 * carrying CR/LF (a header-injection attempt from a hostile server) degrades to
 * octet-stream, and any text/* type is served as text/plain — never text/html —
 * so mail content can never be served as an executable HTML/XSS gadget. Paired
 * with X-Content-Type-Options: nosniff on the response.
 */
function safeContentType(mimeType: string): string {
  if (/[\r\n]/.test(mimeType)) return "application/octet-stream";
  if (mimeType.toLowerCase().startsWith("text/")) return "text/plain";
  return mimeType;
}

/**
 * Sanitize an attachment filename for the Content-Disposition header: strip
 * CR/LF, quotes, backslashes and other non-printable characters; fall back to
 * "attachment" when the name is null or reduces to empty.
 */
function sanitizeFilename(name: string | null): string {
  if (name === null) return "attachment";
  const cleaned = name.replace(/[\r\n"\\]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  return cleaned.length > 0 ? cleaned : "attachment";
}

async function handleGetAttachment(
  segments: string[],
  env: Env,
): Promise<Response> {
  // /v1/messages/:mailbox/:uidValidity/:uid/attachments/:index
  const [mailboxEnc, uidValidityStr, uidStr, , indexStr] = segments;
  let mailbox: string;
  try {
    mailbox = decodeURIComponent(mailboxEnc);
  } catch {
    return errorBody("invalid_request", "mailbox path segment is not valid", 400);
  }
  if (!/^\d+$/.test(uidValidityStr) || !/^\d+$/.test(uidStr) || !/^\d+$/.test(indexStr)) {
    return errorBody("invalid_request", "uidValidity, uid and index must be integers", 400);
  }
  const { filename, mimeType, bytes } = await getAttachment(
    env,
    mailbox,
    Number(uidValidityStr),
    Number(uidStr),
    Number(indexStr),
  );
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": safeContentType(mimeType),
      "Content-Disposition": `attachment; filename="${sanitizeFilename(filename)}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * POST /v1/messages/:mailbox/:uidValidity/:uid/{archive,trash}: file one
 * message into the fixed archive or trash mailbox. The destination is
 * configured server-side and never read from the request.
 */
async function handleMutation(
  segments: string[],
  action: MutationAction,
  env: Env,
): Promise<Response> {
  const [mailboxEnc, uidValidityStr, uidStr] = segments;
  let mailbox: string;
  try {
    mailbox = decodeURIComponent(mailboxEnc);
  } catch {
    return errorBody("invalid_request", "mailbox path segment is not valid", 400);
  }
  if (!/^\d+$/.test(uidValidityStr) || !/^\d+$/.test(uidStr)) {
    return errorBody("invalid_request", "uidValidity and uid must be integers", 400);
  }
  const result = await mutateMessage(env, action, mailbox, Number(uidValidityStr), Number(uidStr), {
    principal: "bearer",
  });
  return json(result);
}

/**
 * GET /v1/calendars and /v1/reminder-lists. `?all=1` is the static-bearer-only
 * bootstrap view used by setup: every collection before allowlist filtering,
 * and it works even when the domain is disabled. Without it the domain must be
 * enabled and only allowlisted collections are returned.
 */
async function handleCollections(url: URL, env: Env, kind: CollectionKind): Promise<Response> {
  const all = url.searchParams.get("all") === "1";
  const enabled = kind === "calendar" ? calendarsEnabled(env) : reminderListsEnabled(env);
  if (!enabled && !all) {
    return errorBody(
      "not_supported",
      kind === "calendar"
        ? "calendars are disabled: ALLOWED_CALENDARS is empty"
        : "reminder lists are disabled: ALLOWED_REMINDER_LISTS is empty",
      404,
    );
  }
  const collections = await listCollections(env, kind, { all });
  return json(kind === "calendar" ? { calendars: collections } : { reminderLists: collections });
}

/**
 * GET /healthz: prove the Worker can actually reach and authenticate to
 * imap.mail.me.com right now (LOGIN + LOGOUT, no EXAMINE, nothing else). An
 * ImapError here is a known "the mail server is having trouble" state, so it
 * gets its own 503 body instead of the generic 502/504 mapError would give;
 * anything else (ApiError, unexpected errors) still goes through mapError.
 */
async function handleHealthz(env: Env): Promise<Response> {
  try {
    const result = await healthCheck(env);
    return json(result);
  } catch (e) {
    if (e instanceof ImapError) {
      return json({ ok: false, error: { code: e.code, message: e.message } }, 503);
    }
    throw e;
  }
}

export async function handleRest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  try {
    // GET /healthz
    if (request.method === "GET" && segments.length === 1 && segments[0] === "healthz") {
      return await handleHealthz(env);
    }

    // GET /v1/mailboxes
    if (
      request.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "v1" &&
      segments[1] === "mailboxes"
    ) {
      return json({ mailboxes: listMailboxes(env) });
    }

    // GET /v1/calendars[?all=1] and /v1/reminder-lists[?all=1]
    if (
      request.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "v1" &&
      (segments[1] === "calendars" || segments[1] === "reminder-lists")
    ) {
      return await handleCollections(url, env, segments[1] === "calendars" ? "calendar" : "reminders");
    }

    // POST /v1/search
    if (
      request.method === "POST" &&
      segments.length === 2 &&
      segments[0] === "v1" &&
      segments[1] === "search"
    ) {
      return await handleSearch(request, env);
    }

    // POST /v1/messages/:mailbox/:uidValidity/:uid/archive | .../trash
    if (
      request.method === "POST" &&
      segments.length === 6 &&
      segments[0] === "v1" &&
      segments[1] === "messages" &&
      (segments[5] === "archive" || segments[5] === "trash")
    ) {
      return await handleMutation(segments.slice(2), segments[5], env);
    }

    // GET /v1/messages/:mailbox/:uidValidity/:uid/attachments/:index
    if (
      request.method === "GET" &&
      segments.length === 7 &&
      segments[0] === "v1" &&
      segments[1] === "messages" &&
      segments[5] === "attachments"
    ) {
      return await handleGetAttachment(segments.slice(2), env);
    }

    // GET /v1/messages/:mailbox/:uidValidity/:uid
    if (
      request.method === "GET" &&
      segments.length === 5 &&
      segments[0] === "v1" &&
      segments[1] === "messages"
    ) {
      return await handleGetMessage(segments.slice(2), env);
    }

    return errorBody("not_found", "no such route", 404);
  } catch (e) {
    return mapError(e);
  }
}
