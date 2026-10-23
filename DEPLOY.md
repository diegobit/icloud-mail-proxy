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
| `.deploy/` | no (gitignored) | `state.json`: the account, Worker, folders and calendar allowlist `npm run setup` chose, plus how far the last run got. `wrangler.<target>.jsonc`: the composed config, rewritten on every deploy. |

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

The send path adds one binding and a set of caps:

- `SEND_LEDGER` — the Durable Object that holds the UTC quota counters, the
  60-second duplicate-send window and the audit trail. The first deploy creates
  it from the `migrations` entry in `wrangler.base.jsonc`. Its storage is part
  of the Worker's; audit rows prune after 90 days.
- `SEND_MAX_PER_DAY`, `SEND_MAX_RCPTS_PER_DAY`, `SEND_MAX_RCPTS_PER_MESSAGE`,
  `SEND_MAX_BODY_BYTES` — base vars, clamped to hard maxima in
  `src/send-policy.ts`; `SEND_MAX_PER_DAY=0` is the kill switch. Details in
  README's "Sending mail".
- Optional secrets: `SEND_FROM` (an address the account owns),
  `SEND_FROM_NAME` and `SEND_SENT_COPY=1` (append a copy to `Sent Messages`).
- **Test-only:** `SMTP_HOST`/`SMTP_PORT` are honoured only for the literal
  `127.0.0.1` or `localhost`, and only then is TLS skipped. Any other value is
  ignored in favour of `smtp.mail.me.com:587` with mandatory STARTTLS, so a
  stray binding cannot redirect production mail or downgrade it.

Filing mail adds two base vars, both destinations and never request input:

- `ALLOWED_ARCHIVE_MAILBOX` (default `Archive`) — where `archive_mail` and
  `POST .../archive` file a message. Point it at the same folder Apple Mail's
  Archive button uses, or the account ends up with two archives.
- `ALLOWED_TRASH_MAILBOX` (default `Deleted Messages`) — where `delete_mail`
  and `POST .../trash` move a message. **Confirm the exact name first**, spaces
  included: from a mail client, ask the server for its trash
  (`LIST "" "Deleted*"`, or look at the folder Apple Mail moves deleted mail
  into). If the account uses a different name, set it here and deploy.
  Probed on a live account on 2026-10-20: the mailbox is exactly
  `Deleted Messages` and carries the `\Trash` flag; `Archive` exists under that
  name but has no special-use flag, so it must stay configured by name.
- Neither folder needs to be in `ALLOWED_MAILBOXES` (the trash is normally not
  readable through this proxy), and a destination equal to the source mailbox
  is refused at runtime.
- `restore_mail` and `POST .../restore` add no configuration: they always move a
  message back into `INBOX`, and accept only one of those two folders as the
  source. Finding the uid of a *trashed* message therefore needs
  `Deleted Messages` in `ALLOWED_MAILBOXES` (which makes the trash readable);
  the archive is searchable by default.

### Calendars (opt-in)

The tracked default disables calendars. An empty or absent `ALLOWED_CALENDARS`
means no tools, no REST routes and no OAuth scopes for the domain. One
allowlist value controls what is reachable:

- `ALLOWED_CALENDARS` — comma-separated display names, exactly as iCloud
  reports them, matched case-sensitively. `*` means every calendar that passes
  discovery, including shared ones and ones created later. `*` must be alone: a
  mixed value such as `*,Work` is a configuration error, not a superset. A
  configured name that matches nothing fails closed
  (`configured_calendar_missing`); two calendars with the same name return
  `409 ambiguous_calendar_name`. Renaming a calendar in Apple Calendar breaks a
  config that names it: update the allowlist and redeploy.
- `CALENDAR_WRITE` — `"1"` or `"0"`, default `0`. Writes require both a
  non-empty allowlist and the flag; with the flag at `0`, the write tools are
  not registered and the REST write routes answer `404 not_supported`. The
  tracked `production` profile opts in to `*` with writes enabled; a fresh
  deployment does not.
- The write flag enables two separate OAuth scopes: `calendar:write` for
  create/update and `calendar:delete` for deletion. `calendar:delete` implies
  `calendar:read`, but `calendar:write` does not imply `calendar:delete`. This
  keeps a connector that approved write before deletion existed from gaining
  irreversible deletion without a fresh consent.

To discover the exact names before enabling the domain, call the bearer-only
bootstrap view on the deployed Worker. It returns every calendar before
allowlist filtering and works while the domain is disabled:

```
curl -H "Authorization: Bearer $API_TOKEN" "https://<worker>/v1/calendars?all=1"
```

Each entry carries `id`, `name`, `kind`, `color` and `readOnly`. Use the
display `name` in the allowlist; the `id` is what responses carry as
`collectionId`. `readOnly` comes from iCloud's privileges and is separate from
the write flag: a read-only calendar still refuses writes with `403
read_only_collection`.

