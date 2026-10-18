// Worker entry point. Every request goes through the OAuth provider
// (@cloudflare/workers-oauth-provider):
//   /mcp                 -> MCP handler, behind an OAuth access token or the static bearer
//   /authorize           -> sign-in and consent pages (defaultFetch -> oauth-authorize)
//   /authorize/consent
//   /send/approve        -> owner approval page for outgoing drafts (only path that sends)
//   /oauth/token         -> implemented by the provider (token issuance,
//                           revocation), rate-limited here first
//   /oauth/register      -> dynamic client registration, rate-limited here first
//   /.well-known/*       -> provider metadata; unknown paths answer 404 JSON
//   everything else      -> REST API behind the static bearer
// All responses are marked private/no-store so nothing gets cached.

import OAuthProvider, { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import { epochMatches, grantEpoch, hasPkcePolicy, isAuthorized, json, tokenMatches, withNoStore } from "./auth";
import { createMailMcpHandler } from "./mcp";
import { handleAuthorize } from "./oauth-authorize";
import { handleRest } from "./rest";
import { handleApprove } from "./send-approve";
import type { Env } from "./types";

// The Durable Object class must be exported from the entry module so the
// `SEND_LEDGER` binding can resolve it (wrangler.base.jsonc).
export { SendLedger } from "./send-ledger";

/** Props the provider puts on ctx for both grant tokens and the static bearer. */
interface GrantProps {
  epoch?: unknown;
  pkce?: unknown;
  via?: unknown;
}

/** The origin clients reach: PUBLIC_ORIGIN when set (tunnels, proxies), else the request's. */
function requestOrigin(request: Request, env: Env): string {
  if (!env.PUBLIC_ORIGIN) return new URL(request.url).origin;
  const url = new URL(env.PUBLIC_ORIGIN);
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_ORIGIN must be an origin, without a path, query, or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new Error("PUBLIC_ORIGIN must be https (http is allowed on loopback only)");
  }
  return url.origin;
}

/**
 * The provider has already validated the access token, internal or external,
 * and put its props on ctx. The epoch check here catches grants minted from a
 * previous API_TOKEN between deploys (see grantEpoch).
 */
const mcpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = ctx.props as GrantProps | undefined;
    if (!(await epochMatches(props?.epoch, env.API_TOKEN))) {
      const origin = new URL(request.url).origin;
      return json({ error: { code: "invalid_token", message: "API token rotated; reconnect" } }, 401, {
        "WWW-Authenticate":
          `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
          `error="invalid_token", scope="mail:read"`,
      });
    }
    // Drafts are bound to the calling client: an OAuth grant's clientId, or
    // the shared static bearer. Another client cannot see or act on them.
    const auth = (ctx as { auth?: { clientId?: unknown } }).auth;
    const principal =
      typeof auth?.clientId === "string" && auth.clientId !== "" ? `oauth:${auth.clientId}` : "bearer";
    return createMailMcpHandler(env, principal)(request, env, ctx);
  },
};

/**
 * The 429 for an over-budget per-IP limiter, or null when the request may
 * proceed. Both unauthenticated OAuth endpoints that write to KV go through
 * this first; the fallback key covers local runs without CF-Connecting-IP.
 */
async function rateLimitGate(request: Request, limiter: RateLimit, message: string): Promise<Response | null> {
  const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
  const { success } = await limiter.limit({ key });
  if (success) return null;
  return withNoStore(json({ error: { code: "rate_limited", message } }, 429));
}

/**
 * The same URL on `origin`, with pathname, query and fragment untouched.
 * Used when PUBLIC_ORIGIN overrides the request's origin (e.g. `wrangler dev`
 * behind a cloudflared tunnel): only the origin is replaced, so a pathname
 * like `//host/oauth/register` is never re-read as a network-path reference
 * that changes the host or collapses onto a gated path.
 */
function withOrigin(url: URL, origin: string): URL {
  const publicUrl = new URL(origin);
  const rewritten = new URL(url);
  rewritten.protocol = publicUrl.protocol;
  rewritten.host = publicUrl.host;
  // Assigning `host` alone keeps the old port; the origin's port is set
  // explicitly so loopback ports never leak into the public URL.
  rewritten.port = publicUrl.port;
  return rewritten;
}

/**
 * A sanitized 500 for unexpected failures on the way to the provider (a
 * rejected dispatch, a failing limiter binding): OAuth endpoints answer with
 * an RFC 6749 error body, everything else with the REST error shape. The
 * caller adds no-store, unlike the runtime error page it replaces.
 */
function dispatchFailure(pathname: string): Response {
  if (pathname.startsWith("/oauth/") || pathname.startsWith("/authorize")) {
    return json({ error: "server_error", error_description: "unexpected error" }, 500);
  }
  return json({ error: { code: "internal_error", message: "unexpected error" } }, 500);
}

/** Everything the provider does not own, behind the static bearer token. */
async function bearerFetch(request: Request, env: Env): Promise<Response> {
  if (!(await isAuthorized(request, env.API_TOKEN))) {
    return json({ error: { code: "unauthorized", message: "missing or invalid bearer token" } }, 401, {
      "WWW-Authenticate": "Bearer",
    });
  }
  return handleRest(request, env);
}

const defaultFetch = {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize" || url.pathname === "/authorize/consent") {
      return handleAuthorize(request, env);
    }
    if (url.pathname === "/send/approve") {
      return handleApprove(request, env);
    }
    if (url.pathname.startsWith("/.well-known/")) {
      return json({ error: { code: "not_found", message: "not found" } }, 404);
    }
    return bearerFetch(request, env);
  },
};

/**
 * One provider per origin, kept across requests: the library's constructor is
 * synchronous validation only, and a fresh instance per request would discard
 * the client-assertion JWKS cache. The deployment URL is unknown at build
 * time (workers.dev vs custom domain), hence the map. Capped so stray
 * hostnames cannot grow it without bound.
 */
const PROVIDER_LIMIT = 8;
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  const cached = providers.get(origin);
  if (cached) return cached;

  const provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApiHandler,
    defaultHandler: defaultFetch,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ["mail:read", "offline_access"],
    requiredScopes: ["mail:read"],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      resource_name: "icloud-mail-proxy",
    },
    // The static API token also works on /mcp: it is this server's own
    // credential, never forwarded upstream (plans/oauth-mcp.md).
    resolveExternalToken: async ({ token, env }) =>
      (await tokenMatches(token, env.API_TOKEN))
        ? { props: { epoch: await grantEpoch(env.API_TOKEN), via: "bearer" }, audience: `${origin}/mcp` }
        : null,
    // An invalid_grant thrown here revokes the grant and its tokens, so
    // rotating API_TOKEN cuts existing OAuth grants (see grantEpoch) and
    // grants minted before PKCE was mandatory stay non-exchangeable (see
    // hasPkcePolicy).
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      if (grantType !== GrantType.AUTHORIZATION_CODE && grantType !== GrantType.REFRESH_TOKEN) return;
      if (!hasPkcePolicy(props)) {
        throw new OAuthError("invalid_grant", { description: "Grant predates the PKCE requirement; reconnect" });
      }
      if (!(await epochMatches(props?.epoch, env.API_TOKEN))) {
        throw new OAuthError("invalid_grant", { description: "API token rotated; reconnect" });
      }
    },
  });

  if (providers.size >= PROVIDER_LIMIT) {
    const oldest = providers.keys().next().value;
    if (oldest !== undefined) providers.delete(oldest);
  }
  providers.set(origin, provider);
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.API_TOKEN) {
      return withNoStore(json({ error: { code: "not_configured", message: "server not configured" } }, 500));
    }

    let origin: string;
    try {
      origin = requestOrigin(request, env);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid PUBLIC_ORIGIN";
      return withNoStore(json({ error: { code: "not_configured", message } }, 500));
    }

    // When PUBLIC_ORIGIN overrides the request's origin, rewrite the request
    // URL onto that origin so the provider's issuer, metadata URL matching,
    // audience checks, and `__Host-` consent cookie checks all see the public
    // origin. Only the origin is replaced: the pathname is copied as parsed,
    // so a `//host/...` path can neither change the host nor become a gated
    // path (e.g. `/oauth/register`) after the checks below have run. The
    // checks run on the effective pathname — the one the provider dispatches.
    const url = new URL(request.url);
    const effectiveUrl = url.origin === origin ? url : withOrigin(url, origin);
    const pathname = effectiveUrl.pathname;

    try {
      if (request.method === "POST" && pathname === "/oauth/register") {
        const limited = await rateLimitGate(request, env.OAUTH_REGISTER_LIMITER, "too many registration attempts");
        if (limited) return limited;
      }
      if (request.method === "POST" && pathname === "/oauth/token") {
        const limited = await rateLimitGate(request, env.OAUTH_TOKEN_LIMITER, "too many token requests");
        if (limited) return limited;
      }

      // The library intercepts all `/.well-known/oauth-protected-resource*`
      // paths and returns a bare bodyless 404 when the suffix is not `/mcp`.
      // Answer those here with our standard 404 JSON so every unknown
      // `.well-known` path behaves uniformly.
      if (
        pathname.startsWith("/.well-known/oauth-protected-resource") &&
        pathname !== "/.well-known/oauth-protected-resource/mcp"
      ) {
        return withNoStore(json({ error: { code: "not_found", message: "not found" } }, 404));
      }

      const effectiveRequest = effectiveUrl === url ? request : new Request(effectiveUrl, request);
      // The library memoizes its helpers on `env.OAUTH_PROVIDER` and reuses
      // them whenever present, so handing it the shared env would pin the
      // first origin's resource configuration (issuer, resource URLs) onto
      // every other origin. Each dispatch gets a fresh wrapper without it.
      const { OAUTH_PROVIDER: _memoized, ...dispatchEnv } = env;
      return withNoStore(await providerFor(origin).fetch(effectiveRequest, dispatchEnv as Env, ctx));
    } catch (error) {
      console.error("provider_dispatch_error", error instanceof Error ? error.message : String(error));
      return withNoStore(dispatchFailure(pathname));
    }
  },
} satisfies ExportedHandler<Env>;
