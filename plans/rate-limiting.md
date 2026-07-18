# Rate limiting

**What**: Cap request rate to the Worker to bound the damage from a leaked
token or a runaway/looping agent.

**Why deferred**: Low current exposure — one token, one trusted caller,
already capped by `MAX_RESULTS`/`MAX_SEARCH_DAYS`/`MAX_MESSAGE_BYTES` per
request; no evidence of abuse to justify the added complexity yet.

**Sketch**:
- Simplest: a Cloudflare dashboard rate-limiting rule on the Worker's
  hostname (requests/minute per IP), no code change.
- Alternative if per-token (not per-IP) limiting is wanted: KV or Durable
  Object counter keyed by the token hash, checked in `src/index.ts` before
  dispatching to `src/rest.ts` / `src/mcp.ts`, returning `429` with a
  `Retry-After` header past the threshold.
- Either way, log (without content) when the limit trips, so it's visible in
  `wrangler tail`.

**Effort**: S