The read bounds are base vars, not secrets: `MAX_CALENDAR_DAYS` (90),
`MAX_EVENT_RESULTS` (50), `MAX_RESPONSE_BYTES` (4194304), `MAX_RESOURCE_BYTES`
(262144), `MAX_RESOURCES_PER_QUERY` (300), `MAX_OCCURRENCES_PER_RESOURCE`
(200), `MAX_RDATE_EXDATE` (500), `MAX_RECURRENCE_CANDIDATES_PER_RULE` (50000),
`MAX_RECURRENCE_CANDIDATES_PER_REQUEST` (200000) and `CALDAV_TIMEOUT_MS`
(15000). `CALENDAR_WRITE_LIMITER` is the per-IP rate limiter for writes (30 per
minute); if the binding is missing while the write flag is on, writes fail
closed instead of running unlimited.

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

`npm run setup` is safe to run again and is the way to change folders,
calendar access, replace the Apple credentials, or rotate the token. A
re-run:

- keeps the account, Worker name, folders and allowlists from last time as the
  defaults;
- keeps every secret already stored in the Worker unless you explicitly ask to
  replace the credentials or rotate the token;
- asks before adopting a Worker it doesn't recognize, so a name typo cannot
  overwrite an unrelated deployment;
- deploys once to discover calendars when it has an API token, asks which
  calendars to allow, redeploys with the chosen allowlist, then re-verifies the
  endpoint and exits non-zero if a check fails. A rerun is
  never a verification-only retry.

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
  the sign-in page (which asks for the new token). A consent page left open
  across the rotation is refused at approval time, so it cannot mint a fresh
  grant from the old token. That is also the supported way to revoke a
  connector's access without touching the others beyond one reconnect.
- **Upgrade across the PKCE requirement:** grants minted by a build that did
  not require PKCE carry no marker, so their authorization code and refresh
  token are refused with `invalid_grant` (the grant is revoked) and the
  connector reconnects once through the sign-in page. A consent page left open
  across the upgrade is refused at approval. Nothing to do by hand; this is
  the same path as a rotation.
- **Replace the Apple app-specific password:** revoke it at appleid.apple.com
  → Sign-In and Security → App-Specific Passwords, create a new one, then run
  `npm run setup` and answer yes to replacing the credentials. Do this
  immediately if the Worker or its secrets may be compromised — this password
  grants more than read-only IMAP access (see `README.md`).
- **Lost token, nothing else wrong:** rotation is the only recovery path.
  Cloudflare's API cannot return a secret's value; nothing on your machine
  keeps a copy.

## Sending operations

- **Kill switch:** set `SEND_MAX_PER_DAY=0` in `wrangler.base.jsonc` and
  deploy. Every `send_mail` is then refused with `daily_limit_reached`, while
  reading and `save_draft` keep working.
- **Revoke a connector's ability to send:** rotate `API_TOKEN`; the connector
  must reconnect before it can send again.
- **Inspect what happened:** `wrangler tail` shows one `send_event` line per
  attempt — principal, event, recipient count and domains, SMTP code,
  duration; never the subject, the body or address local parts. The Durable
  Object keeps the same rows in its `audit` table (90 days).
- **"Delivery state unknown":** the connection dropped after the message was
  submitted, so it may already be queued. Check the recipient or
  `Sent Messages`; it is not retried automatically, and an identical resend
  inside a minute is refused. If iCloud files no copy of SMTP submissions, set
  `SEND_SENT_COPY=1` so future sends append one.
- **"Duplicate send":** the same message was submitted less than a minute ago;
  pass `allowDuplicate: true` only when the user really wants it sent twice.
- **Rate-limit sending further:** tighten the `SEND_*` caps.

## Filing operations

