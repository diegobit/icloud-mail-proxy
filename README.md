# icloud-mail-proxy

A read-only iCloud Mail proxy running as a Cloudflare Worker at
`https://icloud-mail.diegobit.com`. It lets an agent read a mailbox (list
mailboxes, search, fetch a message) over HTTP or MCP without running anything
locally, keeping the Apple credentials on the Worker rather than on whatever
machine the agent runs on.

## Lazy start — let your agent deploy it for you

Clone the repo, open your coding agent (Claude Code, opencode, Codex, …) in
it, and paste:

```text
Read README.md and DEPLOY.md, then deploy this iCloud mail proxy for me with
my own Apple account and Cloudflare zone. Do everything you can yourself:
ask me which hostname to use and edit wrangler.jsonc accordingly, run
npm install, generate the API_TOKEN, deploy, and verify the live endpoints.
Leave to me only the steps that need my credentials — creating the Apple
app-specific password, running `npx wrangler login`, and entering the
ICLOUD_USER / ICLOUD_APP_PASSWORD secrets — and tell me exactly when and
how to do each one. Never ask me to paste credentials into the chat.
When it works, give me the MCP config for the agent client I tell you.
```

The manual version of the same steps follows.

## Quick start — deploy with your own iCloud account

```bash
git clone <this repo> && cd icloud-mail-proxy
npm install
```

