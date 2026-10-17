# OAuth 2.1 for /mcp

Status: planned, not started. Deferred until a connector needs it: Claude
Code, opencode and Codex already work with the static bearer header; ChatGPT
and claude.ai are the only clients that would benefit. Design checked against
`@cloudflare/workers-oauth-provider` 1.2.x docs and `dist/oauth-provider.js`,
reviewed by Claude Opus 5.5 (Oct 2026).

## Outcome and scope

The owner of a deployment can add it to ChatGPT (custom connector, developer
mode) or claude.ai (remote connector) by pasting `<origin>/mcp`, signing in
once with the deployment's existing `API_TOKEN` on a consent page served by
the Worker, and using the four read-only tools. Claude Code, opencode, Codex
and curl keep sending `Authorization: Bearer <API_TOKEN>` with no change.
Rotating `API_TOKEN` revokes every OAuth grant.

One implementation unit, steps in dependency order; each step leaves the repo
deployable and `npm test`, `npm run typecheck` and both bundle dry-runs green.

Keep: one Apple account per deployment, the REST API and its bearer gate
byte-for-byte, the MCP tool surface, no-store on every response, guided setup
and the production profile. Exclude: OAuth on `/v1/*`, per-scope tool
filtering, multiple users or identities, upstream identity providers, a
grant-management UI, remember-consent, and a `scheduled` purge handler (KV
TTLs already expire records; `purgeExpiredData()` stays an optional follow-up).

## Current constraints

- `src/index.ts` gates every path with one check: SHA-256 both sides, then
  `crypto.subtle.timingSafeEqual`; missing `API_TOKEN` is HTTP 500
  `not_configured` (closed). `/mcp` goes to `createMailMcpHandler(env)`
  (`src/mcp.ts`, a fresh `McpServer` per request via `agents/mcp`), all else
  to `handleRest`. Unknown paths, including `/.well-known/*`, answer 401
  without a token.
- The deployment URL is unknown at build time: guided setups serve
  `<worker>.<subdomain>.workers.dev` (`workers_dev: true` in
  `wrangler.base.jsonc`); the `production` profile serves
  `icloud-mail.diegobit.com` with `workers_dev: false`.
- `wrangler.base.jsonc` is the single source of runtime settings; targets may
  only set `FRAGMENT_KEYS` (`scripts/lib/config.mjs`), so bindings and
  compatibility flags added to the base reach every target unchanged.
- No KV, rate-limiting binding or `.well-known` routes exist today. Workers
  Builds deploys `main` with `npm run deploy:production`, non-interactively,
  and never touches secrets.
- Tests run in plain Node under vitest (no workers pool). `crypto.subtle
  .timingSafeEqual` is a Workers extension, and the OAuth library imports
  Workers runtime modules, so `src/index.ts` is not importable from today's
  tests. Installed wrangler is 4.111.0, which exports `unstable_startWorker`.
- `scripts/lib/verify.mjs` checks anonymous `/healthz` = 401, authenticated
  `/healthz`, bearer MCP `initialize` + `tools/list`, and a one-message search.
  Its `fakeFetch` test helper matches rules by substring, in order.

## Implementation

### 1. Dependency, bindings and types

- `package.json`: add `@cloudflare/workers-oauth-provider` `^1.2` to
  `dependencies`.
- `wrangler.base.jsonc`: `compatibility_flags: ["nodejs_compat",
  "global_fetch_strictly_public"]` (CIMD fetches are refused, and CIMD is not
  advertised, without it); `"kv_namespaces": [{ "binding": "OAUTH_KV" }]`
  with no `id` (wrangler ≥ 4.45 provisions it on first non-interactive deploy
  — guided setup and Workers Builds alike — and keeps it linked to the
  Worker); `"ratelimits": [{ "name": "OAUTH_REGISTER_LIMITER", "namespace_id":
  "1001", "simple": { "limit": 5, "period": 60 } }]`. Comment each: why the
  flag, why no id, what the limiter protects.
- `src/types.ts`: add `OAUTH_KV: KVNamespace`, `OAUTH_REGISTER_LIMITER:
  RateLimit`, `OAUTH_PROVIDER: OAuthHelpers` (type-only import), optional
  `PUBLIC_ORIGIN?: string` (step 5).
- `test/setup/config.test.mjs`: the composed `local` and `production`
  configs carry `OAUTH_KV`, the limiter and both compat flags.
- CI: no workflow change; the existing `npm run check:bundle` and
  `npm run deploy:production -- --dry-run` steps now exercise the id-less KV
  binding. Run both locally before pushing.

