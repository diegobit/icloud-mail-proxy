# Guided deployment to the user's Cloudflare account

Status: implemented on `dev`; live `npm run setup` flow verified. Ready to merge after updating the Cloudflare Workers Builds deploy command (`npm run deploy:production`).

## Outcome and scope

A user with iCloud Mail and a Cloudflare account can clone the repository,
run `npm ci` and `npm run setup`, deploy their own Worker, and receive a
verified endpoint plus MCP connection instructions without editing files.
Each deployment serves one iCloud account and lives in its owner's Cloudflare
account. This is one implementation unit, with the steps below in dependency
order.

Keep the existing read-only REST/MCP behavior. Exclude SaaS accounts, billing,
Docker, additional email providers, OAuth, automatic folder discovery, and
automatic edits to users' agent configuration. Custom domains remain a
documented advanced operation; the guided path uses `workers.dev`.

## Current constraints

- `wrangler.jsonc` contains Diego's production hostname and shared limits.
- `Env` takes three deployment secrets and a configured mailbox allowlist.
- `/healthz` validates IMAP login; `/v1/mailboxes` returns configuration and
  does not prove that a folder exists upstream.
- Existing tests cover parsing and helpers, not setup or deployment.
- Cloudflare Workers Builds currently deploys using the tracked config.
  Changing that config without a migration could change production routing.

## Implementation

### 1. Separate deployment defaults from deployment identity

Create a portable tracked configuration with explicit `workers_dev: true`
and no personal route or account identifier. Generate a gitignored local
Wrangler configuration for the selected account, Worker name, and settings.
Derive shared runtime settings from the tracked configuration each time;
avoid two independently maintained copies of the limits and entry point.

Make setup and ordinary updates use the same selected configuration. Keep
local development and CI dry-run checks usable without local setup state.
Preserve Diego's existing production configuration as an explicitly selected
deployment profile and document the Workers Builds command migration before
switching defaults. Do not change the live deployment during implementation.

Completion: fresh-clone defaults contain no personal deployment target;
existing production has a documented explicit target; update commands cannot
silently fall back to a different Worker when local configuration is absent.

### 2. Implement the terminal setup flow

Add a Node 22 setup script and package command. Use argument-array subprocess
calls to the installed Wrangler, with inherited terminal access for browser
login and separate stdin pipes for secrets. Keep orchestration separate from
prompt and process adapters so failure paths can be tested without Cloudflare.

Flow:

1. Check Node, dependencies, and terminal availability. Explain how to resume
   after cancellation; noninteractive invocation exits with actionable help.
2. Inspect Wrangler authentication and log in if needed. If multiple accounts
   are available, select one and persist its ID in the local configuration.
3. Choose a Worker name, defaulting to `icloud-mail-proxy`. Detect an existing
   Worker before mutations. Resume only when the target is recognized or the
   user explicitly chooses to adopt that existing deployment.
4. Ask for iCloud email and a hidden app-specific password. Link Apple's
   instructions and explain that a regular Apple password is unsuitable.
5. Ask for allowed folders, defaulting to `INBOX,Archive,Sent Messages`.
   Trim entries, reject an empty list, and explain that names must match
   iCloud folders. Retain existing size and look-back defaults.
6. Generate a cryptographically random API token on first setup. Present the
   selected account, Worker, folders, and intended create/update operation
   before executing the deployment.
7. Upload the required secrets and deploy using the selected configuration.
   Report partial completion accurately and retain only nonsecret resume state.
8. Verify the deployed URL, then show connection instructions.

Secrets stay out of command arguments, logs, generated config, and persistent
setup state. Prefer Wrangler secret upload through JSON on stdin. Resolve and
test the new-Worker bootstrap sequence during implementation; an intermediate
deployment without `API_TOKEN` must remain closed through the existing auth
gate. A deployed Worker with failed verification is not setup success.

