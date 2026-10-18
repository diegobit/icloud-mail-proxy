# OAuth 2.1 for /mcp

Status: shipped. Steps 1–7 and four review rounds are merged to `main`, and the
first live acceptance ran against production on 2026-10-18: ChatGPT connects
over OAuth; claude.ai and the rotation rehearsal are not tried yet. Design
checked against `@cloudflare/workers-oauth-provider` 1.2.x docs and
`dist/oauth-provider.js`, reviewed by Claude Opus 5.5 and GPT-6-Astra (Oct
2026).

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
  Worker); `"ratelimits"` with two per-IP bindings: `OAUTH_REGISTER_LIMITER`
  (`namespace_id` `1001`, 5/60 s) and `OAUTH_TOKEN_LIMITER` (`namespace_id`
  `1002`, 30/60 s). Comment each: why the flag, why no id, what the limiters
  protect.
- `src/types.ts`: add `OAUTH_KV: KVNamespace`, `OAUTH_REGISTER_LIMITER:
  RateLimit`, `OAUTH_TOKEN_LIMITER: RateLimit`, `OAUTH_PROVIDER: OAuthHelpers`
  (type-only import), optional `PUBLIC_ORIGIN?: string` (step 5).
- `test/setup/config.test.mjs`: the composed `local` and `production`
  configs carry `OAUTH_KV`, both limiters and both compat flags.
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
  redirect URI, otherwise `errorPage(400)`. A request without an S256 PKCE
  challenge is redirected back with `invalid_request` before anything else.
  `lookupClient(clientId)` (null → 400; `CimdFetchError` → 400 with a "client
  metadata unavailable" message). Render `tokenEntryPage`. Writes nothing.
- `POST /authorize`: re-parse the auth request from the hidden query (rebuild
  a GET `Request` for `parseAuthRequest`), same S256 check, then
  `tokenMatches(form.token, env.API_TOKEN)`. Mismatch → re-render with a
  generic error, HTTP 401, still no writes. Match → `beginConsent(authRequest)`
  (first KV write), render `consentPage` with the returned `headers` (its
  `__Host-oauth-` cookie binds the handle to this browser) and the epoch
  computed from the token just verified.
- `POST /authorize/consent`: `action=deny` → `denyConsent(request, handle)`
  redirect. `action=approve` → the epoch the consent page carried is checked
  against `env.API_TOKEN` (mismatch → 400 `errorPage`, no grant): a consent
  transaction left pending across a token rotation cannot mint a fresh grant.
  The stored transaction's own request must still carry an S256 challenge
  (a consent page left open across the PKCE upgrade → 400, transaction
  consumed). Then `approveConsent(request, handle, { scope: ["mail:read"] })`,
  then
  `completeAuthorization({ request: approved, userId: "owner", scope:
  ["mail:read"], metadata: { clientName, approvedAt }, props: { epoch,
  pkce: true, via: "oauth" } })`; 302 to `redirectTo`, merging the consent
  `headers`. Default `revokeExistingGrants` stays on, so reconnecting a
  client replaces its previous grant.
- Error redirects to a library-validated redirect URI mirror the library's
  `authorizationErrorRedirect`: stale `error`, `error_description`,
  `error_uri`, `state` and `iss` parameters are replaced, and `iss` (from
  `AuthRequest.issuer`) is set, so the issuer the discovery metadata
  advertises is present on errors too. The helper itself is not imported —
  its module loads `cloudflare:workers` and would break the Node-run tests.
- `state` passes through the library untouched; nothing here reads or
  rewrites it.

`test/oauth-authorize.test.ts` with a fake `OAUTH_PROVIDER`: wrong or missing
token never calls `beginConsent`; a request without an S256 challenge is
redirected back with `invalid_request` before `beginConsent`; approve always
grants exactly `["mail:read"]` whatever scopes the client requested; props
carry the epoch from the consent form plus the `pkce` marker; an approval
whose epoch does not match the current token is refused before
`approveConsent`; a stored transaction without an S256 challenge is refused
before `completeAuthorization`; the error redirect clears stale response
parameters and carries `iss`; deny calls `denyConsent`; invalid
client/redirect without `redirectTo` renders 400 instead of redirecting;
consent cookies survive into the redirect.

Completion: unused module, tests green.

### 5. Wire the provider into the Worker

`src/index.ts` becomes a thin dispatcher; the old bearer-gated `fetch` body
moves into `bearerFetch(request, env)` unchanged except that its `/mcp`
branch goes away (the provider's `apiRoute` owns `/mcp`).

- Outer `fetch`: missing `API_TOKEN` or invalid `PUBLIC_ORIGIN` → 500
  `not_configured` for every path. `POST /oauth/register` and `POST
  /oauth/token` → `env.OAUTH_REGISTER_LIMITER.limit({ key: CF-Connecting-IP
  })` and `env.OAUTH_TOKEN_LIMITER` (30/60 s: CIMD client-assertion replay
  markers make the token endpoint a KV write path too); over limit → 429
  JSON, before the provider runs. Rewrite `request` onto `origin` when
  `PUBLIC_ORIGIN` differs from `new URL(request.url).origin`, replacing only
  protocol, host and port so the pathname stays as parsed; the limiter gates
  and the unknown-`.well-known` 404 all run on that effective pathname, and
  the provider is handed a fresh `{ ...env }` wrapper (it memoizes its
  helpers on `env.OAUTH_PROVIDER`, which would otherwise pin the first
  origin's resource configuration). Then `withNoStore(await
  providerFor(origin).fetch(effectiveRequest, dispatchEnv, ctx))`, with
  unexpected dispatch or limiter failures answered as a controlled no-store
  500 instead of the runtime error page.
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
  `authorization_code` and `refresh_token`, both `hasPkcePolicy(props)`
  (grants minted before PKCE became mandatory are refused) and
  `epochMatches(props.epoch, env.API_TOKEN)` must hold, else
  `throw new OAuthError("invalid_grant", { description: … })`, which also
  revokes the grant.
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
- `PUBLIC_ORIGIN` tunnel override: metadata, challenges, static bearer and
  full OAuth flow work when reached on loopback with an HTTPS `PUBLIC_ORIGIN`;
  an invalid `PUBLIC_ORIGIN` fails closed with 500 `not_configured` JSON.
- Registration over the limit → 429; more than thirty token requests in a
  minute → 429.
- Anonymous `/healthz` and `/v1/mailboxes` → 401 JSON; an OAuth access token
  is rejected the same way on both.

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
deployed code predates OAuth; say so in the detail. Both metadata reads are
retried on 401 first, because right after a deploy the previous pre-OAuth
version can still answer.

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
`issuer`/`resource`, missing CIMD flag, 401 on metadata (pre-OAuth Worker)
and a 401 that clears on the retry, and existing success fixtures gain an
`okOAuth` rule set placed before the `/mcp` rule (`fakeFetch` matches by
substring, and the metadata path contains `/mcp`). `setup-flow.test.mjs`:
`oauth` failure maps to its hint. `integration.test.mjs`: printed
instructions mention ChatGPT and claude.ai.

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
- No KV write happens before a correct API token is entered, except DCR and
  CIMD client-assertion replay markers on `/oauth/token` (both per-IP
  rate-limited) and whatever CIMD caching the library does (see risks).
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
  `kv_namespaces` in `FRAGMENT_KEYS`). *Confirmed in step 1: both dry-runs
  accept it.*
- **Redirect URIs and `state`.** ChatGPT and claude.ai callback URLs must
  match exactly what they register (DCR) or publish (CIMD); `state` and `iss`
  are preserved by the library. Only the live run proves both clients; record
  their callback hosts in README if anything needs allowlisting.
- **`request.url` behind a tunnel.** `wrangler dev` sees `http://` on the
  local or tunnel hostname rather than the public `https://` origin, so
  without an override the provider would advertise `http://` endpoints and
  fail `__Host-` cookie and audience checks; `PUBLIC_ORIGIN` rewrites the
  request onto the public HTTPS origin before handing it to the provider.
- **Multiple origins.** Each hostname (workers.dev, a custom domain, preview
  URLs) is a separate issuer with its own grants — harmless but confusing.
  The production profile already sets `workers_dev: false`; decide whether
  the base sets `preview_urls: false`, and whether guided users adding a
  custom domain should turn `workers_dev` off or set `PUBLIC_ORIGIN`.
- **KV free tier.** 1,000 writes/day. Normal use is a few writes per login
  plus about two per hourly refresh per connector. Both unauthenticated write
  paths are per-IP rate-limited (`/oauth/register` 5/60 s, `/oauth/token`
  30/60 s), but the limits are per minute, not per day: one IP alone can still
  exhaust the daily budget (registration alone allows 7,200/day) and a
  distributed attacker trivially can, blocking OAuth logins/refreshes until
  the daily reset; bearer clients are unaffected. CIMD lookups do not write
  KV (they cache in the Cache API, confirmed), so the exposure is DCR,
  client-assertion replay markers and grant writes only. If claude.ai
  supports CIMD, consider disabling DCR by default.
- **Clients with a wrong bearer.** `/mcp` now advertises OAuth on 401, so a
  CLI with a stale token may start a browser OAuth flow instead of failing
  (opencode's `"oauth": false` already prevents this).
- **Rate-limit binding.** `namespace_id` is shared by Workers in one account
  (two deployments share counters — acceptable). Confirm availability on the
  free plan during the first real deploy.
- **Library surface to confirm in `dist`.** `ctx.props` on `apiHandler`,
  `beginConsent` argument type, `OAuthError` export path, and plain-object
  `apiHandler`/`defaultHandler` acceptance. *Confirmed against 1.2.3 during
  steps 4–5.*
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

## Implementation status

### Delivered

All seven code steps and all four review rounds are committed on `oauth-mcp`
(base `dev` @ `e6e38d2`); `npm test` (17 files, 259 tests), `npm run typecheck`
and both bundle dry-runs are green. Merged as PR #1 (`oauth-mcp` → `dev`) and
PR #2 (`dev` → `main`), then deployed with `npm run deploy:production`
(version `6a1489d5`; the first real deploy provisioned `OAUTH_KV`).

| Step | Commit | What landed |
| --- | --- | --- |
| Plan | `970e838` | This file, as written by the plan pass. |
| 1 | `d7d2f7e` | `@cloudflare/workers-oauth-provider` 1.2.3, `global_fetch_strictly_public`, id-less `OAUTH_KV`, `OAUTH_REGISTER_LIMITER` (5/60 s), `Env` additions. |
| 2 | `3013e31` | `src/auth.ts`: bearer primitives and the `grant-epoch-v1` HMAC; test crypto shim. |
| 3 | `a26c276` | `src/oauth-pages.ts`: token-entry, consent and error pages, escaped and CSP'd. |
| 4 | `3510986` | `src/oauth-authorize.ts`: `/authorize` and `/authorize/consent`; no KV write before a correct token. |
| 5 | `8fb7da1` | `src/index.ts` provider wiring (per-origin map, epoch check on `/mcp`, register limiter, `PUBLIC_ORIGIN`) plus `test/oauth.integration.test.mjs` against real workerd. |
| 6 | `39449a7` | `checkOAuthDiscovery` in `verify.mjs` (three hard checks, `kind: "oauth"`), setup hint, connector instructions, `OAUTH_KV` line in the "About to" summary. |
| 7 | `30e1586` | README (connectors, two auth paths, security bullet, architecture), DEPLOY (bindings, rotation, KV consistency, CI), `.dev.vars.example`. |
| Review 1 | `0032b29` | Round-1 review findings, including the `PUBLIC_ORIGIN` request rewriting. |
| Review 2 | `ad13296` | Round-2 review findings: `/oauth/token` rate limiter (M1), `/authorize` form and error guards (N1), integration coverage (L2, L3), setup 401 retry (L5), doc corrections (L1, L4). |
| Review 3 | `d625783` | Round-3 review findings (GPT-6-Astra): approval bound to the sign-in epoch (H1), origin-only request rewriting (M1), per-dispatch env wrappers so origins stay isolated (M2), S256 PKCE on every authorization request (M3), controlled 500s when the provider fails (L1), KV-write summary correction (N1). |
| Review 4 | `e20d136` | Round-4 review findings (GPT-6-Astra, no High/Medium): `iss` and stale-response-parameter handling on error redirects (L), PKCE re-checked on the stored consent transaction and a `pkce: true` marker enforced at every code exchange and refresh (L). |

The integration test starts the real Worker with `unstable_startWorker`
against `wrangler.base.jsonc` and covers: discovery metadata, `/.well-known`
unknown → 404, the anonymous `/mcp` challenge plus 401 JSON on anonymous
`/healthz` and `/v1/mailboxes`, static bearer initialize and `tools/list`,
the full dynamic-client flow (register, wrong token → 401 with no consent
transaction, consent, PKCE exchange, refresh, OAuth token on `/mcp` but
rejected with 401 JSON on `/v1/*` and `/healthz`), the PKCE requirement (no
challenge or `plain`, for public and confidential clients, refused before the
consent page, with `iss` on the bounce), per-origin isolation across `127.0.0.1` and `localhost`,
rotation (epoch 401 on `/mcp`, `invalid_grant - API token rotated; reconnect`
on refresh, then `invalid_grant - Grant not found` proving revocation, a
consent transaction left pending across the rotation whose approval is
refused, and a fresh reconnect with the new token), `PUBLIC_ORIGIN` tunnel
rewriting and validation (including double-slash paths that must not reach
the gated endpoints), and both rate limits (registration 5 then 429; token 30
then 429).

### Deviations from the plan

- `lookupClient` is not called separately: the library calls it inside
  `parseAuthRequest`, and an unknown client surfaces as an
  `AuthorizationError` from there.
- The test shim (`test/support/workers-crypto.ts`) installs a pure-JS
  `crypto.subtle.timingSafeEqual`; the repo has no `@types/node`, so the
  planned `node:crypto` import failed typecheck.
- `ExecutionContext<Props>` in workers-types has a required `props` field, so
  `mcpApiHandler` reads `ctx.props as GrantProps | undefined` instead of
  declaring a new interface.
- `unstable_startWorker` is the raw DevEnv: it needs `build.nodejsCompatMode:
  "v2"`, `dev.server.port` and secret values passed through `bindings` (no
  `.dev.vars`). The rotation worker reuses the same port and persist dir,
  because grants are bound to the origin they were issued for.
- `fakeFetch` learned function matchers: the anonymous challenge and the
  authenticated MCP calls share the `/mcp` URL and only differ by the
  `Authorization` header.
- The register limiter keys on `CF-Connecting-IP`, falling back to `"unknown"`
  when the header is absent (local runs), so the limit still applies there.
- `handleAuthorize` answers unparsable form bodies with a 400 page and wraps
  unexpected failures (e.g. a KV write error in `completeAuthorization`) in a
  500 no-store page, instead of letting them reach the runtime error page.
- `requestOrigin` validates `PUBLIC_ORIGIN` itself (bare origin, https or http
  on loopback), returning 500 `not_configured` JSON when invalid, and the
  outer `fetch` rewrites the request URL onto `PUBLIC_ORIGIN` before handing
  it to the provider so issuer, metadata URL matching, audience checks and
  `__Host-` consent cookies all use the public origin.
- Approval is bound to the sign-in epoch with a hidden form field instead of a
  second KV record: the consent page carries the epoch computed when the token
  was verified, the consent handler checks it against `API_TOKEN` before
  `approveConsent`, and only that verified value is stamped into the grant.
  Tampering or a stale field can therefore only produce a rejection — the
  epoch is a non-reversible HMAC, and a grant carrying anything but the
  current epoch fails the `/mcp` check anyway.
- The `PUBLIC_ORIGIN` rewrite replaces only origin and port on a parsed URL
  (`withOrigin`): the earlier `new URL(pathname, origin)` form read a
  `//host/...` pathname as a network-path reference, which changed the host
  and left `/oauth/register` behind it, past the rate-limit gates.
- Each dispatch hands the provider a fresh `{ ...env }` wrapper without
  `OAUTH_PROVIDER`: the library memoizes its helpers on that key, so the
  shared env pinned the first origin's resource configuration onto every
  other origin served by the same isolate.
- Consent-created grants carry `pkce: true`, and `tokenExchangeCallback`
  refuses authorization-code and refresh grants without that marker
  (`hasPkcePolicy` in `src/auth.ts`): a code or refresh token minted by a
  build that predates the PKCE requirement cannot be exchanged after the
  upgrade, so no deployment window can bridge it. `DEPLOY.md` describes the
  connector reconnect this causes.
- `/authorize` error redirects mirror the library's
  `authorizationErrorRedirect` locally rather than importing it: that module
  imports `cloudflare:workers` and cannot load under Node, which the unit
  tests rely on.

### Open items resolved

- **Id-less KV in CI dry-runs:** both `check:bundle` and
  `deploy:production --dry-run` accept `OAUTH_KV` without an id.
- **CIMD and KV writes:** CIMD lookups cache in the Cache API
  (`workers-oauth-provider:cimd:v1`), not KV; KV writes are grant,
  client-registration and consent-transaction records, plus the client-assertion
  replay markers `/oauth/token` creates for CIMD clients.
- **Library surface:** `ctx.props` on `apiHandler`, `beginConsent` →
  `{ handle, headers }`, `OAuthError(code, { description })` (description
  required), and plain-object handlers all confirmed against 1.2.3.
- **Challenge format:** the provider answers unauthenticated `/mcp` itself
  (`apiRoute` runs before `defaultHandler`) with
  `Bearer realm="OAuth", resource_metadata="…", scope="mail:read"`.

### Live acceptance (step 8)

Run against production on 2026-10-18, not locally: the owner skipped the
`wrangler dev` + tunnel rehearsal and validated the deployed Worker instead.

- [x] Discovery live on `https://icloud-mail.diegobit.com`: protected-resource
      and authorization-server metadata (correct issuer, S256 only, `iss`
      supported); anonymous `POST /mcp` → 401 challenge with
      `resource_metadata`; the bearer paths still answer 401 without a token
      and 200 with the current `API_TOKEN`.
- [x] ChatGPT (developer mode) connected through the sign-in and consent
      pages and calls the tools. Confirmed by the owner on 2026-10-18.
- [ ] claude.ai: not tried yet.
- [ ] Rotation rehearsal: skipped by the owner's choice; the current
      `API_TOKEN` stays in use, so no connector has been through the forced
      reconnect yet. Rotation remains the documented way to revoke them all.
- [ ] `npm run setup` rerun against a test Worker: pending. Until the
      Cloudflare Workers Builds deploy command changes to
      `npm run deploy:production` (DEPLOY.md), builds on `main` fail at the
      deploy step and production is updated with `npm run deploy:production`.
- [x] Allowlisting: nothing needed for ChatGPT.