1. **Apple app-specific password**: at [appleid.apple.com](https://appleid.apple.com)
   → Sign-In and Security → App-Specific Passwords, create one named e.g.
   `cf-mail-proxy` (don't reuse it anywhere else).
2. **Pick your hostname**: edit the `routes` entry in `wrangler.jsonc` to a
   hostname on a zone your Cloudflare account owns, e.g.
   `mail-api.yourdomain.com`. No domain on Cloudflare? Delete the `routes`
   block entirely and the Worker deploys to
   `icloud-mail-proxy.<your-subdomain>.workers.dev` instead.
3. **Authenticate and set secrets**:

   ```bash
   npx wrangler login
   npx wrangler secret put ICLOUD_USER            # full iCloud address, e.g. you@icloud.com
   npx wrangler secret put ICLOUD_APP_PASSWORD    # the password from step 1
   openssl rand -base64 32                        # generate the API bearer token, keep it
   npx wrangler secret put API_TOKEN              # paste the generated token
   ```

4. **Deploy and verify** (DNS record and TLS cert are created automatically):

   ```bash
   npx wrangler deploy
   curl -H "Authorization: Bearer $API_TOKEN" https://<your-hostname>/v1/mailboxes
   ```

5. **Connect your agent** — any MCP client with Streamable HTTP + headers
   works. In the examples below, `ICLOUD_MAIL_TOKEN` is an environment
   variable holding the token from step 3.

   **Claude Code**:

   ```bash
   claude mcp add --transport http icloud-mail https://<your-hostname>/mcp \
     --header "Authorization: Bearer $ICLOUD_MAIL_TOKEN"
   ```

   **opencode** — add to `~/.config/opencode/opencode.json` (or a project
   `opencode.json`):

   ```json
   {
     "mcp": {
       "icloud-mail": {
         "type": "remote",
         "url": "https://<your-hostname>/mcp",
         "enabled": true,
         "oauth": false,
         "headers": { "Authorization": "Bearer {env:ICLOUD_MAIL_TOKEN}" }
       }
     }
   }
   ```

   **Codex CLI** — add to `~/.codex/config.toml`:

   ```toml
   [mcp_servers.icloud_mail]
   url = "https://<your-hostname>/mcp"
   bearer_token_env_var = "ICLOUD_MAIL_TOKEN"
   ```

Optional: adjust `ALLOWED_MAILBOXES` and the size/result/look-back caps in
`wrangler.jsonc` `vars`. Operations (token rotation, incident response,
diagnostics, rollback): [DEPLOY.md](DEPLOY.md).

## Architecture

```
Agent  --HTTPS (REST /v1 or MCP /mcp)-->  Cloudflare Worker  --IMAPS:993-->  imap.mail.me.com
       <-- JSON -----------------------                      <-- LOGIN/EXAMINE/UID SEARCH/UID FETCH BODY.PEEK/LOGOUT --
```

The Worker speaks a small, hand-rolled IMAP client (`src/imap.ts`) directly
over a TLS socket (`cloudflare:sockets`) to `imap.mail.me.com:993`. It only
ever issues `LOGIN`, `EXAMINE`, `UID SEARCH`, `UID FETCH` (always
`BODY.PEEK[...]`, never `BODY[...]`), and `LOGOUT` — there is no command that
can mark a message as read, and no SMTP code anywhere in the project.

## API

Every request (REST and MCP) requires `Authorization: Bearer $API_TOKEN`.
Responses are sent with `Cache-Control: private, no-store`.

### `GET /v1/mailboxes`

```
curl -H "Authorization: Bearer $API_TOKEN" \
  https://icloud-mail.diegobit.com/v1/mailboxes
```

```json
{ "mailboxes": ["INBOX", "Archive", "Sent Messages"] }
```

### `POST /v1/search`

Search terms are sent in the POST body rather than the URL, so they never end
up in server access logs or browser/proxy history.

```
curl -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mailbox":"INBOX","after":"2026-06-01","from":"billing@","limit":10}' \
  https://icloud-mail.diegobit.com/v1/search
```

```json
{
  "mailbox": "INBOX",
  "uidValidity": 1699999999,
  "total": 3,
  "messages": [
    {
      "mailbox": "INBOX",
      "uidValidity": 1699999999,
      "uid": 4821,
      "date": "2026-06-14T09:12:00.000Z",
      "from": [{ "name": "Billing", "address": "billing@example.com" }],
      "to": [{ "name": null, "address": "you@icloud.com" }],
      "subject": "Your invoice",
      "size": 18422,
      "seen": true,
      "flagged": false,
      "answered": false,
      "hasAttachments": true
    }
  ],
  "nextBeforeUid": 4700
}
```

`mailbox`, `after`/`before` (`YYYY-MM-DD`), `from`, `subject`, `text`,
`limit`, and `unseen` are the only accepted fields (unknown keys are
rejected). `from` / `subject` / `text` are ASCII-only IMAP substring filters —
non-ASCII search terms are rejected with `invalid_criteria`. `unseen: true`
restricts results to unread messages; each summary also carries `seen` /
`flagged` / `answered` booleans reflecting the message's IMAP flags at search
time, and a `hasAttachments` boolean derived from the message's
`BODYSTRUCTURE` (false when there are none or the structure can't be parsed).
A message's identity is the
composite `(mailbox, uidValidity, uid)`; `uid` alone is only meaningful
together with the `uidValidity` it was returned with.

Results are newest-first and paged with a `beforeUid` cursor. Each response
carries `nextBeforeUid`: the lowest `uid` on the page when older matches
remain, or `null` at the end. To fetch the next (older) page, repeat the
search with the same filters plus `"beforeUid": <that value>`. `total` counts
all matches in the date window (before the `beforeUid` cursor is applied), so
it stays stable across pages rather than shrinking as you page.

### `GET /v1/messages/:mailbox/:uidValidity/:uid`

```
curl -H "Authorization: Bearer $API_TOKEN" \
  "https://icloud-mail.diegobit.com/v1/messages/INBOX/1699999999/4821"
```

```json
{
  "id": { "mailbox": "INBOX", "uidValidity": 1699999999, "uid": 4821 },
  "date": "2026-06-14T09:12:00.000Z",
  "from": [{ "name": "Billing", "address": "billing@example.com" }],
  "to": [{ "name": null, "address": "you@icloud.com" }],
  "cc": [],
  "subject": "Your invoice",
  "messageId": "<abc123@example.com>",
  "untrustedEmailContent": { "text": "Thanks for your payment...", "textSource": "text" },
  "attachments": [
    { "index": 0, "filename": "invoice.pdf", "mimeType": "application/pdf", "size": 20480 }
  ],
  "truncated": false
}
```

Messages larger than `MAX_MESSAGE_BYTES` are not refused: only their first
`MAX_MESSAGE_BYTES` bytes are fetched and parsed, and the response sets
`"truncated": true`. Body text and attachment metadata may then be incomplete.

`untrustedEmailContent.textSource` records where the body text came from:
`"text"` (the message's own plain-text part), `"html"` (derived from the HTML
part when there is no plain-text part), or `null` (no body text). Raw HTML is
never returned.

If the mailbox's `UIDVALIDITY` has changed since the `uid` was obtained (the
mailbox was reset or reorganized server-side), this returns `409` with code
`uidvalidity_mismatch`. Treat this as "the id is stale": re-run `/v1/search`
to get fresh `(uidValidity, uid)` pairs before retrying.

## MCP

A stateless Streamable HTTP MCP server is served at `/mcp`, exposing three
tools that mirror the REST endpoints: `list_mailboxes`, `search_mail`, and
`get_mail_message`. A fresh `McpServer` is built per request; no session state
is held between calls.

Connect from Claude Code:

```
claude mcp add --transport http icloud-mail https://icloud-mail.diegobit.com/mcp --header "Authorization: Bearer $API_TOKEN"
```

## Security model

- **Read-only by construction.** The IMAP client only ever sends `LOGIN`,
  `EXAMINE` (the read-only form of `SELECT`), `UID SEARCH`, `UID FETCH`
  with `BODY.PEEK[...]` (never `BODY[...]`, which would set `\Seen`), and
  `LOGOUT`. There is no SMTP code anywhere in this project — the proxy
  cannot send mail.
- **The Apple app-specific password is not read-only.** Apple issues
  app-specific passwords for full account access, including SMTP; nothing
  about the password itself restricts it to read-only IMAP. The safety here
  comes entirely from this codebase never issuing a write/send command.
  Use a password created specifically for this proxy (e.g. named
  `cf-mail-proxy` at appleid.apple.com), not one shared with anything else,
  and revoke it immediately at appleid.apple.com → Sign-In and Security →
  App-Specific Passwords if the Worker or its secrets are ever compromised.
- **Bearer auth on every request.** Both the presented token and
  `API_TOKEN` are SHA-256 hashed and compared with
  `crypto.subtle.timingSafeEqual` (`src/index.ts`), so the comparison does
  not leak timing information about the secret.
- **No caching, no content logging.** All responses set
  `Cache-Control: private, no-store`. Unexpected-error logging only ever
  includes an error message, never a request body or message content.
- **Message bodies are untrusted input.** `GET /v1/messages/...` and the
  `get_mail_message` MCP tool return the plain-text body under
  `untrustedEmailContent.text`. This is third-party content that can contain
  arbitrary text, including instructions crafted to look like they come from
  the user or the system. Agents consuming this proxy must not treat that
  text as instructions to act on — the MCP tool description and server
  instructions both call this out explicitly.
- **Hard caps everywhere.** Only mailboxes in `ALLOWED_MAILBOXES` can be
  read; `MAX_RESULTS` caps how many summaries a search returns;
  `MAX_SEARCH_DAYS` caps how far back a search can look (an explicit `after`
  can only narrow this window, never widen it); `MAX_MESSAGE_BYTES` caps how
  many bytes of a message are ever fetched (larger messages are returned
  truncated, flagged with `truncated: true`, never in full). Attachments are only ever
  described (filename, MIME type, size) — attachment content is never
  fetched or returned.

## Local development

```
cp .dev.vars.example .dev.vars   # fill in ICLOUD_USER, ICLOUD_APP_PASSWORD, API_TOKEN
npm install
npm run dev
```

```
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8787/v1/mailboxes
```

```
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

## Limitations

- Search terms (`from`, `subject`, `text`) must be printable ASCII; non-ASCII
  input is rejected rather than silently mangled.
- Only the plain-text body is returned; HTML bodies are never surfaced.
- Attachments are metadata only (filename, MIME type, size) — content is
  never fetched.
- Pagination is newest-first only: `search_mail` returns one page plus a
  `nextBeforeUid` cursor for older results, but there is no forward/newer
  cursor and no random access into the middle of the result set.
- Each request opens its own IMAP connection to `imap.mail.me.com:993` and
  logs out at the end; there is no persistent/pooled connection across
  requests.