Completion: a first deployment and interrupted deployment can be completed
through the terminal without source edits or credentials appearing in logs.

### 3. Define reruns and verification

On rerun, preserve the selected target, settings, and existing remote secrets.
Wrangler cannot return existing secret values: check secret names to determine
presence, and request the existing API token in a hidden prompt when verification
needs it. Never regenerate it simply because the setup process lacks its value.
Offer credential replacement and token rotation only as explicit operations;
explain that rotation requires updating clients. A failed rotation/upload must
not be reported as successful.

Resolve the actual deployed `workers.dev` URL rather than inventing its account
subdomain. Handle accounts without a configured Workers subdomain with a precise
dashboard setup instruction and a resumable exit if Wrangler cannot establish it.

Verification uses bounded retries for endpoint propagation/network failures:

- Unauthenticated REST request returns 401.
- Authenticated `/healthz` returns 200 and `ok: true`.
- A minimal MCP initialization and tool listing succeeds with the same token.
- Distinguish Cloudflare authentication/deploy errors, HTTP authorization errors,
  and upstream IMAP failures. Surface only sanitized diagnostics; preserve
  uncertainty when the server cannot distinguish invalid credentials from other
  upstream failures.

Print the endpoint and client snippets with an environment-variable reference
instead of embedding the token. Offer a deliberate one-time terminal reveal of
a newly generated token so the user can store it in their password manager.
If that token is lost, explicit rotation is the recovery path. Never persist
the Apple password locally. Keep `.dev.vars` limited to development.

Completion: a no-change rerun preserves working clients; unsuccessful checks
produce a nonzero exit and an actionable resume instruction.

### 4. Document and validate the complete path

Update README with the guided quick start, prerequisites, folder limitation,
token handling, and connection examples. Keep manual deployment available.
Update DEPLOY.md for local configuration, production profile migration,
updates, reruns, rotation, and interrupted setup. Extend `.gitignore` for local
configuration/state. Any changed update script must retain a usable explicit
config path for Workers Builds and advanced deployments.

Add behavior tests using injected prompt/process/HTTP adapters for:

- First deployment and account selection; unrecognized existing Worker target.
- Reruns preserving secrets; missing token; explicit rotation.
- Cancellation and failures between secret upload, deploy, and verification.
- Secret redaction, stdin transport, and absence of secrets in persisted files.
- HTTP/MCP verification outcomes and bounded retries.
- Configuration selection preserving custom production routing.

Run the existing tests, typecheck, setup tests, and portable/profile bundle
dry-runs. Exercise one real fresh deployment and one rerun in a separately
named test Worker using owner-provided credentials when available. Check an
allowed folder with a bounded read-only search to verify the user journey;
record which live checks were performed. If credentials are unavailable,
report live acceptance as pending rather than treating mocks as proof.

Completion: all automated checks pass; live acceptance demonstrates a fresh
deploy, mailbox access, MCP connectivity, and a rerun without token rotation.

## Acceptance and estimate

Deliver setup scripts, portable/local/profile configuration handling, focused
tests, and revised deployment documentation. No live changes or credential
collection are part of planning.

Estimated implementation: 2–4 developer days, including rerun recovery and
configuration migration. Live acceptance depends on a Cloudflare account and
an iCloud app-specific password. The first implementation task is validating
Wrangler's bootstrap and account/subdomain discovery behavior; these determine
the exact subprocess sequence, not the user-facing contract above.

## Implementation status

Implemented. Orchestrator verified all automated checks (`npm test`,
typecheck, portable and production dry-runs). Owner verified `npm run setup`
against live Cloudflare authentication and existing Worker detection. Review
corrections applied (terminal ownership, verification fail-closed, HTTP
deadlines, Wrangler parse fail-closed, target-arg validation, string-aware
JSONC, IMAP `LIMIT` as a proxy size cap, docs).

### Delivered

