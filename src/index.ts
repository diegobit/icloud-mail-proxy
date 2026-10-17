// Worker entry point. Every request goes through the OAuth provider
// (@cloudflare/workers-oauth-provider):
//   /mcp                 -> MCP handler, behind an OAuth access token or the static bearer
//   /authorize           -> sign-in and consent pages (defaultFetch -> oauth-authorize)
//   /authorize/consent
//   /oauth/token         -> implemented by the provider (token issuance, revocation)
//   /oauth/register      -> dynamic client registration, rate-limited here first
//   /.well-known/*       -> provider metadata; unknown paths answer 404 JSON
//   everything else      -> REST API behind the static bearer
// All responses are marked private/no-store so nothing gets cached.

import OAuthProvider, { GrantType, OAuthError } from "@cloudflare/workers-oauth-provider";
import { epochMatches, grantEpoch, isAuthorized, json, tokenMatches, withNoStore } from "./auth";
import { createMailMcpHandler } from "./mcp";
import { handleAuthorize } from "./oauth-authorize";
import { handleRest } from "./rest";
import type { Env } from "./types";

/** Props the provider puts on ctx for both grant tokens and the static bearer. */
interface GrantProps {
  epoch?: unknown;
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
      const origin = requestOrigin(request, env);
      return json({ error: { code: "invalid_token", message: "API token rotated; reconnect" } }, 401, {
        "WWW-Authenticate":
          `Bearer realm="OAuth", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", ` +
          `error="invalid_token", scope="mail:read"`,
      });
    }
    return createMailMcpHandler(env)(request, env, ctx);
  },
};

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
    // rotating API_TOKEN cuts existing OAuth grants (see grantEpoch).
    tokenExchangeCallback: async ({ grantType, props, env }) => {
      if (grantType !== GrantType.AUTHORIZATION_CODE && grantType !== GrantType.REFRESH_TOKEN) return;
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

    if (request.method === "POST" && new URL(request.url).pathname === "/oauth/register") {
      const key = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.OAUTH_REGISTER_LIMITER.limit({ key });
      if (!success) {
        return withNoStore(json({ error: { code: "rate_limited", message: "too many registration attempts" } }, 429));
      }
    }

    const origin = requestOrigin(request, env);
    return withNoStore(await providerFor(origin).fetch(request, env, ctx));
  },
} satisfies ExportedHandler<Env>;
