# Operations runbook

First-time setup (Apple app-specific password, wrangler login, secrets,
deploy, connecting agents) lives in the [README quick start](README.md#quick-start--deploy-with-your-own-icloud-account).
This file covers running the service after that.

## Rotation / incident response

- **Rotate the bearer token:** `openssl rand -base64 32` then
  `npx wrangler secret put API_TOKEN`, and update every client (MCP config,
  scripts, `~/.icloud-mail-token` or equivalent). The old token stops working
  the moment the secret is updated.
- **Revoke the Apple app-specific password:** at appleid.apple.com →
  Sign-In and Security → App-Specific Passwords, revoke the password used by
  this proxy, generate a new one, and run
  `npx wrangler secret put ICLOUD_APP_PASSWORD` again. Do this immediately if
  the Worker or its secrets may be compromised — this password grants more
  than read-only IMAP access (see `README.md`).

## CI / automated deploys

Two complementary pieces, neither of which needs a Cloudflare API token in
GitHub:

**Checks (GitHub Actions).** `.github/workflows/ci.yml` runs on every push
to `main` and `dev`, and on pull requests: `npm ci`, `npm run typecheck`,
`npm test`, then a `wrangler deploy --dry-run` (bundles the Worker without
needing any credentials). Checks only — it never deploys.

**Deploys (Cloudflare Workers Builds).** Deploys use Cloudflare's built-in
git integration, the same mechanism as a Pages project. One-time setup in
the Cloudflare dashboard:

1. Workers & Pages → **icloud-mail-proxy** → Settings → **Build** →
   Connect a repository (authorize GitHub if not already) → pick
   `diegobit/icloud-mail-proxy`.
2. Production branch: `main`.
3. Build command: `npm ci && npm run typecheck && npm test` — this gates
   the deploy on the same checks CI runs, entirely on Cloudflare's side.
4. Deploy command: `npx wrangler deploy`.

After that, every push to `main` builds and deploys automatically (the
dashboard's Deployments tab shows build logs); pushes to other branches can
optionally get non-production preview builds if enabled. Connecting the
integration does not deploy retroactively — trigger the first build with a
push to `main` or the "Retry build"/"Deploy" button in the dashboard.

This doesn't replace manual deploys — `npx wrangler deploy` still works from
your own machine — and automated deploys never touch Worker secrets
(`ICLOUD_USER`, `ICLOUD_APP_PASSWORD`, `API_TOKEN`): only `wrangler secret
put` changes those.

## Diagnostics

`npx wrangler tail` streams live request metadata (method, path, status,
timing). It never shows message content — the code doesn't log bodies,
headers, or credentials — but treat the metadata stream itself as sensitive
and don't leave it running unattended.

## Updating

```
npm run deploy
```

is equivalent to `wrangler deploy` and re-publishes the current code with
the existing secrets and config untouched.

To roll back a bad deploy, list and roll back to a previous Worker version:

```
npx wrangler versions list
npx wrangler versions deploy <version-id>
```