Completion: dry-runs pass with the new bindings; the Worker code ignores them.

### 2. Extract the bearer primitives

Move `json`, `withNoStore`, `sha256`, `digestsEqual`, `extractBearer` and
`isAuthorized` from `src/index.ts` into `src/auth.ts`, exported, behaviour
unchanged. Add:

- `tokenMatches(presented: string, apiToken: string): Promise<boolean>` —
  the existing hash-then-constant-time compare; `isAuthorized` calls it.
  Returns false for an empty `apiToken`.
- `grantEpoch(apiToken: string): Promise<string>` — base64url
  HMAC-SHA256(key = `API_TOKEN`, message = `"grant-epoch-v1"`), memoized per
  isolate on the token value.
- `epochMatches(epoch: unknown, apiToken: string): Promise<boolean>`.

`test/auth.test.ts`: bearer parsing, match/mismatch/empty token, epoch is
deterministic, differs across tokens, and never equals or contains the token.
Add `test/support/workers-crypto.ts` (vitest `setupFiles`) that installs
`crypto.subtle.timingSafeEqual` from `node:crypto` when absent.

Completion: pure refactor; `src/index.ts` imports from `src/auth.ts`.

### 3. Consent pages

New `src/oauth-pages.ts`, pure string rendering with no library import:

- `escapeHtml(value)`.
- `tokenEntryPage({ client, authQuery, error? })`: client name, client
  domain and redirect host (from `describeConsent`), a password field for
  the API token, the original authorization query in a hidden field, POST
  to `/authorize`. Wording: "this grants read-only access to the mailbox
  folders this proxy exposes".
- `consentPage({ client, handle })`: the same client facts, the single fixed
  permission "Read mail (mail:read)", Approve/Deny posting `handle` and
  `action` to `/authorize/consent`. No scope checkboxes.
