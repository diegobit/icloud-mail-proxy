# Cloudflare Access in front of the Worker

**What**: Put a Cloudflare Access application (service-token auth) in front
of the Worker's route, as a second auth layer before requests even reach the
bearer-token check.

**Why deferred**: Setup friction (Access app + service token provisioning,
extra header plumbing) versus marginal gain — this is a single-user service
already gated by a SHA-256/timing-safe bearer check on every request.

**Sketch**:
- Cloudflare dashboard (or Terraform/`wrangler` if scriptable): create an
  Access application scoped to the Worker's hostname, issue a service token
  (client ID + secret).
- Client side: add `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers
  alongside the existing `Authorization: Bearer` header in all client configs
  (README's Claude Code / opencode / Codex snippets).
- `src/index.ts`: no code change needed if Access is enforced at Cloudflare's
  edge before the Worker runs; optionally verify the Access JWT
  (`Cf-Access-Jwt-Assertion`) in-Worker for defense-in-depth if Access is ever
  misconfigured to "allow" mode.
- Document rotation of the service token in DEPLOY.md.

**Effort**: S