- `wrangler.base.jsonc` (portable defaults, `workers_dev: true`, no account ID
  or route) replaces the tracked `wrangler.jsonc`; there is deliberately no
  `wrangler.jsonc`/`.toml` at the root, so a bare `wrangler deploy` fails
  instead of re-routing an existing Worker.
- `deploy-profiles.jsonc` holds `production` (the `icloud-mail.diegobit.com`
  custom domain, `workers_dev: false` — what wrangler already inferred from
  `routes`). Profiles and setup state are composed over the base config, so
  the limits and entry point exist once.
- `scripts/setup.mjs` + `scripts/lib/*.mjs`: orchestration separated from the
  prompt, process, HTTP and state adapters. `scripts/deploy.mjs` selects a
  target explicitly (`--profile`, `--config`, recorded setup state) and exits 2
  with instructions when none is given. Missing/empty/conflicting selectors
  fail before writes or subprocesses.
- One readline interface per question, closed (stdin paused) before Wrangler
  inherits the terminal. Real PTY tests cover EOF, Ctrl-C, secret non-echo,
  and child stdin handoff.
- `.deploy/` (gitignored): generated config plus nonsecret resume state;
  `writeState` refuses to persist a known secret value or a secret-looking key.
- 94 setup tests in `test/setup/` (193 total): first setup, account selection,
  unrecognized/adopted Worker, reruns preserving secrets, missing token
  (nonzero unverified exit), rotation, failure between upload and deploy with
  resume, cancellation, secret stdin transport and redaction, HTTP/MCP
  verification classes with `/healthz` 503 IMAP codes (LIMIT is a proxy size
  cap, not iCloud rate-limiting) and bounded per-attempt
  deadlines, first-folder search required for verified, fail-closed Wrangler
  parse, target-arg validation, string-aware JSONC, real prompt-adapter/PTY
  tests, and configuration selection preserving the production route.
- README quick start/manual path and DEPLOY.md (targets, production migration,
  updates, reruns, rotation, interrupted setup, CI) rewritten.

### Wrangler behavior validated against the installed 4.111.0

- `whoami --json` prints `{loggedIn, authType, email, accounts[{id,name}]}` and
  exits 1 when not authenticated.
- `secret list --name X --format json` prints `[{name,type}]` with no banner,
  and fails with `Worker "X" not found.` when the Worker does not exist — used
  as the existence probe and secret inventory (values are never readable).
  Malformed list output is an error, not an empty list.
- `secret bulk` with no file argument reads JSON from stdin; a missing Worker
  is created as an empty draft (confirm defaults to yes when stdin is a pipe),
  so secrets can be uploaded before the first real deploy. The auth gate keeps
  any intermediate state closed (`API_TOKEN` absent ⇒ HTTP 500).
- `WRANGLER_OUTPUT_FILE_PATH` makes wrangler append NDJSON entries;
  `{type:"deploy"}` carries `targets` (`<worker>.<subdomain>.workers.dev`, or
  rendered routes) and `{type:"command-failed"}` carries the error message.
  The deployed URL is read from there, never guessed. A successful deploy
  without a structured deploy entry is an error unless `--dry-run` was passed.
- Without a workers.dev subdomain, deploy prompts to register one and, if
  declined, errors with `https://dash.cloudflare.com/<account>/workers/onboarding`;
  setup classifies that and exits resumably with the dashboard instruction.
- A generated config in `.deploy/` deploys correctly with `main` rewritten to
  `../src/index.ts` (verified by dry-run).

### Live acceptance

Verified by owner with `npm run setup` against Wrangler 4.111.0:
authenticated Cloudflare account resolution (`whoami --json`), existing
`icloud-mail-proxy` Worker detection via `secret list`, and the
unrecognized-Worker adoption guard in a checkout without prior `.deploy/state.json`.

Remaining before merging to `main`:
- Change the Cloudflare Workers Builds deploy command from `npx wrangler deploy`
  to `npm run deploy:production` (see `DEPLOY.md`).
