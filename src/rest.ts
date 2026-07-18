// REST surface for the proxy. Small hand-rolled router (three routes) with a
// single error-mapping helper. Bodies are validated with zod v4 before any
// IMAP work happens.

import { z } from "zod";
import { ApiError, getMessage, listMailboxes, searchMail } from "./core";
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

export async function handleRest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  try {
    // GET /v1/mailboxes
    if (
      request.method === "GET" &&
      segments.length === 2 &&
      segments[0] === "v1" &&
      segments[1] === "mailboxes"
    ) {
      return json({ mailboxes: listMailboxes(env) });
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
