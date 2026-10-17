// Worker entry point. Enforces bearer auth on every request, then routes:
//   POST/GET/DELETE /mcp  -> MCP Streamable HTTP handler
//   everything else       -> REST API
// All responses are marked private/no-store so nothing gets cached.

import { isAuthorized, json, withNoStore } from "./auth";
import { createMailMcpHandler } from "./mcp";
import { handleRest } from "./rest";
import type { Env } from "./types";

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
