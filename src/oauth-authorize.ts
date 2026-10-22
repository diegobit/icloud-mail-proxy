// /authorize and /authorize/consent: the two pages the browser walks through
// before an OAuth client gets a grant (plans/oauth-mcp.md, step 4).
//
// The library is imported types-only: its module imports `cloudflare:workers`
// and cannot load under Node, so tests pass a fake `env.OAUTH_PROVIDER` and
// the expected failures (AuthorizationError, CimdFetchError) are recognised by
// name, which both classes set explicitly.

import type { AuthRequest, ConsentDescription, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { epochMatches, grantEpoch, tokenMatches } from "./auth";
import { enabledResourceScopes } from "./calendar-config";
import {
  consentPage,
  errorPage,
  htmlHeaders,
  scopeChoices,
  tokenEntryPage,
  type ClientFacts,
} from "./oauth-pages";
import type { ResourceScope } from "./scopes";
import type { Env } from "./types";

const METADATA_FAILED = "The connecting app's client metadata could not be fetched. Try again from the app.";
const FORM_UNREADABLE = "The form could not be read. Start again from the connecting app.";
const UNEXPECTED_FAILURE = "Something went wrong. Start again from the connecting app.";
const PKCE_REQUIRED = "PKCE with an S256 code challenge is required.";
const TOKEN_ROTATED = "API token changed after sign-in. Start again from the connecting app.";
const NO_SCOPE = "Select at least one permission.";
const UNKNOWN_SCOPE = "That permission is not offered by this deployment.";

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

/**
 * An authorization request without an S256 PKCE challenge. The library only
 * requires PKCE for public clients (enforced at token exchange); OAuth 2.1
 * wants it for every authorization request, so this handler rejects such
 * requests itself, before any consent transaction exists.
 */
class PkceRequiredError extends Error {
  readonly redirectTo: string;

  constructor(redirectTo: string) {
    super(PKCE_REQUIRED);
    this.name = "PkceRequiredError";
    this.redirectTo = redirectTo;
  }
}

/** OAuth response parameters replaced (never duplicated) on an error redirect. */
const ERROR_RESPONSE_PARAMETERS = ["error", "error_description", "error_uri", "state", "iss"];

/**
 * Build the OAuth error redirect back to a redirect URI the library
 * validated. Mirrors the library's `authorizationErrorRedirect` — which
 * cannot be imported here, because its module loads `cloudflare:workers` and
 * must stay Node-testable — including the `iss` parameter the discovery
 * metadata advertises (`authorization_response_iss_parameter_supported`) and
 * the removal of stale response parameters already on the redirect URI.
 */
function redirectToClient(authRequest: AuthRequest, error: string, description: string): string {
  const target = new URL(authRequest.redirectUri);
  for (const key of ERROR_RESPONSE_PARAMETERS) target.searchParams.delete(key);
  target.searchParams.set("error", error);
  if (description) target.searchParams.set("error_description", description);
  if (authRequest.state) target.searchParams.set("state", authRequest.state);
  if (authRequest.issuer) target.searchParams.set("iss", authRequest.issuer);
  return target.href;
}

function htmlResponse(html: string, status: number, extraHeaders?: Headers): Response {
  const headers = new Headers(htmlHeaders());
  extraHeaders?.forEach((value, key) => {
    if (key.toLowerCase() === "set-cookie") {
      headers.append(key, value);
    } else if (!headers.has(key)) {
      headers.set(key, value);
    }
  });
  return new Response(html, { status, headers });
}

function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The submitted form, or null when the body is not a readable form submission. */
async function readForm(request: Request): Promise<FormData | null> {
  try {
    return await request.formData();
  } catch {
    return null;
  }
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
  if (error instanceof PkceRequiredError) {
    return Response.redirect(error.redirectTo, 302);
  }
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
): Promise<{ authRequest: AuthRequest; facts: ClientFacts; requestedScopes: string[] }> {
  const authRequest = await helpers.parseAuthRequest(request);
  // OAuth 2.1 requires PKCE on every authorization request: a confidential
  // client could otherwise consent and exchange without a challenge or
  // verifier at all, and this deployment has no OIDC nonce alternative.
  // Checked before describeConsent so no metadata fetch happens either.
  if (authRequest.codeChallengeMethod !== "S256" || !authRequest.codeChallenge) {
    throw new PkceRequiredError(redirectToClient(authRequest, "invalid_request", PKCE_REQUIRED));
  }
  const consent = await helpers.describeConsent(authRequest);
  return { authRequest, facts: toClientFacts(consent), requestedScopes: consent.scope };
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
  const form = await readForm(request);
  if (!form) return htmlResponse(errorPage(FORM_UNREADABLE, 400), 400);
  const authQuery = formValue(form, "authQuery");
  const token = formValue(form, "token");

  let authRequest: AuthRequest;
  let facts: ClientFacts;
  let requestedScopes: string[];
  try {
    const rebuilt = new Request(new URL(`/authorize?${authQuery}`, request.url), { method: "GET" });
    ({ authRequest, facts, requestedScopes } = await readRequestFacts(env.OAUTH_PROVIDER, rebuilt));
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
    const epoch = await grantEpoch(env.API_TOKEN);
    const transaction = await env.OAUTH_PROVIDER.beginConsent(authRequest);
    return htmlResponse(
      consentPage({
        client: facts,
        handle: transaction.handle,
        epoch,
        scopes: scopeChoices(enabledResourceScopes(env), requestedScopes),
      }),
      200,
      transaction.headers,
    );
  } catch (error) {
    return consentFailure(error);
  }
}

async function handleConsentSubmission(request: Request, env: Env): Promise<Response> {
  const form = await readForm(request);
  if (!form) return htmlResponse(errorPage(FORM_UNREADABLE, 400), 400);
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

  // The checkboxes are the grant. Validate them against what this deployment
  // offers before consuming the consent transaction: an old page, a tampered
  // form or a scope from a disabled domain must not mint anything.
  const enabled = enabledResourceScopes(env);
  const selected = [
    ...new Set(
      form.getAll("scope").filter((value): value is string => typeof value === "string"),
    ),
  ];
  if (selected.length === 0) {
    return htmlResponse(errorPage(NO_SCOPE, 400), 400);
  }
  if (selected.some((scope) => !enabled.includes(scope as ResourceScope))) {
    return htmlResponse(errorPage(UNKNOWN_SCOPE, 400), 400);
  }

  // The consent form carries the grant epoch of the token that was verified
  // at sign-in. If API_TOKEN has rotated since, approval must not mint a
  // fresh grant from that stale sign-in, so the epoch is compared with the
  // current token and only the verified value is stamped into the grant. The
  // field comes from the browser, which is safe: any value that does not
  // equal the current token's epoch can only be rejected here, and the epoch
  // itself is a non-reversible HMAC of the token (auth.ts).
  const epoch = formValue(form, "epoch");
  if (!(await epochMatches(epoch, env.API_TOKEN))) {
    return htmlResponse(errorPage(TOKEN_ROTATED, 400), 400);
  }

  try {
    const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, { scope: selected });
    // A stored transaction can predate the PKCE requirement (a consent page
    // left open across an upgrade), in which case the code it would mint is
    // exchangeable without a verifier. The transaction is consumed either
    // way, so the user starts again from the app.
    if (approved.request.codeChallengeMethod !== "S256" || !approved.request.codeChallenge) {
      return htmlResponse(errorPage(PKCE_REQUIRED, 400), 400);
    }
    const consent = await env.OAUTH_PROVIDER.describeConsent(approved.request);
    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: approved.request,
      userId: "owner",
      scope: selected,
      metadata: { clientName: consent.clientName, approvedAt: new Date().toISOString() },
      // `pkce` marks a grant minted under the S256 requirement; the token
      // exchange refuses grants without it (hasPkcePolicy, review round 4).
      props: { epoch, pkce: true, via: "oauth" },
    });
    const headers = new Headers(approved.headers);
    headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    return consentFailure(error);
  }
}

// An unexpected failure anywhere in the flow (e.g. a KV write error inside
// completeAuthorization) must still come back as a no-store HTML page rather
// than the runtime's error page, which carries no cache headers.
export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  try {
    return await routeAuthorize(request, env);
  } catch (error) {
    console.error("authorize_unexpected_error", error instanceof Error ? error.message : String(error));
    return htmlResponse(errorPage(UNEXPECTED_FAILURE, 500), 500);
  }
}

async function routeAuthorize(request: Request, env: Env): Promise<Response> {
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
