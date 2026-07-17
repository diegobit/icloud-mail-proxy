// Worker entry point. Enforces bearer auth on every request, then routes:
//   POST/GET/DELETE /mcp  -> MCP Streamable HTTP handler
//   everything else       -> REST API
// All responses are marked private/no-store so nothing gets cached.

import { createMailMcpHandler } from "./mcp";
import { handleRest } from "./rest";
import type { Env } from "./types";

const encoder = new TextEncoder();

function json(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Attach the no-store cache directive to any response. */
function withNoStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/** Constant-time comparison of two 32-byte digests. */
function digestsEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  return crypto.subtle.timingSafeEqual(a, b);
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m ? m[1] : null;
}

/**
 * Verify the request's bearer token against env.API_TOKEN. Both values are
 * SHA-256 hashed first so the constant-time compare works on equal-length
 * inputs and never branches on the secret's length.
 */
async function isAuthorized(request: Request, apiToken: string): Promise<boolean> {
  const presented = extractBearer(request);
  if (presented === null) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(apiToken)]);
  return digestsEqual(a, b);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.API_TOKEN) {
      return withNoStore(json({ error: { code: "not_configured", message: "server not configured" } }, 500));
    }

    if (!(await isAuthorized(request, env.API_TOKEN))) {
      return withNoStore(
        json(
          { error: { code: "unauthorized", message: "missing or invalid bearer token" } },
          401,
          { "WWW-Authenticate": "Bearer" },
        ),
      );
    }

    const url = new URL(request.url);
    if (url.pathname === "/mcp") {
      const mcpHandler = createMailMcpHandler(env);
      return withNoStore(await mcpHandler(request, env, ctx));
    }

    return withNoStore(await handleRest(request, env));
  },
} satisfies ExportedHandler<Env>;
