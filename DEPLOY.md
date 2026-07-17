# Deploy runbook

## 1. Prerequisites

- A Cloudflare account that owns the `diegobit.com` zone (the Worker's route,
  `icloud-mail.diegobit.com`, is provisioned as a custom domain on that zone).
- Node.js 20+.
- An Apple ID with iCloud Mail enabled.

## 2. Create an Apple app-specific password

At [appleid.apple.com](https://appleid.apple.com) → **Sign-In and Security**
→ **App-Specific Passwords**, generate a new password and name it something
that identifies this proxy specifically, e.g. `cf-mail-proxy`. Do not reuse a
password shared with any other app — see the security note in `README.md`
about why this password is not itself read-only.

## 3. Authenticate wrangler

```
npx wrangler login
```

## 4. Set secrets

```
npx wrangler secret put ICLOUD_USER            # full iCloud email address
npx wrangler secret put ICLOUD_APP_PASSWORD    # the password from step 2
```

Generate the bearer token, then set it too:

```
openssl rand -base64 32
npx wrangler secret put API_TOKEN
```

## 5. Deploy

```
npx wrangler deploy
```

The custom domain (`icloud-mail.diegobit.com`), its DNS record, and the TLS
certificate are all created automatically from the `routes` entry in
`wrangler.jsonc` — no manual DNS steps are needed as long as the account owns
the `diegobit.com` zone.

## 6. Verify

```
API_TOKEN=<the value you generated>

# Expect the mailbox allowlist from wrangler.jsonc
curl -H "Authorization: Bearer $API_TOKEN" \
  https://icloud-mail.diegobit.com/v1/mailboxes

# Expect 401 unauthorized
curl -i https://icloud-mail.diegobit.com/v1/mailboxes

# Expect a search result
curl -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mailbox":"INBOX","limit":5}' \
  https://icloud-mail.diegobit.com/v1/search
```

Connect an MCP client:

```
claude mcp add --transport http icloud-mail https://icloud-mail.diegobit.com/mcp --header "Authorization: Bearer $API_TOKEN"
```

## 7. Rotation / incident response

- **Rotate the bearer token:** `openssl rand -base64 32` then
  `npx wrangler secret put API_TOKEN`, and update every client (MCP config,
  scripts). The old token stops working the moment the secret is updated.
- **Revoke the Apple app-specific password:** at appleid.apple.com →
  Sign-In and Security → App-Specific Passwords, revoke the password used by
  this proxy, generate a new one, and run
  `npx wrangler secret put ICLOUD_APP_PASSWORD` again. Do this immediately if
  the Worker or its secrets may be compromised — this password grants more
  than read-only IMAP access (see `README.md`).
- **Live diagnostics:** `npx wrangler tail` streams live request metadata
  (method, path, status, timing). It never shows message content — the code
  doesn't log bodies, headers, or credentials — but treat the metadata
  stream itself as sensitive and don't leave it running unattended.

## 8. Updating

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
