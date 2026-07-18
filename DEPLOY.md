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
