# OAuth for /mcp

**What**: Add OAuth 2.1 to the `/mcp` endpoint via
`workers-oauth-provider` so claude.ai's remote-connector UI (which requires
OAuth, not raw bearer headers) can add this server directly.

**Why deferred**: No current claude.ai-connector need — Claude Code, opencode,
and Codex all already work fine with the static bearer header today.

**Sketch**:
- `npm install @cloudflare/workers-oauth-provider` (or equivalent), wrap the
  `/mcp` fetch handler per its docs.
- New KV namespace for OAuth state/token storage (client registrations,
  authorization codes, refresh tokens).
- Since there's only one resource owner (the Apple account owner) and no
  real "consent screen" data, the authorization UI can be a single static
  approve/deny page gated by the existing bearer token or a simple
  password check.
- Keep `/v1/*` REST and the existing bearer-header path on `/mcp` working
  unchanged for non-browser clients; OAuth is additive, not a replacement.
- Update README MCP section with claude.ai connector setup instructions.

**Effort**: M
