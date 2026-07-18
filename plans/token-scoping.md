# Token scoping

**What**: Support multiple API tokens, each scoped to a subset of mailboxes
(e.g. an INBOX-only token for a less-trusted agent, a full-access token for
a trusted one).

**Why deferred**: Single consumer today — one token, one trusted caller —
so there's nothing to scope yet.

**Sketch**:
- Replace the single `API_TOKEN` secret with a token registry: either
  multiple Worker secrets (`API_TOKEN_<name>`) each paired with a
  `wrangler.jsonc` var listing that token's allowed mailboxes, or a KV-backed
  registry of `sha256(token) -> { name, allowedMailboxes }`.
- `src/index.ts`: after the existing timing-safe bearer check, resolve which
  token matched and attach its mailbox scope to the request context instead
  of the global `ALLOWED_MAILBOXES`.
- `src/rest.ts` / `src/mcp.ts` / `src/core.ts`: thread the per-request scope
  through mailbox-listing and search/fetch calls, intersecting with the
  requested mailbox instead of checking a single global list.
- DEPLOY.md: document adding/rotating/revoking one token without touching
  others.

**Effort**: M