- `errorPage(message, status)`.
- `htmlHeaders()`: `Content-Type: text/html; charset=utf-8`,
  `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline';
  frame-ancestors 'none'; base-uri 'none'` (no `form-action`: Chrome applies
  it to the post-submit redirect to the client's host), `X-Frame-Options:
  DENY`, `Referrer-Policy: no-referrer`.

`test/oauth-pages.test.ts`: hostile client names, URIs and query values are
escaped in text and attribute context; no scope inputs exist; headers
present; the token field is `type="password"`.

Completion: unused module, tests green.

### 4. `/authorize` handler

New `src/oauth-authorize.ts`, `handleAuthorize(request, env): Promise<Response>`.
It only uses `env.OAUTH_PROVIDER` (typed via `import type`), so tests pass a
fake helpers object.

- `GET /authorize`: `parseAuthRequest(request)`; on `AuthorizationError`
  redirect to `.redirectTo` when the library validated the client and
  redirect URI, otherwise `errorPage(400)`. `lookupClient(clientId)` (null →
  400; `CimdFetchError` → 400 with a "client metadata unavailable" message).
  Render `tokenEntryPage`. Writes nothing.
- `POST /authorize`: re-parse the auth request from the hidden query (rebuild
  a GET `Request` for `parseAuthRequest`), then `tokenMatches(form.token,
  env.API_TOKEN)`. Mismatch → re-render with a generic error, HTTP 401, still
  no writes. Match → `beginConsent(authRequest)` (first KV write), render
  `consentPage` with the returned `headers` (its `__Host-oauth-` cookie binds
  the handle to this browser).
- `POST /authorize/consent`: `action=deny` → `denyConsent(request, handle)`
  redirect. `action=approve` → `approveConsent(request, handle, { scope:
  ["mail:read"] })`, then `completeAuthorization({ request: approved, userId:
  "owner", scope: ["mail:read"], metadata: { clientName, approvedAt }, props:
  { epoch: await grantEpoch(env.API_TOKEN), via: "oauth" } })`; 302 to
  `redirectTo`, merging the consent `headers`. The token is not re-checked
  here: the handle exists only after a successful check. Default
  `revokeExistingGrants` stays on, so reconnecting a client replaces its
  previous grant.
- `state` and `iss` pass through the library untouched; nothing here reads
  or rewrites them.

`test/oauth-authorize.test.ts` with a fake `OAUTH_PROVIDER`: wrong or missing
token never calls `beginConsent`; approve always grants exactly
`["mail:read"]` whatever scopes the client requested; props carry the current
epoch; deny calls `denyConsent`; invalid client/redirect without `redirectTo`
renders 400 instead of redirecting; consent cookies survive into the redirect.

Completion: unused module, tests green.

### 5. Wire the provider into the Worker

`src/index.ts` becomes a thin dispatcher; the old bearer-gated `fetch` body
moves into `bearerFetch(request, env)` unchanged except that its `/mcp`
branch goes away (the provider's `apiRoute` owns `/mcp`).

- Outer `fetch`: missing `API_TOKEN` → 500 `not_configured` for every path,
  as today. `POST /oauth/register` → `env.OAUTH_REGISTER_LIMITER.limit({ key:
  CF-Connecting-IP })`; over limit → 429 JSON, before the provider runs. Then
  `withNoStore(await providerFor(origin).fetch(request, env, ctx))`.
- `requestOrigin(request, env)`: `env.PUBLIC_ORIGIN` when set (validated:
  https, or http on loopback; no path), else `new URL(request.url).origin`.
- `providerFor(origin)`: module-level `Map<string, OAuthProvider>`, capped at
  8 entries (evict oldest) so stray hostnames cannot grow it. One instance per
  origin keeps the library's client-assertion JWKS cache; the constructor is
  synchronous validation only.
- `OAuthProvider` options: `apiRoute: "/mcp"`; `apiHandler: mcpApiHandler`;
  `defaultHandler: { fetch: defaultFetch }`; `authorizeEndpoint: "/authorize"`;
  `tokenEndpoint: "/oauth/token"`; `clientRegistrationEndpoint:
  "/oauth/register"`; `clientIdMetadataDocumentEnabled: true`;
  `scopesSupported: ["mail:read", "offline_access"]`; `requiredScopes:
  ["mail:read"]`; `resourceMetadata: { resource: `${origin}/mcp`,
  authorization_servers: [origin], bearer_methods_supported: ["header"],
  resource_name: "icloud-mail-proxy" }`; default TTLs (1 h access, 30 d
  refresh, 90 d DCR clients).
- `resolveExternalToken({ token, env })`: `tokenMatches(token,
  env.API_TOKEN)` → `{ props: { epoch: await grantEpoch(env.API_TOKEN), via:
  "bearer" }, audience: `${origin}/mcp` }`, else `null`. A documented MCP
  compatibility pattern; acceptable because the token is this server's own
  credential and is never forwarded upstream. Confirm in `dist` that a
  non-`userId:grantId:secret` token reaches this without a KV read, so CLI
  clients do no KV operations.
- `tokenExchangeCallback({ grantType, props, env })`: for
  `authorization_code` and `refresh_token`, `epochMatches(props.epoch,
  env.API_TOKEN)` or `throw new OAuthError("invalid_grant", { description:
  "API token rotated; reconnect" })`, which also revokes the grant.
- `mcpApiHandler.fetch(request, env, ctx)`: read `ctx.props` (confirm the
  field against `dist`; 1.2 also sets `ctx.auth`, which stays ignored);
  epoch mismatch → 401 with `WWW-Authenticate: Bearer realm="OAuth",
  error="invalid_token", resource_metadata="<origin>/.well-known/
  oauth-protected-resource/mcp"`; else `createMailMcpHandler(env)(request,
  env, ctx)`. Tools stay unaware of the auth path.
- `defaultFetch`: `/authorize` and `/authorize/consent` → `handleAuthorize`;
  any other `/.well-known/*` → 404 JSON `{ error: { code: "not_found" } }`
  (not 401, so discovery probes don't misread it; a JSON error body also keeps
  `verify.mjs` from treating it as propagation); everything else →
  `bearerFetch`.
- Update the header comment of `src/index.ts` and the routing summary.

`test/oauth.integration.test.mjs`, using wrangler's `unstable_startWorker`
on `wrangler.base.jsonc` with `API_TOKEN` and dummy iCloud bindings and a
tmpdir persist path (no IMAP is touched: `initialize` and `tools/list` only):

- Protected-resource and AS metadata values; unknown `/.well-known/x` → 404;
  anonymous `POST /mcp` → 401 with `resource_metadata` and `scope`;
  anonymous `/healthz` and `/v1/mailboxes` → 401 JSON as today.
- Bearer `initialize` + `tools/list` on `/mcp` works.
- Full flow: DCR with a loopback redirect URI, PKCE S256, token page (wrong
  token → 401, no consent handle), consent approve, code exchange, OAuth
  access token works on `/mcp` and is rejected on `/v1/mailboxes`.
- Rotation: restart on the same persist dir with a new `API_TOKEN`; the old
  access token → 401 `invalid_token`; refresh → `invalid_grant`; a second
  refresh with the same token still fails (grant revoked).
- Registration over the limit → 429.

Completion: deployed Worker serves OAuth and bearer side by side; existing
REST behaviour and setup verification unchanged.

### 6. Setup verification and connection instructions

`scripts/lib/verify.mjs`: `checkOAuthDiscovery({ base, fetchImpl, retry,
deadlineMs })`, run right after the anonymous check (needs no token, so it
also runs in token-skipped runs). Three hard checks, `kind: "oauth"`:

- `GET /.well-known/oauth-protected-resource/mcp` → 200, `resource ==
  <origin>/mcp`, `authorization_servers` contains `<origin>`.
- `GET /.well-known/oauth-authorization-server` → `issuer == <origin>` and
  `client_id_metadata_document_supported: true` (catches a missing compat
  flag).
- Anonymous `POST /mcp` → 401 whose `WWW-Authenticate` has
  `resource_metadata="<origin>/.well-known/oauth-protected-resource/mcp"` and
  `scope="mail:read"`.

`<origin>` is `new URL(base).origin`. A 401 on the metadata URLs means the
deployed code predates OAuth; say so in the detail.

`scripts/lib/setup.mjs`:
- `verificationHint`: `case "oauth"` — bearer clients work; check the
  `global_fetch_strictly_public` flag and the `OAUTH_KV` binding in the
  deploy output, then re-run setup.
- `connectionInstructions`: after the CLI snippets, "ChatGPT (Settings →
  Connectors → developer mode → custom connector, URL `<url>/mcp`)"
  and "claude.ai (Settings → Connectors → Add custom connector, URL
  `<url>/mcp`)"; both ask for the API token once on the Worker's sign-in page.
- "About to:" summary: one line that the first deploy creates the `OAUTH_KV`
  namespace.

Tests: `verify.test.mjs` — the three checks pass/fail individually, wrong
`issuer`/`resource`, missing CIMD flag, 401 on metadata (pre-OAuth Worker),
and existing success fixtures gain an `okOAuth` rule set placed before the
`/mcp` rule (`fakeFetch` matches by substring, and the metadata path contains
`/mcp`). `setup-flow.test.mjs`: `oauth` failure maps to its hint.
`integration.test.mjs`: printed instructions mention ChatGPT and claude.ai.

Completion: `npm run setup` fails loudly on a deployment whose OAuth
discovery is broken, while REST/bearer checks report as before.

### 7. Documentation

- README "Connect your agent": ChatGPT and claude.ai snippets as above; note
  that the sign-in page asks for the API token once per connector and that
  OAuth covers `/mcp` only. "MCP": two auth paths. "Security model": new
  bullet — OAuth tokens are issued by this Worker after the owner enters
  `API_TOKEN`; scope is fixed to `mail:read` and grants read-only access to
  the allowed folders; the static bearer is also accepted on `/mcp` as an
  external token (own credential, never forwarded upstream); no
  remember-consent, because ChatGPT's CIMD `client_id` is shared by every
  ChatGPT user and a remembered consent would make a crafted `/authorize`
  link silently approvable; grants are bound to the current `API_TOKEN`.
  "Architecture": the provider layer and `OAUTH_KV`.
- DEPLOY.md: "Rotation" — rotating `API_TOKEN` revokes every OAuth grant;
  reconnect ChatGPT/claude.ai afterwards (it is also the way to revoke a
  connector). "Configuration and targets" — `OAUTH_KV` auto-provisioning,
  the limiter `namespace_id`, `PUBLIC_ORIGIN` for tunnels/proxies.
  "Diagnostics" — KV is eventually consistent: a token issued at one Cloudflare
  location can fail at another for up to ~60 s; retry before debugging. "CI"
  — dry-runs cover the id-less binding; Workers Builds provisions it on the
  first build. Deleting a Worker leaves `OAUTH_KV`: `npx wrangler kv namespace
  delete`.
- `.dev.vars.example`: commented `PUBLIC_ORIGIN=` for a tunnel run.

### 8. Live acceptance

Owner-run, recorded in this file: `npm run dev` with `PUBLIC_ORIGIN` set to a
`cloudflared tunnel --url http://localhost:8787` hostname; connect ChatGPT
(developer mode) and claude.ai; run `list_mailboxes` and one `search_mail`
from each; rotate `API_TOKEN` in `.dev.vars` and confirm both connectors are
forced to reconnect. Then one `npm run setup` rerun against a test Worker.

## Acceptance criteria

- `npm test`, `npm run typecheck`, `npm run check:bundle` and
  `npm run deploy:production -- --dry-run` pass, locally and in CI.
- Bearer clients unchanged: `/v1/*`, `/healthz` and `/mcp` with
  `Authorization: Bearer <API_TOKEN>` behave as before; anonymous `/healthz`
  is still 401 JSON; missing `API_TOKEN` is still 500 `not_configured`.
- `GET /.well-known/oauth-protected-resource/mcp` returns `resource ==
  <origin>/mcp`; AS metadata has `issuer == <origin>` and
  `client_id_metadata_document_supported: true`; anonymous `POST /mcp`
  returns 401 with `resource_metadata="<origin>/.well-known/
  oauth-protected-resource/mcp"` and `scope="mail:read"`; unknown
  `/.well-known/*` returns 404. `npm run setup` checks all of this.
- No KV write happens before a correct API token is entered, except DCR
  (rate-limited) and whatever CIMD caching the library does (see risks).
- Every grant has scope exactly `["mail:read"]`; OAuth tokens are rejected on
  `/v1/*`.
- After rotating `API_TOKEN`, OAuth access tokens get 401 `invalid_token` and
  refresh gets `invalid_grant`; the grant is gone.
- ChatGPT and claude.ai each connect through a tunnel on `wrangler dev`, list
  the four tools and run a search (step 8).

## Open items and risks

- **Id-less KV in CI dry-runs.** Confirm `wrangler deploy --dry-run` accepts a
  `kv_namespaces` entry without `id` (step 1 surfaces it immediately). If it
  does not, keep the id-less entry for real deploys and drop the binding from
  dry-run configs, or pin an id in the production profile (would need
  `kv_namespaces` in `FRAGMENT_KEYS`).
- **Redirect URIs and `state`.** ChatGPT and claude.ai callback URLs must
  match exactly what they register (DCR) or publish (CIMD); `state` and `iss`
  are preserved by the library. Only the live run proves both clients; record
  their callback hosts in README if anything needs allowlisting.
- **`request.url` behind a tunnel.** `wrangler dev` may see `http://` on the
  tunnel hostname, which the library rejects as a non-loopback issuer;
  `PUBLIC_ORIGIN` is the escape hatch (`--local-upstream`/`--upstream-protocol`
  are the alternative if they set `request.url` correctly).
- **Multiple origins.** Each hostname (workers.dev, a custom domain, preview
  URLs) is a separate issuer with its own grants — harmless but confusing.
  The production profile already sets `workers_dev: false`; decide whether
  the base sets `preview_urls: false`, and whether guided users adding a
  custom domain should turn `workers_dev` off or set `PUBLIC_ORIGIN`.
- **KV free tier.** 1,000 writes/day. Normal use is a few writes per login
  plus about two per hourly refresh per connector. `/oauth/register` is
  unauthenticated: the per-IP limiter slows abuse but cannot cap a day, so a
  distributed attacker can exhaust writes and block OAuth logins/refreshes
  until the daily reset; bearer clients are unaffected. Check in `dist`
  whether CIMD lookups cache into KV; if so, rate-limit `GET /authorize`
  for URL `client_id`s too. If claude.ai supports CIMD, consider disabling
  DCR by default.
- **Clients with a wrong bearer.** `/mcp` now advertises OAuth on 401, so a
  CLI with a stale token may start a browser OAuth flow instead of failing
  (opencode's `"oauth": false` already prevents this).
- **Rate-limit binding.** `namespace_id` is shared by Workers in one account
  (two deployments share counters — acceptable). Confirm availability on the
  free plan during the first real deploy.
- **Library surface to confirm in `dist`.** `ctx.props` on `apiHandler`,
  `beginConsent` argument type, `OAuthError` export path, and plain-object
  `apiHandler`/`defaultHandler` acceptance.
- **`unstable_startWorker` stability.** If it proves flaky in CI or Workers
  Builds, move the integration test behind its own npm script and keep it out
  of the deploy build command.

## Estimate

M: 2–3 developer days plus about half a day of live acceptance. OAuth
mechanics, DCR/CIMD, PKCE, token storage and discovery come from the
library; the custom work is the token and consent pages, epoch wiring,
origin handling, rate limit, setup verification, the integration test and
docs. Live acceptance needs a tunnel, a ChatGPT plan with developer mode,
and a claude.ai account with custom connectors.
