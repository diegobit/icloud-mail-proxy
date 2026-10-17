# Operations runbook

First-time setup lives in the [README quick start](README.md#quick-start--deploy-with-your-own-icloud-account).
This file covers running a deployment after that: how a target is selected,
what an update or a re-run changes, how to rotate credentials, and how to
recover from an interrupted setup.

## Configuration and targets

Three pieces decide what a deploy does:

| Path | Tracked? | What it holds |
| --- | --- | --- |
| `wrangler.base.jsonc` | yes | Shared defaults: entry point, compatibility date, `workers_dev: true`, folder list and the size/result/look-back caps. No account ID, no routes. |
| `deploy-profiles.jsonc` | yes | Named targets whose routing has to survive a fresh clone — currently `production` (the `icloud-mail.diegobit.com` custom domain). |
| `.deploy/` | no (gitignored) | `state.json`: the account, Worker and folders `npm run setup` chose, plus how far the last run got. `wrangler.<target>.jsonc`: the composed config, rewritten on every deploy. |

Every deploy composes the base defaults with exactly one target, so the limits
exist in one place. Selection is always explicit:

```
npm run deploy                          # the target npm run setup recorded
npm run deploy -- --profile production  # a tracked profile
npm run deploy -- --config <path>       # a config you wrote yourself
npm run deploy -- --print-config        # compose it, deploy nothing
npm run deploy -- --dry-run             # bundle and check, deploy nothing
```

With no setup state and no profile, `npm run deploy` exits 2 and deploys
nothing. There is no `wrangler.jsonc` at the repository root either, so a bare
`npx wrangler deploy` fails instead of publishing the portable defaults over
whatever Worker it finds. Anything unrecognized on the command line is passed
through to `wrangler deploy`.

Two bindings and one optional var come with the OAuth layer:

- `OAUTH_KV` — the KV namespace that holds grants. The config tracks it
  **without an id**, and Wrangler auto-provisions the namespace on the first
  real deploy (the dry-runs succeed without an account).
- `OAUTH_REGISTER_LIMITER` and `OAUTH_TOKEN_LIMITER` — the per-IP rate limits
  on `/oauth/register` (5/min) and `/oauth/token` (30/min), the two endpoints
  that are reachable without a token and write to `OAUTH_KV`. Their
  `namespace_id`s are account-wide: two deployments share the counters, which
  is harmless but means a busy second Worker can make the first one stricter.
- `PUBLIC_ORIGIN` (optional var) — set it only when a tunnel or proxy makes
  `request.url` disagree with the origin clients actually use (e.g. `wrangler
  dev` behind `cloudflared`). It must be a bare origin: `https`, or `http` on
  loopback. Normal deployments never need it.

## Migrating the production deployment

The tracked config no longer carries the `icloud-mail.diegobit.com` route: it
moved into the `production` profile. **Change the Cloudflare Workers Builds
deploy command before this reaches `main`**, or the next automatic build will
run a `wrangler deploy` that finds no config and fails.

In the dashboard: Workers & Pages → **icloud-mail-proxy** → Settings →
**Build** → Deploy command:

```
npx wrangler deploy          →     npm run deploy:production
```

Build command stays `npm ci && npm run typecheck && npm test`. Nothing about
the deployed Worker changes: `npm run deploy:production` composes the same
name, the same custom domain, and the same vars, and `workers_dev: false` in
the profile states what Wrangler already inferred from the presence of a
route. Verify before merging with:

```
npm run deploy:production -- --dry-run   # bundles, uploads nothing
npm run config -- --profile production   # prints the composed config path
```

Local and CI checks need none of this: `npm run dev`, `npm test`,
`npm run typecheck` and `npm run check:bundle` all work in a fresh clone.

## Updating

```
npm run deploy                  # your own deployment
npm run deploy:production       # the custom-domain deployment
```

Both re-publish the current code against the existing secrets and config. A
deploy never changes a secret — only `wrangler secret bulk`/`secret put` and
`npm run setup` do.

To roll back, list the versions and deploy an earlier one:

```
npx wrangler versions list --name <worker>
npx wrangler versions deploy --name <worker> <version-id>
```

Without a wrangler config at the repository root, these commands need the
Worker named explicitly — `--name <worker>`, or
`-c .deploy/wrangler.local.jsonc` to reuse the composed config.

## Re-running setup

`npm run setup` is safe to run again and is the way to change folders, replace
the Apple credentials, or rotate the token. A re-run:

- keeps the account, Worker name and folders from last time as the defaults;
- keeps every secret already stored in the Worker unless you explicitly ask to
  replace the credentials or rotate the token;
- asks before adopting a Worker it doesn't recognize, so a name typo cannot
  overwrite an unrelated deployment;
- re-deploys the current code, then re-verifies the endpoint, and exits
  non-zero if a check fails. A rerun is never a verification-only retry.

Cloudflare's API cannot return a secret's value, so setup works from secret *names*: it
can tell that `API_TOKEN` exists but not what it is. When verification needs
the current token and the run didn't generate one, setup asks you to paste it
(hidden input). Leave the prompt empty and it deploys, reports the endpoint as
unverified (nonzero exit), and tells you how to check it by hand — it will not silently
generate a new token, because that would break every existing client.

## Rotation and incident response

- **Rotate the bearer token:** `npm run setup`, answer yes to the rotation
  prompt, and store the new value when it is shown. The old token stops
  working the moment the new secret is uploaded, so update every client (MCP
  config, scripts, whatever holds `ICLOUD_MAIL_TOKEN`). By hand:
  `openssl rand -base64 32`, then
  `npx wrangler secret put API_TOKEN --name <worker>`. A hand-set token must
  have no spaces or commas inside it and must not look like the provider's
  grant tokens (`user:grantId:secret`): `/mcp` parses the bearer with the MCP
  library's stricter rules, so such a value would still work on `/v1/*` and
  `/healthz` but be rejected on `/mcp`. `openssl rand -base64 32` satisfies
  both constraints.
  A failed upload is reported as a failure, but that does not prove the old
  token is unchanged: Cloudflare may have applied the new secret before the
  connection dropped. Inspect `npx wrangler secret list --name <worker>`, then
  paste the token you believe is current or rotate again. Don't treat a
  non-zero exit as a completed rotation, and don't treat it as a no-op either.
- **OAuth connectors stop with it:** every grant is bound to the current
  `API_TOKEN`, so a rotation revokes all of them at once. ChatGPT and claude.ai
  fail their next token refresh with `invalid_grant` and must reconnect through
  the sign-in page (which asks for the new token). That is also the supported
  way to revoke a connector's access without touching the others beyond one
  reconnect.
- **Replace the Apple app-specific password:** revoke it at appleid.apple.com
  → Sign-In and Security → App-Specific Passwords, create a new one, then run
  `npm run setup` and answer yes to replacing the credentials. Do this
  immediately if the Worker or its secrets may be compromised — this password
  grants more than read-only IMAP access (see `README.md`).
- **Lost token, nothing else wrong:** rotation is the only recovery path.
  Cloudflare's API cannot return a secret's value; nothing on your machine
  keeps a copy.

## Recovering an interrupted setup

Setup records its progress in `.deploy/state.json` (nonsecret: account ID,
Worker name, folders, timestamps) before it changes anything in Cloudflare.
Run `npm run setup` again and it continues from there.

| Where it stopped | What exists | What the re-run does |
| --- | --- | --- |
| Before the confirmation | nothing | Asks again; Cloudflare was never touched. |
| Secrets uploaded, deploy failed | a Worker holding the secrets, no code (or the previous code) | Recognizes the Worker as yours, keeps the secrets unless you replace them, deploys again, then verifies. |
| Deployed, verification failed | a live Worker | Keeps secrets, deploys again, then re-runs the checks, and prints a hint for the specific failure. |
| Deployed, token unknown | a live Worker | Deploys, reports "not verified", and exits nonzero until you paste the token or rotate it. |

The failure hint distinguishes the three worlds that look alike from the
terminal: a Cloudflare error (login, deploy), an HTTP authorization error (the
token doesn't match), and an upstream IMAP failure (`/healthz` returns 503 with
`ok: false` and an IMAP `error.code` of `NO`, `BAD`, `BYE`, `TIMEOUT`,
`PARSE`, or `LIMIT`).
For IMAP `NO`/`BAD`/`BYE`/`PARSE` the message keeps the uncertainty — iCloud
reports a failed login the same way whether the app-specific password is wrong,
revoked, or the server is having a bad day. A `TIMEOUT` is not a reason to
rotate the password.

If a run leaves a Worker you don't want, delete it with
`npx wrangler delete <worker>` and remove `.deploy/state.json`.

## CI / automated deploys

Two complementary pieces, neither of which needs a Cloudflare API token in
GitHub:

**Checks (GitHub Actions).** `.github/workflows/ci.yml` runs on every push to
`main` and `dev`, and on pull requests: `npm ci`, `npm run typecheck`,
`npm test`, then two credential-free bundle checks — `npm run check:bundle`
(the portable defaults a fresh clone gets) and
`npm run deploy:production -- --dry-run` (the tracked production profile).
Checks only; it never deploys. Both dry-runs also cover the id-less `OAUTH_KV`
binding; Workers Builds provisions the namespace on the first real build.

Deleting a Worker does not delete its KV namespace: tear it down with
`npx wrangler kv namespace delete` if you are removing a deployment for good.

**Deploys (Cloudflare Workers Builds).** Deploys use Cloudflare's built-in git
integration. One-time setup in the dashboard:

1. Workers & Pages → **icloud-mail-proxy** → Settings → **Build** → Connect a
   repository (authorize GitHub if not already) → pick
   `diegobit/icloud-mail-proxy`.
2. Production branch: `main`.
3. Build command: `npm ci && npm run typecheck && npm test` — this gates the
   deploy on the same checks CI runs, entirely on Cloudflare's side.
4. Deploy command: `npm run deploy:production`.

After that, every push to `main` builds and deploys automatically (the
dashboard's Deployments tab shows build logs). Connecting the integration does
not deploy retroactively — trigger the first build with a push to `main` or
the "Retry build"/"Deploy" button.

This doesn't replace manual deploys, and automated deploys never touch Worker
secrets (`ICLOUD_USER`, `ICLOUD_APP_PASSWORD`, `API_TOKEN`).

## Diagnostics

`npx wrangler tail <worker>` streams live request metadata (method, path,
status, timing). It never shows message content — the code doesn't log
bodies, headers, or credentials — but treat the metadata stream itself as
sensitive and don't leave it running unattended.

`curl -H "Authorization: Bearer $ICLOUD_MAIL_TOKEN" https://<worker>/healthz`
returns `{ "ok": true, "imapLatencyMs": … }` when the Worker can log in to
iCloud. Without the header it must answer HTTP 401. A missing `API_TOKEN`
secret is a closed Worker: HTTP 500 `not_configured`, not an open endpoint.
Upstream IMAP failures are HTTP 503 with `{ "ok": false, "error": { "code", "message" } }`.

OAuth grants live in `OAUTH_KV`, which is eventually consistent across
Cloudflare locations: an access token issued at one location can be unknown at
another for up to ~60 seconds. If a connector reports an auth error right
after signing in, retry before debugging. The discovery endpoints are the
other quick probe: `curl https://<worker>/.well-known/oauth-protected-resource/mcp`
and `curl https://<worker>/.well-known/oauth-authorization-server` must both
answer 200 JSON without a token.
