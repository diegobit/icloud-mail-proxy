// /authorize and /authorize/consent: the two pages the browser walks through
// before an OAuth client gets a grant (plans/oauth-mcp.md, step 4).
//
// The library is imported types-only: its module imports `cloudflare:workers`
// and cannot load under Node, so tests pass a fake `env.OAUTH_PROVIDER` and
// the expected failures (AuthorizationError, CimdFetchError) are recognised by
// name, which both classes set explicitly.

import type { AuthRequest, ConsentDescription, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { grantEpoch, tokenMatches } from "./auth";
import { consentPage, errorPage, htmlHeaders, tokenEntryPage, type ClientFacts } from "./oauth-pages";
import type { Env } from "./types";

const METADATA_FAILED = "The connecting app's client metadata could not be fetched. Try again from the app.";
const GRANTED_SCOPE = ["mail:read"];

interface WireAuthorizationError extends Error {
  description: string;
  redirectTo?: string;
}

function isAuthorizationError(error: unknown): error is WireAuthorizationError {
  return (
    error instanceof Error &&
    error.name === "AuthorizationError" &&
    typeof (error as { description?: unknown }).description === "string"
  );
}

function isCimdFetchError(error: unknown): boolean {
  return error instanceof Error && error.name === "CimdFetchError";
}

function htmlResponse(html: string, status: number, extraHeaders?: Headers): Response {
  const headers = new Headers(htmlHeaders());
  extraHeaders?.forEach((value, key) => headers.append(key, value));
  return new Response(html, { status, headers });
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function toClientFacts(consent: ConsentDescription): ClientFacts {
  return {
    clientName: consent.clientName,
    clientDomain: consent.clientDomain,
    redirectUri: consent.redirectUri,
    redirectHost: consent.redirectHost,
    redirectIsLoopback: consent.redirectIsLoopback,
  };
}

/** A validation failure: redirect back when the library validated the client, render otherwise. */
function authorizationFailure(error: unknown): Response {
  if (isAuthorizationError(error)) {
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return htmlResponse(errorPage(error.description, 400), 400);
  }
  if (isCimdFetchError(error)) {
    return htmlResponse(errorPage(METADATA_FAILED, 400), 400);
  }
  throw error;
}

/** A consent-transaction failure: the form is gone or was never this browser's. */
function consentFailure(error: unknown): Response {
  if (isAuthorizationError(error)) {
    return htmlResponse(errorPage(`${error.description} Start again from the connecting app.`, 400), 400);
  }
  if (isCimdFetchError(error)) {
    return htmlResponse(errorPage(METADATA_FAILED, 400), 400);
  }
  throw error;
}

async function readRequestFacts(
  helpers: OAuthHelpers,
  request: Request,
): Promise<{ authRequest: AuthRequest; facts: ClientFacts }> {
  const authRequest = await helpers.parseAuthRequest(request);
  const facts = toClientFacts(await helpers.describeConsent(authRequest));
  return { authRequest, facts };
}

async function handlePrompt(request: Request, env: Env): Promise<Response> {
  try {
    const { facts } = await readRequestFacts(env.OAUTH_PROVIDER, request);
    const authQuery = new URL(request.url).search.replace(/^\?/, "");
    return htmlResponse(tokenEntryPage({ client: facts, authQuery }), 200);
  } catch (error) {
    return authorizationFailure(error);
  }
}

async function handleTokenSubmission(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const authQuery = formValue(form, "authQuery");
  const token = formValue(form, "token");

  let authRequest: AuthRequest;
  let facts: ClientFacts;
  try {
    const rebuilt = new Request(new URL(`/authorize?${authQuery}`, request.url), { method: "GET" });
    ({ authRequest, facts } = await readRequestFacts(env.OAUTH_PROVIDER, rebuilt));
  } catch (error) {
    return authorizationFailure(error);
  }

  if (!(await tokenMatches(token, env.API_TOKEN))) {
    return htmlResponse(
      tokenEntryPage({ client: facts, authQuery, error: "That token does not match this deployment." }),
      401,
    );
  }

  try {
    const transaction = await env.OAUTH_PROVIDER.beginConsent(authRequest);
    return htmlResponse(consentPage({ client: facts, handle: transaction.handle }), 200, transaction.headers);
  } catch (error) {
    return consentFailure(error);
  }
}

async function handleConsentSubmission(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const handle = formValue(form, "handle");
  const action = formValue(form, "action");

  if (action === "deny") {
    try {
      const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    } catch (error) {
      return consentFailure(error);
    }
  }

  if (action !== "approve") {
    return htmlResponse(errorPage("Unrecognized consent action.", 400), 400);
  }

  try {
    const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: GRANTED_SCOPE });
    const consent = await env.OAUTH_PROVIDER.describeConsent(approved.request);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: approved.request,
      userId: "owner",
      scope: GRANTED_SCOPE,
      metadata: { clientName: consent.clientName, approvedAt: new Date().toISOString() },
      props: { epoch: await grantEpoch(env.API_TOKEN), via: "oauth" },
    });
    const headers = new Headers(approved.headers);
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return consentFailure(error);
  }
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/authorize/consent") {
    if (request.method !== "POST") {
      return htmlResponse(errorPage("Method not allowed.", 405), 405);
    }
    return handleConsentSubmission(request, env);
  }

  if (url.pathname !== "/authorize") {
    return htmlResponse(errorPage("Not found.", 404), 404);
  }

  if (request.method === "GET") return handlePrompt(request, env);
  if (request.method === "POST") return handleTokenSubmission(request, env);
  return htmlResponse(errorPage("Method not allowed.", 405), 405);
}