- **Confirm both destinations before relying on them:** `ALLOWED_ARCHIVE_MAILBOX`
  and `ALLOWED_TRASH_MAILBOX` are configuration only, and must match the
  account's real folder names (spaces included). The defaults are `Archive` and
  `Deleted Messages`; see [Configuration and targets](#configuration-and-targets).
- **Inspect what happened:** `wrangler tail` shows one `mail_mutation` line per
  call — principal, action, source mailbox, uid and destination; never the
  subject or body. Unlike sends, mutations have no durable audit trail.
- **"unsupported_move":** iCloud advertised neither `MOVE` nor `UIDPLUS`, so
  the proxy refused instead of risking a mailbox-wide `EXPUNGE`. File the
  message from a mail client; there is no safe fallback left.
- **"message_not_found":** the uid is no longer in the source mailbox; treat
  it as success when the message is gone from the source.
- **"mutation_state_unknown":** the connection dropped after the move started.
  iCloud has no `MOVE`, so the proxy runs `COPY` + `STORE \Deleted` + `UID
  EXPUNGE`; those steps are not atomic, and the copy may already be in the
  destination while the source still holds the message. Do not retry blindly —
  a second copy would be filed. Check both mailboxes first.
- **"uidvalidity_mismatch":** the mailbox was reorganized; re-run the search
  and use the fresh ids. Nothing was moved.
- **Restoring mail:** move the message back from `Archive` or the trash in a
  mail client. This proxy has no restore tool and never empties the trash.

## Calendar operations

- **Inspect what happened:** `wrangler tail` shows one `calendar_write` line per
  attempted event write — principal, action (`create_event`, `update_event` or
  `delete_event`), calendar id, resource id and outcome. It never includes the
  summary, description or location. Unlike sends, calendar writes have no
  durable audit trail.
- **"conflict":** the event changed since it was read. Call `get_event` again,
  compare, and retry with the fresh ETag. Do not reuse the old tag.
- **"mutation_state_unknown":** the PUT or DELETE was sent and the response
  never arrived, or iCloud answered an unexpected 2xx or a 5xx to a DELETE. It
  may have landed. Read the event with `get_event` and reconcile; never
  blind-retry a create, update or delete. A `404` after a delete means the
  event is gone.
- **"already_exists":** an idempotent create found the id already present.
  Read it and compare instead of creating a second copy with a new id.
- **"not_an_event":** the resource is a `VTODO`, not a calendar event; it
  cannot be updated or deleted through this proxy.
- **"recurring_not_supported" / "scheduling_not_supported":** recurring events
  and events with an organizer or attendees cannot be changed or deleted
  through this proxy. Edit them in Apple Calendar. Retrying will not help.
- **"read_only_collection":** iCloud's privileges say the calendar is not
  writable for this account, even though the write flag is on. Pick another
  calendar or change the sharing/ownership in Apple Calendar.
- **"rate_limited":** more than 30 writes per minute came from the same
  connecting IP. Wait a minute.
- **Delete only one-off events; no invitations:** `delete_event` removes one
  non-recurring event after an ETag check, but CalDAV deletion is immediate
  and there is no trash. Recurring and scheduling resources stay read-only and
  must be edited in Apple Calendar. There is no recurrence editor, no
  attendee/organizer editing and no free/busy, sharing or contacts.
- **Choosing or re-checking calendars:** `GET /v1/calendars?all=1` with the
  bearer token lists every calendar before allowlist filtering, even while the
  domain is disabled. Use it when a configured name no longer resolves.
- **After upgrading from a mail-only grant:** OAuth connectors must reconnect
  so the consent page can offer the new scopes. A grant that still holds only
  `mail:read` answers `insufficient_scope` on the calendar tools until then.
- **After upgrading to `delete_event`:** a grant that already holds
  `calendar:write` still cannot delete. Reconnect the connector and select
  `calendar:delete` on the consent page; until then `delete_event` returns
  `insufficient_scope`. Deletion is immediate and has no trash.

## Recovering an interrupted setup

Setup records its progress in `.deploy/state.json` (nonsecret: account ID,
Worker name, folders, calendar allowlist, timestamps) before it
changes anything in Cloudflare. Run `npm run setup` again and it continues from
there.

| Where it stopped | What exists | What the re-run does |
| --- | --- | --- |
| Before the confirmation | nothing | Asks again; Cloudflare was never touched. |
| Secrets uploaded, deploy failed | a Worker holding the secrets, no code (or the previous code) | Recognizes the Worker as yours, keeps the secrets unless you replace them, deploys again, then verifies. |
| Calendar discovery or the second deploy failed | a live Worker, possibly with the previous allowlists; any choices you already made are in state | Uses the saved choices as the bootstrap defaults, discovers again, redeploys with the allowlists, then verifies. |
| Deployed, verification failed | a live Worker | Keeps secrets, deploys again, then re-runs the checks, and prints a hint for the specific failure. |
| Deployed, token unknown | a live Worker | Deploys, reports "not verified", and exits nonzero until you paste the token or rotate it. |

The failure hint distinguishes the worlds that look alike from the terminal: a
Cloudflare error (login, deploy), an HTTP authorization error (the token
doesn't match), an upstream IMAP failure (`/healthz` returns 503 with
`ok: false` and an IMAP `error.code` of `NO`, `BAD`, `BYE`, `TIMEOUT`,
`PARSE`, or `LIMIT`), and a CalDAV/allowlist failure in the calendar checks
(`?all=1`, or the 7-day `list_events`). A calendar failure leaves mail working;
the hint says so.
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
`/healthz` checks IMAP only; it does not prove CalDAV. When calendars are
enabled, `GET /v1/calendars` (or `?all=1` for discovery) is the end-to-end
CalDAV check.

OAuth grants live in `OAUTH_KV`, which is eventually consistent across
Cloudflare locations: an access token issued at one location can be unknown at
another for up to ~60 seconds. If a connector reports an auth error right
after signing in, retry before debugging. The discovery endpoints are the
other quick probe: `curl https://<worker>/.well-known/oauth-protected-resource/mcp`
and `curl https://<worker>/.well-known/oauth-authorization-server` must both
answer 200 JSON without a token.
