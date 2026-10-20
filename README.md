# icloud-mail-proxy

An iCloud Mail proxy running as a Cloudflare Worker. It lets an agent read a
mailbox (list mailboxes, search, fetch a message) over HTTP or MCP without
running anything locally, keeping the Apple credentials on the Worker rather
than on whatever machine the agent runs on — and it can send mail: new
messages, replies and forwards, plus saving a message into the real Drafts
folder so it can be finished from any mail app. It can also file mail: archive
a message or move it to iCloud's trash, one message at a time.

One deployment serves one iCloud account and lives in its owner's Cloudflare
account. The examples in this README use the author's instance at
`https://icloud-mail.diegobit.com`; the quick start below deploys your own.

## Quick start — deploy with your own iCloud account

You need Node 22 or newer, a Cloudflare account (the free plan is enough), and
an Apple app-specific password.

1. **Create the app-specific password**: at [appleid.apple.com](https://appleid.apple.com)
   → Sign-In and Security → App-Specific Passwords, create one named e.g.
   `cf-mail-proxy`, and don't reuse it anywhere else. Your normal Apple
   password will not work — Apple requires an app-specific password for IMAP.
2. **Run the guided setup**:

   ```bash
   git clone <this repo> && cd icloud-mail-proxy
   npm ci
   npm run setup
   ```

Setup asks its way through the whole deployment: it logs you in to Cloudflare
through `wrangler login` (in your browser), picks the account and the Worker
name, takes your iCloud address and app-specific password, asks which folders
the proxy may read, generates the API bearer token, uploads the three secrets,
deploys to `<worker>.<your-subdomain>.workers.dev`, and verifies the live
endpoint over both REST and MCP. It prints the client snippets for Claude
Code, opencode and Codex CLI at the end, plus how to connect ChatGPT and
claude.ai over OAuth.

Four things worth knowing before you run it:

- **The API token is shown once.** Setup generates it and offers to print it
  so you can store it in a password manager. Cloudflare's API cannot return a
  secret's value. If you lose it, run `npm run setup` again and choose to
  rotate it — every client then needs the new value. The Apple app-specific
  password is never printed.
- **Folder names must match iCloud exactly**, spaces included. The default is
  `INBOX,Archive,Sent Messages`. Setup checks the first folder with a bounded
  search (one message, metadata only); verification fails until that folder
  can be read.
- **Ctrl-C is safe.** Run `npm run setup` again and it resumes with the same
  account, Worker and secrets, and only changes credentials or the token if
  you ask it to. Each run deploys the Worker again, then verifies.
- **The Apple password never touches the repository.** It goes to Wrangler on
  stdin, never as a command-line argument, and is not written to disk or
  printed. The API token is shown only if you ask to see it. `.deploy/`
  (gitignored) holds the generated wrangler config and a record of the
  account, Worker and folders you chose — no secrets.

Re-run setup to change folders, replace the Apple password, or rotate the
token. To deploy new code afterwards, `npm run deploy` reuses the same target.

## Let your agent walk you through it

If you'd rather not read the rest of this file, clone the repo, open your
coding agent (Claude Code, opencode, Codex, …) in it, and paste:

```text
Read README.md and DEPLOY.md, then help me deploy this iCloud mail proxy to my
own Cloudflare account. Do the parts you can: check my Node and wrangler
versions, run npm ci, and tell me exactly when to create the Apple
app-specific password. Then tell me to run `npm run setup` myself — it prompts
for a hidden password, so it needs my terminal, not yours. Afterwards, take
the endpoint it prints and set up the MCP config for the client I tell you.
Never ask me to paste credentials into the chat.
```

## Connect your agent

Any MCP client with Streamable HTTP and custom headers works. Keep the token
in an environment variable (`ICLOUD_MAIL_TOKEN` below) when the client can
reference it that way. Replace `<your-worker>` with the hostname setup printed.

**Claude Code** (single-quote the header so your shell does not expand the
token; if `$ICLOUD_MAIL_TOKEN` is expanded, this CLI may store the secret
itself rather than an environment-variable reference):

```bash
claude mcp add --transport http icloud-mail https://<your-worker>/mcp \
  --header 'Authorization: Bearer $ICLOUD_MAIL_TOKEN'
```

**opencode** — add to `~/.config/opencode/opencode.json` (or a project
`opencode.json`):

```json
{
  "mcp": {
    "icloud-mail": {
      "type": "remote",
      "url": "https://<your-worker>/mcp",
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
url = "https://<your-worker>/mcp"
bearer_token_env_var = "ICLOUD_MAIL_TOKEN"
```

**ChatGPT** (developer mode) and **claude.ai** connect through OAuth instead
of a header:

- ChatGPT: Settings → Connectors → add a custom connector with URL
  `https://<your-worker>/mcp` (under developer mode).
- claude.ai: Settings → Connectors → Add custom connector with the same URL.

The connector is sent to the Worker's sign-in page, which asks for the API
token once; after that it holds its own OAuth grant. OAuth covers `/mcp` only —
every REST call and the CLI clients above still use the bearer token.

REST works the same way:

```bash
curl -H "Authorization: Bearer $ICLOUD_MAIL_TOKEN" https://<your-worker>/v1/mailboxes
```

## Deploying without the guided setup

Setup does nothing you can't do by hand. Use the manual path for a custom
domain, a second deployment, or a deploy driven by CI.

1. **Describe the target.** Copy the `production` entry in
   `deploy-profiles.jsonc` and edit it: a Worker name, and either
   `"workers_dev": true` or a `routes` entry for a hostname on a zone your
   Cloudflare account owns (the DNS record and TLS certificate are created for
   you).

   ```jsonc
   {
     "mine": {
       "description": "my deployment",
       "name": "icloud-mail-proxy",
       "workers_dev": false,
       "routes": [{ "pattern": "mail-api.example.com", "custom_domain": true }]
     }
   }
   ```

   A profile states only what differs. The entry point, compatibility date,
   folder list and the size, result and look-back caps come from
   `wrangler.base.jsonc`, so there is one copy of them for every target.

2. **Upload the secrets.** `wrangler secret bulk` reads JSON on stdin, which
   keeps the values out of your shell history and out of `ps` output:

   ```bash
   npx wrangler login
   openssl rand -base64 32              # the API bearer token — save it now
   npx wrangler secret bulk --name icloud-mail-proxy
   # paste one line, then Ctrl-D:
   # {"ICLOUD_USER":"you@icloud.com","ICLOUD_APP_PASSWORD":"xxxx-xxxx-xxxx-xxxx","API_TOKEN":"…"}
   ```

   For a Worker that doesn't exist yet, Wrangler creates an empty one to hold
   the secrets. Until real code is deployed there is nothing to reach, and a
   deployment without `API_TOKEN` answers every request with HTTP 500 rather
   than serving mail.

3. **Deploy and check:**

   ```bash
   npm run deploy -- --profile mine
   curl -H "Authorization: Bearer $ICLOUD_MAIL_TOKEN" https://<your-hostname>/healthz
   ```

There is deliberately no `wrangler.jsonc` at the repository root: a bare
`wrangler deploy` therefore has no target and fails, instead of publishing to
whichever Worker happens to be named in a tracked file. Each deploy composes
`wrangler.base.jsonc` with exactly one selected target into
`.deploy/wrangler.<target>.jsonc`. `npm run deploy -- --config <path>` uses a
config you wrote yourself, and `npm run deploy -- --print-config` shows what
would be deployed without deploying it.

Operations — updates, reruns, token rotation, incident response, diagnostics,
rollback, automated deploys: [DEPLOY.md](DEPLOY.md).

## Architecture

```
Agent  --HTTPS (REST /v1 or MCP /mcp)-->  Cloudflare Worker  --IMAPS:993-->        imap.mail.me.com
       <-- JSON -----------------------                    <-- LOGIN/EXAMINE/SELECT/UID SEARCH/UID FETCH BODY.PEEK/APPEND/UID MOVE/LOGOUT --
                                                          --SMTP STARTTLS:587-->  smtp.mail.me.com
```

The Worker speaks a small, hand-rolled IMAP client (`src/imap.ts`) directly
over a TLS socket (`cloudflare:sockets`) to `imap.mail.me.com:993`. Reads only
ever issue `LOGIN`, `EXAMINE`, `UID SEARCH`, `UID FETCH` (always
`BODY.PEEK[...]`, never `BODY[...]`) and `LOGOUT`, so no command can mark a
message as read. Writes are narrow: `APPEND` saves a draft into the `Drafts`
mailbox (and, when `SEND_SENT_COPY` is enabled, a copy of a sent message into
`Sent Messages`), and a mutation issues a read-write `SELECT` followed by
`UID MOVE`, or by `UID COPY` + `\Deleted` + `UID EXPUNGE` when the server
advertises `UIDPLUS` but not `MOVE`. A mutation files exactly one message into
a fixed, configured destination. See [Filing and deleting](#filing-and-deleting).

Sending is a separate client (`src/smtp.ts`) to `smtp.mail.me.com:587`
(STARTTLS, `AUTH PLAIN`), reachable only through the `send_mail` tool. The
quota reservation, the duplicate-send window and the audit trail live in a
`SendLedger` Durable Object (`src/send-ledger.ts`), created by the first
deploy. See [Sending mail](#sending-mail).

The OAuth layer (`src/index.ts`, `src/oauth-authorize.ts`,
`src/oauth-pages.ts`) rides on `@cloudflare/workers-oauth-provider`: it serves
the `/.well-known/oauth-*` metadata, the authorization/consent pages, dynamic
client registration and the token endpoint, keeping grants in the `OAUTH_KV`
namespace (created by the first deploy). It wraps every request; REST and the
static bearer behave exactly as before. `npm run setup` verifies the discovery
endpoints and the anonymous `/mcp` challenge on each run.

## API

Every `/v1/*` and `/healthz` request requires `Authorization: Bearer $API_TOKEN`
(`/mcp` also accepts OAuth 2.1 access tokens; see [MCP](#mcp)).
Responses are sent with `Cache-Control: private, no-store`.

### Health

```
curl -H "Authorization: Bearer $API_TOKEN" https://icloud-mail.diegobit.com/healthz
```

```json
{ "ok": true, "imapLatencyMs": 412 }
```

Performs a real IMAP `LOGIN` followed immediately by `LOGOUT` — no `EXAMINE`,
nothing else — so a `200` means the Apple credentials and network path are
actually working end-to-end right now, not just that the Worker is up.
Status contract:

- `200` — `{ "ok": true, "imapLatencyMs": <number> }`
- `503` — `{ "ok": false, "error": { "code", "message" } }` when the IMAP
  server rejected the login or the connection failed
- `401` — missing/invalid bearer token (same auth gate as every other route)

Because each call opens a fresh IMAP connection, it's fine for typical
uptime-monitor cadences (e.g. every 1–5 minutes) but shouldn't be hammered
much faster than that.

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

### `POST /v1/messages/:mailbox/:uidValidity/:uid/archive` and `.../trash`

File one message into the account's archive or trash. There is no request body:
the destination is configured server-side, never taken from the caller (see
[Filing and deleting](#filing-and-deleting)).

```
curl -X POST -H "Authorization: Bearer $API_TOKEN" \
  "https://icloud-mail.diegobit.com/v1/messages/INBOX/1699999999/4821/archive"
```

```json
{ "ok": true, "action": "archive", "mailbox": "INBOX", "uid": 4821, "destination": "Archive" }
```

`trash` moves the message to `Deleted Messages`; it never deletes anything
permanently. `409 uidvalidity_mismatch` and `400 mailbox_not_allowed` mean the
same as on the read endpoints, and a uid that is no longer in the source
mailbox returns `404 message_not_found`, which makes the call safe to re-run.

### `GET /v1/messages/:mailbox/:uidValidity/:uid/attachments/:index`

Download one attachment's content. `index` is the 0-based position of the
attachment in the `attachments` array returned by the message endpoint above.
Both views (and search's `hasAttachments`) use one classification rule: a part
with disposition `attachment`, or any named part that isn't the text body,
counts; unnamed inline parts (e.g. newsletter images) are not attachments.

```
curl -H "Authorization: Bearer $API_TOKEN" \
  "https://icloud-mail.diegobit.com/v1/messages/INBOX/1699999999/4821/attachments/0" \
  -o invoice.pdf
```

Unlike the JSON endpoints, this returns the raw attachment bytes with status
`200`, `Content-Disposition: attachment; filename="..."` (the filename is
sanitized), and `X-Content-Type-Options: nosniff`. The `Content-Type` is the
attachment's own MIME type, except that any `text/*` attachment is served as
`text/plain` (never `text/html`) so mail content can never be served back as
executable HTML.

Downloads are gated by two `wrangler.base.jsonc` vars:

- `ALLOWED_ATTACHMENT_TYPES` — a comma-separated list of allowed MIME
  prefixes (default `application/pdf,image/,text/`). An entry ending in `/` is
  a type-prefix match (`image/` allows `image/png`); an entry without one must
  match the full type exactly. A disallowed type returns `415`
  `attachment_type_not_allowed`.
- `MAX_ATTACHMENT_BYTES` — the maximum encoded size of a single attachment
  (default `2097152`, 2 MiB). A larger attachment returns `413`
  `attachment_too_large`.

Other errors: `404 attachment_not_found` (no attachment at that index),
`404 message_not_found`, `409 uidvalidity_mismatch` (as above), and
`502 bodystructure_unparseable` / `502 attachment_undecodable` when the
server's message structure or transfer-encoding cannot be processed. The
attachment bytes are untrusted third-party content — treat them as
potentially hostile.

## MCP

A stateless Streamable HTTP MCP server is served at `/mcp`, exposing four read
tools that mirror the REST endpoints — `list_mailboxes`, `search_mail`,
`get_mail_message`, and `get_mail_attachment` (returns
`{ filename, mimeType, size, contentBase64 }`, base64 of the decoded content,
subject to the same type allowlist and size cap) — plus two filing tools,
`archive_mail` and `delete_mail`, and two sending tools: `send_mail` (a new
message, a reply or a forward, submitted immediately) and `save_draft` (the same
message put into iCloud's `Drafts` folder, to be finished from any mail app). A
fresh `McpServer` is built per request; no session state is held between calls.

`/mcp` accepts two credentials: the static bearer token (Claude Code, opencode,
Codex CLI, curl) and OAuth 2.1 access tokens issued by this Worker for
connectors that cannot send custom headers (ChatGPT developer mode, claude.ai).
The server publishes its OAuth metadata under `/.well-known/`; the consent flow
asks for the API token once per connector and binds the grant to it, and scopes
every grant to `mail:read`. Every authorization request must carry a PKCE
`S256` challenge: requests without one are refused before the consent page.

Connect from Claude Code (single-quote the header so the shell does not expand
the token; this CLI may store an expanded header value):

```
claude mcp add --transport http icloud-mail https://icloud-mail.diegobit.com/mcp --header 'Authorization: Bearer $API_TOKEN'
```

## Sending mail

Any authenticated client can send. Two tools do it:

- **`send_mail`** validates the recipients, builds the final RFC 5322 message
  and submits it over `smtp.mail.me.com:587` (STARTTLS, `AUTH PLAIN`) right
  away. It returns `{ status: "sent", messageId, recipients, replyCode }` or an
  error carrying a stable code.
- **`save_draft`** builds the same message and APPENDs it to iCloud's `Drafts`
  mailbox, where it shows up in Apple Mail and on the iPhone. Nothing is sent;
  finishing it later is a normal action in the mail client. A draft keeps its
  `Bcc:` header (there is no SMTP envelope to carry it), while a submission
  never has one.

Replies (`inReplyTo`) get `In-Reply-To`/`References` from the parent message;
forwards (`forwardOf`) quote its text and name the attachments they do not
carry. Messages are plain text only, no attachments, ASCII-only addresses.

Configuration: the caps live in `wrangler.base.jsonc` — `SEND_MAX_PER_DAY`
(default 20, **0 disables all sending**), `SEND_MAX_RCPTS_PER_DAY` (50),
`SEND_MAX_RCPTS_PER_MESSAGE` (5) and `SEND_MAX_BODY_BYTES` (64 KiB) — and are
clamped to hard maxima in `src/send-policy.ts`. Optional secrets: `SEND_FROM`
(default `ICLOUD_USER`; must be an address the account owns), `SEND_FROM_NAME`
and `SEND_SENT_COPY=1` to append a `\Seen` copy of each sent message to
`Sent Messages` (off by default; iCloud may already file SMTP submissions, in
which case leave it off to avoid a duplicate).

Failure semantics: a rejection before the message is accepted gives the quota
back and may be retried; **a connection lost after the final dot is reported as
"delivery state unknown"** — the quota and the duplicate claim stay, the tool
tells the model to check the recipient or `Sent`, and nothing is retried
automatically. The same message (same recipients, subject, body and parent)
submitted again within 60 seconds is refused as `duplicate_send` unless the
caller passes `allowDuplicate: true`: that is what keeps a client that retries
after a timeout from sending twice. Sends are logged as metadata only
(principal, recipient count and domains, SMTP code, duration), never content.

## Filing and deleting

Any authenticated client can file one message at a time: `archive_mail` and
`delete_mail` over MCP, or `POST /v1/messages/:mailbox/:uidValidity/:uid/archive`
and `.../trash` over REST. Both take the id from a search result
(`mailbox`, `uidValidity`, `uid`).

- **Two fixed destinations, chosen by configuration, never by the caller.**
  `archive_mail` files into `ALLOWED_ARCHIVE_MAILBOX` (default `Archive`) and
  `delete_mail` into `ALLOWED_TRASH_MAILBOX` (default `Deleted Messages`).
  Requests cannot name a mailbox, set flags, or create/delete folders.
- **`delete_mail` means trash, not expunge.** The message is moved into iCloud's
  trash, where it stays recoverable for Apple's retention window (about 30
  days). This proxy has no permanent-delete command: emptying the trash stays
  the owner's action in a mail client.
- **It files the message, and only that message.** The source mailbox must be
  in `ALLOWED_MAILBOXES`. The server uses `UID MOVE` (RFC 6851) when it
  advertises `MOVE`; otherwise it falls back to `UID COPY` + `\Deleted` + `UID
  EXPUNGE` when the server advertises `UIDPLUS`. If the server advertises
  neither, the call fails with `502 unsupported_move` rather than issuing a
  plain `EXPUNGE`, which would purge every `\Deleted` message in the mailbox.
  iCloud does not advertise `MOVE` (probed 2026-10-20), so the `UIDPLUS`
  fallback is the path in production.
- **Re-running after a success or a 404 is safe.** A uid that is no longer in
  the source mailbox returns `404 message_not_found`; an expired id returns
  `409 uidvalidity_mismatch` (re-run the search first). A connection that drops
  after the move has started is different: the call returns `502
  mutation_state_unknown` instead of retrying, because the COPY fallback is not
  atomic — the copy may already be in the destination while the source still
  holds the message, and a blind retry would file a second one. Check both
  mailboxes before acting.
- **Audit is live only.** Each mutation logs one structured `mail_mutation`
  line (principal, action, mailbox, uid, destination — no subject, no body) that
  `wrangler tail` shows. There is no durable mutation history; the `SEND_LEDGER`
  audit trail covers sends only.

Unlike sending, filing is reversible from a mail client: archive a message back
to the INBOX or restore it from the trash by hand.

## Security model

- **Reads are read-only; writes are narrow.** Reading sends `EXAMINE` (the
  read-only form of `SELECT`), `UID SEARCH`, `UID FETCH` with `BODY.PEEK[...]`
  (never `BODY[...]`, which would set `\Seen`), and `LOGOUT`. The only writes
  are `APPEND` (a draft into `Drafts`, or the optional sent copy) and the two
  mutations, which use `SELECT` and then `UID MOVE`, or `UID COPY` + `UID
  STORE` with exactly `\Deleted` + `UID EXPUNGE` on the same uid when only
  `UIDPLUS` is available. There is no bare `EXPUNGE`, no `STORE` of any other
  flag, no `CREATE`/`DELETE` of a mailbox, and no permanent delete. Nothing can
  mark a message read.
- **Sending is direct, by the owner's decision.** The agent sends; there is no
  approval step. An email whose content instructs the agent to send something
  can therefore produce a real message, bounded only by the caps above and
  visible in the audit trail. The tool description and the server instructions
  still say to send only when the user asked, and never because an email asked,
  but nothing enforces that. The app password itself — which Apple issues for
  full-account access, SMTP included — can send mail regardless of this code.
- **The Apple app-specific password is not read-only.** Nothing about the
  password itself restricts it to reading mail: it is an account credential.
  Use a password created specifically for this proxy (e.g. named
  `cf-mail-proxy` at appleid.apple.com), not one shared with anything else,
  and revoke it immediately at appleid.apple.com → Sign-In and Security →
  App-Specific Passwords if the Worker or its secrets are ever compromised.
- **Constant-time bearer verification.** Every REST and `/healthz` request
  requires `Authorization: Bearer $API_TOKEN`, and `/mcp` accepts either
  that bearer or an OAuth access token minted after verifying `API_TOKEN`.
  Both the presented token and `API_TOKEN` are SHA-256 hashed and compared
  with `crypto.subtle.timingSafeEqual` (`src/auth.ts`), so the comparison
  does not leak timing information about the secret.
- **OAuth grants are issued by the Worker itself.** For MCP connectors that
  cannot send a custom header, `/mcp` also accepts OAuth 2.1 access tokens:
  the sign-in and consent pages hand one out only after the owner enters
  `API_TOKEN`, the grant's scope is fixed to `mail:read`, and it reads exactly
  the folders the bearer reads. The static bearer itself is also accepted on
  `/mcp` as an external token — it is this deployment's own credential and is
  never forwarded upstream. There is no remember-consent: ChatGPT's CIMD
  `client_id` is shared by every ChatGPT user, and a remembered consent would
  make a crafted `/authorize` link approvable without the token. Grants are
  bound to the current `API_TOKEN`, so rotating it revokes every one of them —
  including a consent page left open across the rotation, which cannot be
  approved afterwards; grants minted before the PKCE requirement was
  introduced are refused the same way (see [DEPLOY.md](DEPLOY.md)). A grant
  can also send, like the bearer; the audit trail records which principal
  performed each send or draft save.
- **No caching, no content logging.** All responses set
  `Cache-Control: private, no-store`. Unexpected-error logging only ever
  includes an error message, never a request body or message content.
- **Message bodies are untrusted input.** `GET /v1/messages/...` and the
  `get_mail_message` MCP tool return the plain-text body under
  `untrustedEmailContent.text`. This is third-party content that can contain
  arbitrary text, including instructions crafted to look like they come from
  the user or the system. Agents consuming this proxy must not treat that
  text as instructions to act on — the MCP tool description and server
  instructions both call this out explicitly. An injected instruction can make
  the agent send real mail, archive a message, or move it to the trash; the
  send caps bound the volume, the mutation destinations are fixed, and the
  audit output shows what happened, but nothing else stands in the way (see
  [Sending mail](#sending-mail) and [Filing and deleting](#filing-and-deleting)).
- **Hard caps everywhere.** Only mailboxes in `ALLOWED_MAILBOXES` can be
  read, and a mutation can only move one uid into one of its two configured
  destinations; `MAX_RESULTS` caps how many summaries a search returns;
  `MAX_SEARCH_DAYS` caps how far back a search can look (an explicit `after`
  can only narrow this window, never widen it); `MAX_MESSAGE_BYTES` caps how
  many bytes of a message are ever fetched (larger messages are returned
  truncated, flagged with `truncated: true`, never in full).
  `ALLOWED_ATTACHMENT_TYPES` restricts which MIME types can be downloaded and
  `MAX_ATTACHMENT_BYTES` caps a single attachment's size. On the send side,
  `SEND_MAX_PER_DAY`, `SEND_MAX_RCPTS_PER_DAY`, `SEND_MAX_RCPTS_PER_MESSAGE`
  and `SEND_MAX_BODY_BYTES` cap sending and are clamped to hard maxima in
  `src/send-policy.ts`; a `0` daily cap refuses every send.
- **Attachment content is untrusted, and served defensively.** Attachment
  bytes are third-party content; the download endpoint sets
  `X-Content-Type-Options: nosniff`, sanitizes the `Content-Disposition`
  filename, and serves any `text/*` attachment as `text/plain` (never
  `text/html`) so the proxy can never be used to host an executable HTML/XSS
  payload from mail content.

## Local development

```
cp .dev.vars.example .dev.vars   # fill in ICLOUD_USER, ICLOUD_APP_PASSWORD, API_TOKEN
npm ci
npm run dev
```

`.dev.vars` is for `wrangler dev` only — deployed Workers read their secrets
from Cloudflare, and nothing in the setup or deploy path reads or writes this
file. `npm run dev` and the checks below work in a fresh clone, with no
Cloudflare account and no `npm run setup` state.

```
curl -H "Authorization: Bearer $API_TOKEN" http://localhost:8787/v1/mailboxes
```

```
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

`npm test` includes prompt-adapter tests that drive a real PTY. Those need
Python 3 and a POSIX pty (macOS or Linux). That is a development and CI
prerequisite only: `npm run setup` and deploying the Worker stay Node-only
and do not use Python.
