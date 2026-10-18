# Sending mail (draft-first, owner-approved)

Status: planned, not started. Design input: a Claude Opus 5.5 brief
(2026-10-18), adapted to the owner's decisions recorded below. This file
supersedes `plans/outbound-send-proxy.md`.

## Decisions (owner, 2026-10-18)

- **v1 capabilities**: new messages, replies, saving drafts, forwards.
- **Protection**: draft → send, no recipient allowlist. Every send happens
  only after the owner opens the approval page on the Worker, sees the exact
  stored message (headers included) and presses **Invia**. The model can
  create, inspect, discard and export drafts; it cannot send, and no client
  setting can change that.
- **Activation**: always on for any authenticated caller (static bearer or an
  OAuth grant). No `SEND_ENABLED` flag, no `mail:send` scope, no second
  Worker, no second token. Caps are configuration.
- **Recorded consequence**: the read proxy loses the "zero SMTP code, cannot
  send even if compromised" property that `plans/outbound-send-proxy.md`
  deliberately protected. Compensating controls are the out-of-band approval
  click, the traffic caps, the draft TTL and the metadata-only audit trail.
  A compromised deployment could send mail; so could anyone holding the
  app-specific password. The approval gate protects against model mistakes
  and prompt injection, not against a compromised Worker.

## Outcome and scope

An authenticated MCP client (ChatGPT, claude.ai, Claude Code, opencode, a
curl script) composes a plain-text message — new, reply or forward — and
receives a draft id plus an approval URL. The draft is stored server-side;
nothing touches SMTP. The owner opens the URL, signs in with `API_TOKEN`,
reads the message exactly as it will be sent, and presses **Invia**. Only
then does the Worker connect to `smtp.mail.me.com:587` (STARTTLS, AUTH PLAIN
with the existing app-specific password) and submit it. A `save_draft`
action appends the same bytes to the iCloud `Drafts` mailbox so the owner can
finish the message from any mail app; once live acceptance shows whether
iCloud files SMTP submissions in `Sent Messages`, a copy is appended there
too if needed.

One implementation unit; steps in dependency order, each leaving the repo
deployable and `npm test`, `npm run typecheck`, `npm run check:bundle` and
`npm run deploy:production -- --dry-run` green.

Keep: the read tools and the REST API byte-for-byte, the bearer gate, the
OAuth flows, `private, no-store` on every response, content-free logs, one
Apple account per deployment, the guided setup and the production profile.

Exclude (v1): outgoing attachments, HTML bodies, non-ASCII addresses,
automatic reply-all, recipient allowlist, per-scope gating, scheduled sends,
REST endpoints for drafts, multiple senders or identities, setup-wizard
prompts for send settings. (A forward of a message that had attachments says
so in the body; it does not carry them.)

## Current constraints

- **SMTP over `cloudflare:sockets`** (verified locally for this plan, without
  any iCloud connection): workerd under `unstable_startWorker` can open a TCP
  connection to a loopback listener, and `sock.startTls()` completes a
  handshake with a self-signed server; the connection is then rejected
  because a self-signed certificate cannot be trusted and wrangler offers no
  CA-injection option. Tests therefore use a **plaintext loopback fake SMTP
  server** behind a test-only override that production cannot reach. Whether
  Apple accepts STARTTLS on 587 exactly as our client implements it is
  confirmed only by live acceptance (465 implicit TLS is the fallback).
- **`vars` are base-only.** Targets may override only `FRAGMENT_KEYS`
  (`scripts/lib/config.mjs`), so every target shares the base `vars`. Caps
  are non-personal defaults and belong there; personal values (`SEND_FROM`,
  `SEND_FROM_NAME`) are optional secrets.
- **The OAuth library does not enforce scopes**, and external bearer tokens
  carry an empty scope list. This plan adds no scope gating, so the provider
  configuration (`scopesSupported`, `requiredScopes`) and the consent
  transaction stay as they are; only page copy changes (step 9).
- **KV budget.** `OAUTH_KV` shares 1,000 writes/day on the free tier. Draft
  and quota state must be atomic across an approval double-submit, so it
  lives in a Durable Object (`SendLedger`); no write is added to `OAUTH_KV`.
  SQLite-backed Durable Objects on the Workers Free plan must be confirmed in
  step 1 (KV fallback is documented under "Ledger").
- **`/mcp` is served by `createMailMcpHandler(env)`** (a fresh `McpServer`
  per request, `src/mcp.ts`), so tool registration can depend on env; the
  non-`/mcp` routes land in `defaultFetch` (`src/index.ts`), which is where
  `/send/approve` goes.
- **`ImapSession.open` hard-codes the iCloud host and has no injectable
  socket factory**; APPEND tests cover command framing as pure functions, the
  rest is live acceptance (a fake IMAP server is its own deferred plan,
  `plans/fake-imap-integration-tests.md`).
- **README promises today** "no SMTP code anywhere in this project — the
  proxy cannot send mail" (lines ~204 and ~417), and `Security model` lists
  the IMAP verbs. Both change in step 9.
- The app-specific password is account-wide and can send regardless of this
  code (README already says so); the caps below are the only thing limiting
  automated sending.

## Design

### Flow

1. `create_draft` validates inputs, builds the final RFC 5322 bytes (`Date`
   and `Message-ID` fixed at creation), stores them in the `SendLedger` DO and
   returns `{ draftId, approveUrl, expiresAt, preview }`.
2. The client shows `approveUrl` to the owner. No SMTP connection exists yet.
3. `GET /send/approve?d=<draftId>`: without a valid `__Host-send` cookie it
   serves the token-entry form (same style as the OAuth pages); with it, the
   escaped message preview, the recipient list and a one-time form nonce.
4. `POST /send/approve` `action=send`: verifies cookie, nonce and draft
   state; reserves quota and flips the draft to `sending` in one synchronous
   DO transaction; runs SMTP; finalises the draft as `sent`, `failed` or
   `unknown`.
5. `action=discard` deletes the draft. `action=save` (step 8) appends the
   message to the iCloud `Drafts` mailbox and marks the draft `saved`.

The model never holds a credential that can send, and no send happens without
a click that carries the owner's sign-in.

### MCP tools

Registered for every authenticated caller (bearer and OAuth alike), next to
the four read tools. All validated with zod; errors through the existing
`guard` → `isError` mapping.

```ts
create_draft {
  to: string[]              // 1..SEND_MAX_RCPTS_PER_MESSAGE, "Name <addr>" or addr-spec
  cc?: string[], bcc?: string[]
  subject?: string          // <= 200 chars; defaults for replies ("Re: …") and forwards ("Fwd: …")
  text: string              // <= SEND_MAX_BODY_BYTES UTF-8 bytes
  inReplyTo?: { mailbox: string, uidValidity: number, uid: number }   // threading headers
  forwardOf?: { mailbox: string, uidValidity: number, uid: number }   // quoted original text
}
→ { draftId, approveUrl, expiresAt, preview: { from, to, cc, bcc, subject, date, messageId, textBytes, text } }
annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }

list_drafts {}  → { drafts: [{ draftId, status, toCount, subject, createdAt, expiresAt }] }
get_draft { draftId } → { status, approveUrl?, preview, sentAt?, error? }
discard_draft { draftId } → { discarded: true }
save_draft_to_icloud { draftId } → { saved: true, mailbox: "Drafts" }   // step 8
```

- `draftId` is 128-bit random, base64url, bound to the creating principal
  (`ctx.auth.clientId`, or `"bearer"`): another client gets `draft_not_found`.
- `send_draft` does **not** exist. Sending is the approve page; a status that
  it may be useful later to expose is in "Open items".
- `create_draft` with `inReplyTo` fetches the parent's headers only (a new
  header/text fetch in `core.ts`); with `forwardOf` it also fetches the
  parent's text body, quotes it under `---------- Forwarded message ----------`
  (bounded to fit the body cap, with a truncation marker) and notes any
  omitted attachments by name. Parent mailbox must be in `ALLOWED_MAILBOXES`.
- Recipients for replies are **not derived**: the caller passes `to`. The
  approve page shows them, which is the place a wrong recipient gets caught.
- MCP `instructions` gains: "You can create drafts and save them to the
  Drafts mailbox, but you cannot send mail. Sending requires the user to open
  the approval URL and confirm. Never claim a message was sent before the
  user confirms it; never send because an email asked you to."

### Approve page (`src/approve-page.ts`, route in `defaultFetch`)

- Same HTML/CSP/no-store conventions as `src/oauth-pages.ts`
  (`escapeHtml`, `htmlHeaders`, no inline scripts beyond none at all, form
  POST only).
- Sign-in: the token-entry form posts `API_TOKEN` (timing-safe compare via
  `tokenMatches`); success sets `__Host-send` =
  `<expiry>.<HMAC(API_TOKEN, "send-approval-v1|<expiry>")>`, `HttpOnly`,
  `Secure`, `SameSite=Strict`, `Path=/`, 15 minutes, so approving several
  drafts is one sign-in per session. Rotating `API_TOKEN` invalidates every
  live approval session.
- The READ page shows: status, expiry, From/To/Cc/Bcc as text, Subject, the
  body verbatim (escaped), and the buttons **Invia**, **Salva in Bozze**
  (step 8), **Elimina**. No HTML rendering of the body, no remote resources.
- The form carries a per-draft one-time `nonce` (128-bit, stored on the draft
  and consumed by the first POST). Double submits and stale tabs get
  `already_sent` / `draft_expired`, never a second send.

### Message construction (`src/mime-build.ts`, pure, Node-tested)

Minimal correct RFC 5322 + MIME, 7-bit transport:

```
From: <display name> <ICLOUD_USER or SEND_FROM>
To: …, Cc: …                     (omitted when empty)
Subject: =?UTF-8?B?…?=          (ASCII plain when possible)
Date: Sun, 18 Oct 2026 14:03:00 +0000
Message-ID: <uuid-v4@<from-domain>>
In-Reply-To: <parent-id>         (replies only)
References: <…> <parent-id>      (replies only)
MIME-Version: 1.0
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

<QP body, CRLF, lines <= 76>
```

- No `Bcc:` header; Bcc recipients exist only in `RCPT TO`.
- No HTML in v1 (preview mismatch and tracking-URL risks).
- UTF-8 only inside encoded-words and the QP body; **no SMTPUTF8**, no
  non-ASCII addresses (v1 rejects them outright).
- Header-injection defences: reject (never strip) CR, LF, NUL or C0 controls
  in every field; strict ASCII addr-specs (dot-atom local part, dot-atom
  domain with a dot; quoted local parts, comments, groups, route addresses
  and IP literals rejected; 254/64 length caps); display names always emitted
  as encoded-words or quoted-strings, never raw.
- Parent `Message-ID`/`References` come from third-party mail and are copied
  only if they match `^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$`; at most the first
  and last 9 ids are kept; an invalid parent id drops threading rather than
  failing.
- Dot-stuffing is applied to the encoded output; the serialised message is
  asserted to be pure 7-bit ASCII before it is stored.

### SMTP client (`src/smtp.ts`, injectable socket factory)

`connect({hostname: "smtp.mail.me.com", port: 587})` → greeting → `EHLO` →
`startTls({ expectedServerHostname: "smtp.mail.me.com" })` → fresh `EHLO` →
`AUTH PLAIN` (`\0user\0appPassword`, never logged, never in an error) →
`MAIL FROM` → one `RCPT TO` per deduplicated recipient (To ∪ Cc ∪ Bcc) →
`DATA` → dot-stuffed body → `.` → `QUIT` (best effort, 3 s). One connection
per send; no PIPELINING, no CHUNKING; 30 s per step, 60 s for the final reply
after DATA, matching `imap.ts` in spirit but new code.

Error classes mapped to stable codes (subsets kept from the design brief):

| Reply | Code | Handling |
| --- | --- | --- |
| `421`, `450/451/452` before DATA completes | `smtp_unavailable` | draft returns to `ready`, quota released |
| `535` | `smtp_auth_failed` | draft back to `ready`; `/healthz` will fail too (same password as IMAP) |
| `550/551/553` on MAIL | `smtp_sender_rejected` | final; a configuration problem |
| `550/553` on RCPT | `smtp_recipient_rejected` | final; names the rejected index, not the address |
| `552` | `smtp_too_large` | unreachable once caps hold |
| `554` / any 5xx after DATA | `smtp_rejected` | final, nothing delivered |
| timeout/loss after the final `.` | `send_status_unknown` | draft goes to `unknown`, quota stays consumed, never auto-retried; the page says to check with the recipient or the Sent folder |
| TLS failure | `smtp_tls_failed` | final |

Test-only override: `SMTP_HOST`/`SMTP_PORT` are honoured **only** when the
host is the literal `127.0.0.1` or `localhost`, and only then is
`secureTransport: "off"` used; any other value is ignored in favour of the
hard-coded iCloud endpoint with mandatory STARTTLS. A unit test asserts the
override cannot escape loopback.

### Ledger and caps (`src/send-ledger.ts`, Durable Object)

Single instance, `idFromName("deployment")`, SQLite-backed, bound as
`SEND_LEDGER` with a `migrations` entry in `wrangler.base.jsonc`
(`new_sqlite_classes: ["SendLedger"]`). Tables:

- `drafts(id PK, principal, status, created_at, expires_at, raw BLOB,
  envelope_from, rcpt_json, meta_json, approval_nonce, saved_to_drafts_at)` —
  `status` in `ready | sending | sent | failed | unknown | saved |
  discarded`.
- `usage(day PK, messages, recipients)` — UTC day boundary, documented.
- `audit(ts, event, draft_id, principal, rcpt_count, rcpt_domains_json,
  bytes, smtp_code, duration_ms)` — pruned to 90 days by the TTL alarm.

`send(draftId, principal, nonce)` is one DO method: verify status/expiry/
principal/nonce, reserve quota, flip to `sending` **in one synchronous
transaction** before any network await, then run SMTP and finalise. A second
concurrent submit sees `sending` and gets `send_in_progress`; a `sending`
older than 5 minutes is treated as `unknown`, never `ready`. The TTL alarm
(default 1 h, `SEND_DRAFT_TTL_SECONDS`) deletes draft bytes and keeps the
audit row; open drafts are capped (`SEND_MAX_OPEN_DRAFTS`).

If SQLite Durable Objects turn out to be unavailable, the fallback is
`OAUTH_KV` + `expirationTtl` with documented weaker guarantees (no atomic
double-submit protection, eventually consistent caps, ~3 KV writes/message);
the plan treats that as a degraded mode to be called out in README, not a
silent substitution.

Caps (base `vars`, hard-clamped in `src/send-policy.ts` so a var cannot
raise them past sane limits):

| Var | Default | Hard max |
| --- | --- | --- |
| `SEND_MAX_PER_DAY` | 20 | 100 (0 disables all sends — the documented kill switch) |
| `SEND_MAX_RCPTS_PER_DAY` | 50 | 200 |
| `SEND_MAX_RCPTS_PER_MESSAGE` | 5 | 20 |
| `SEND_MAX_BODY_BYTES` | 65536 | 262144 |
| `SEND_DRAFT_TTL_SECONDS` | 3600 | 86400 |
| `SEND_MAX_OPEN_DRAFTS` | 20 | 100 |

Optional secrets: `SEND_FROM` (default `ICLOUD_USER`; must be an address the
account owns — alias behaviour checked live), `SEND_FROM_NAME`.

Enforcement order, each failing before the next runs; nothing touches SMTP
until the last line:

| # | Check | Where | Error |
| --- | --- | --- | --- |
| 1 | Shape and lengths (zod) | tool schema | `invalid_argument` |
| 2 | Address syntax, ASCII only, no controls | `mime-build` | `invalid_address` |
| 3 | Parent exists in an allowed mailbox (reply/forward) | `core` fetch | `not_found` / `mailbox_not_allowed` |
| 4 | Message <= hard byte cap and 7-bit | `mime-build` | `message_too_large` |
| 5 | Draft state, principal, TTL, open-draft cap | DO | `draft_*` |
| 6 | Daily message and recipient caps, reserved atomically | DO | `daily_limit_reached` |
| 7 | Approval cookie + one-time nonce | `/send/approve` → DO | `approval_required` / `forbidden` |
| 8 | STARTTLS required, AUTH, all-or-nothing RCPT | `smtp.ts` | `smtp_*` |

### Logging

One `console.log(JSON.stringify({ event: "send_event", … }))` per state
change: draftId, event (`draft_created`, `send_started`, `sent`, `failed`,
`unknown`, `saved`, `discarded`, `approved`), principal (OAuth `clientId` or
`bearer`), recipient count and **domains**, message bytes, SMTP reply code,
duration. Never logged: subject, body, local parts, the app password, full
SMTP reply text.

### Revocation

Rotating `API_TOKEN` already revokes every OAuth grant; it also invalidates
`__Host-send` cookies and any pending approval. Drafts die by TTL. Revoking
the app-specific password at appleid.apple.com stops SMTP and IMAP together.
Setting `SEND_MAX_PER_DAY=0` and redeploying is the in-code kill switch (no
new flag).

### Sent copy and IMAP APPEND

`ImapSession` gains `append(mailbox, flags, raw)`: `APPEND "<mailbox>"
(\Flags) {n}` + literal bytes + `CRLF` (a pure framing helper
`buildAppend` unit-tested; no injectable IMAP socket in v1). Used by
`save_draft_to_icloud` (flags `(\Draft)`, marks the draft `saved`, and the
approval path for that draft is closed to avoid a double send) and — only if
live acceptance shows iCloud does not file SMTP submissions — by a
`\Seen` copy appended to `Sent Messages` after a successful send
(`SEND_SENT_COPY=0|1`, default chosen after the live check). This is the one
deliberate change to the "IMAP read-only" invariant, and it is called out in
README.

### Docs and copy changes (step 9)

- README `Security model`: sending exists; the model can draft but not send;
  sending requires the owner's approval page; caps; the audit trail; the
  app-password caveat; the deliberate loss of "cannot send even if
  compromised"; `Sent`/`Drafts` APPEND.
- README `MCP`: the five new tools and the approval flow, with a screenshot-
  free description of the page.
- DEPLOY: caps, `SEND_FROM`/`SEND_FROM_NAME`, the kill switch, SMTP failure
  semantics including `unknown`, deriving the DO migration on first deploy.
- Consent page copy (`src/oauth-pages.ts`): the fixed permission line keeps
  "It cannot move, flag, or delete anything", and gains that the app **can
  create draft messages** and that **sending always requires your approval**;
  the wording must not promise "read-only".
- MCP `instructions` per "MCP tools".
- `plans/outbound-send-proxy.md`: superseded note (done in this planning
  PR).

## Implementation

### 1. Bindings, env and policy parsing

- `wrangler.base.jsonc`: `SendLedger` DO + migration + `SEND_LEDGER`
  binding; the cap `vars` from the table.
- `src/types.ts`: `Env` fields; `src/send-policy.ts`:
  `readSendConfig(env)` → `{ from, fromName, caps } | { error }`, clamping
  against the hard maxima; `SEND_*` parsing tests, including "0 disables".
- Confirm the DO/migration passes both dry-runs and that SQLite DOs are
  available on the deployment's plan (fallback decision recorded here).

*Done when* dry-runs accept the migration and the policy tests cover clamped,
default and disabled configurations.

### 2. MIME builder

- `src/mime-build.ts` + `test/mime-build.test.ts` per the design section:
  encoded-word boundaries (emoji, combining marks, <= 75 chars), folding,
  quoted display names, CR/LF/NUL rejection everywhere, strict address
  grammar, QP body cases (lone `.`, trailing whitespace, long lines), no
  `Bcc:` header, Date format, Message-ID domain, reply/forward headers,
  hostile parent ids dropped, a golden full message, 7-bit assertion.

*Done when* the golden message and every injection case pass.

### 3. SMTP client

- `src/smtp.ts` with the injectable socket factory and the loopback-only
  override; error taxonomy per the table.
- `test/smtp.test.ts` with an in-memory duplex fake (multi-line replies,
  `startTls()` swap with locks released, missing STARTTLS → fail closed
  before AUTH, AUTH PLAIN encoding, password never in errors, each error
  class, timeout after DATA → `unknown`, best-effort QUIT).

*Done when* every row of the error table is covered and the loopback guard
has its own test.

### 4. Send ledger

- `src/send-ledger.ts` (DO) + a pure core class over a tiny SQL interface so
  Node tests can cover the state machine: double submit, concurrent
  `sending`, expiry, quota reserve/release per outcome, open-draft cap, the
  UTC day rollover, nonce single use.

*Done when* the double-send and quota-release tests pass.

### 5. Parent fetch for replies and forwards

- `src/core.ts`: `fetchParentForComposition(env, { mailbox, uidValidity, uid })`
  → `{ messageId, references, subject, from, text, attachmentNames }`, with
  the mailbox allowlist and UIDVALIDITY checks of `getMessage`; uses
  `postal-mime` (`references`/`messageId` are already available; confirm
  `from` and the text extraction reuse the existing `getMessage` path).
- Unit tests for hostile parents (bad ids, huge bodies, HTML-only) flowing
  into `mime-build` safely.

*Done when* the parent data reaching `mime-build` is validated and capped.

### 6. Approve page and send flow

- `src/approve-page.ts` + routes in `defaultFetch`: `GET` (token entry /
  preview) and `POST` (`login`, `send`, `discard`), `__Host-send` cookie,
  one-time nonce, escaped preview, `private, no-store`, CSP.
- The DO `send` path with the SMTP client.

*Done when* a draft created directly against the DO can only be sent after a
correct token, a valid nonce, and exactly once.

### 7. MCP tools and end-to-end integration

- The five tools in `src/mcp.ts`, with annotations and the `instructions`
  change; `tools/list` includes them for bearer and OAuth callers.
- `test/send.integration.test.mjs` (real workerd, fake loopback SMTP, fake
  ports via `unstable_startWorker` bindings; factor the shared `startWorker`
  helper out of `oauth.integration.test.mjs` if needed): create → approve →
  fake server receives the exact stored bytes (no `Bcc:` header, all
  envelope recipients); zero SMTP connections before approval; second POST →
  no second connection; caps with `SEND_MAX_PER_DAY=1`; TTL expiry; hostile
  recipients/inputs; `send_status_unknown` when the fake drops after DATA and
  no retry; `private, no-store` on the page routes; rotating `API_TOKEN`
  invalidates the approval cookie.

*Done when* the suite proves "no approval, no SMTP" and "one draft, one
send".

### 8. IMAP APPEND, save_draft, Sent copy

- `buildAppend` framing helper + `ImapSession.append`; unit tests for the
  framing (literals, flags, CRLF) and for the terminal `saved` state.
- `save_draft_to_icloud` tool and the **Salva in Bozze** page button.
- Sent copy behind `SEND_SENT_COPY` **only if** live acceptance (step 10)
shows iCloud does not file SMTP submissions, then flip the default.

*Done when* appended drafts appear in iCloud's Drafts from a real client and
a saved draft cannot be sent twice.

### 9. Docs and copy

- README, DEPLOY, `.dev.vars.example`, consent copy and MCP instructions per
  the design section; `verify.mjs` unchanged unless it asserts scopes
  (it checks issuer/CIMD only).

*Done when* the docs match the shipped behaviour and no page still claims
"read-only".

### 10. Live acceptance (owner-run)

All sends go to the owner's own address. Record in this plan's status
section:

- STARTTLS 587 send arrives; record Received/DKIM headers and whether Apple
  preserved our `Message-ID`.
- Whether the message appears in `Sent Messages` (decides step 8's copy).
- 465 implicit TLS as the fallback route, through a temporary local toggle.
- `SEND_FROM` alias accept/reject and the reply code.
- A reply lands threaded in Apple Mail; a forward quotes the original.
- `save_draft_to_icloud` shows up in Drafts on the iPhone, and editing and
  sending it from there works.
- ChatGPT and claude.ai: create a draft, open the approval URL, send; record
  how each client surfaces the link and the tool call.
- Production: one real send; `SEND_MAX_PER_DAY=0` refuses; rotating
  `API_TOKEN` invalidates an open approval session.

*Done when* a message sent from each of ChatGPT, claude.ai and curl (via the
approval page) arrives, and the status section records the results.

## Testing

- **Unit (Node, vitest)**: `mime-build`, `send-policy`, `smtp` (injected
  socket), `send-ledger` core, `imap-append` framing, plus extensions to
  `oauth-pages` (copy) and `core` (parent fetch).
- **Integration (real workerd)**: the fake SMTP server from step 7; the
  existing OAuth suite must keep passing with the new binding.
- **Not automated**: real iCloud SMTP/IMAP behaviour; a fake IMAP server
  stays in `plans/fake-imap-integration-tests.md`.

## Acceptance criteria

- `npm test`, `npm run typecheck`, `npm run check:bundle` and
  `npm run deploy:production -- --dry-run` pass locally and in CI.
- Bearer and OAuth clients see the five new tools; no benign read behaviour
  changes anywhere.
- Creating a draft never opens an SMTP connection; the only code path to
  SMTP is a `POST /send/approve` with a valid cookie and nonce.
- Each draft is sent at most once; an ambiguous outcome is `unknown` and
  never retried automatically.
- Caps hold under concurrency; `SEND_MAX_PER_DAY=0` refuses everything.
- Logs carry no subject, body or address local parts.
- Rotating `API_TOKEN` kills approval sessions and grants; the app password
  remains the last-resort revocation.
- One live message sent from ChatGPT, one from claude.ai, one from curl.

## Open items and risks

- **SQLite Durable Objects on the plan in use** — step 1 decides; KV
  fallback is degraded (documented).
- **STARTTLS on 587 against Apple, from production**, and the 465 fallback.
- **`Sent Messages` filing** by iCloud for SMTP submissions.
- **Aliases as `SEND_FROM`**; iCloud may reject or rewrite.
- **Account-lock risk** if Apple flags automated sending; caps stay low and
  the app password can be revoked at any time.
- **Client UX**: whether ChatGPT/claude.ai render the approval URL as a
  clickable link; if not, a `send_draft`-style tool that only *requests*
  approval, or MCP URL-mode elicitation (spec 2025-11-25, client support
  unverified), can be added without changing the security model.
- **Residual risk, recorded**: with no allowlist, a manipulated model can
  produce a convincing draft to any recipient; only the owner's reading of
  the approval page stands between that and a real send. If that ever feels
  insufficient, the two knobs already designed are an allowlist
  (`SEND_ALLOWLIST`) and per-scope gating (`mail:send`), both previously
  sketched in the Claude Opus 5.5 brief.
- **KV/DO migration on deploy**: first deploy creates the DO class; a bad
  migration change is the one deployment risk that can require a rollback.
- **Integration suite runtime** with one more workerd boot.

## Estimate

L: about 5 developer days plus half a day of live acceptance.

| Area | Estimate |
| --- | --- |
| MIME and policy | 1 d |
| SMTP and fakes | 1–1.5 d |
| Ledger (DO) | 1 d |
| Approve page | 0.5–1 d |
| Tools and integration | 0.5–1 d |
| APPEND (Drafts/Sent) | 0.5 d |
| Docs | 0.5 d |
| Live acceptance | 0.5 d |

## Implementation status

Not started. Design input from Claude Opus 5.5 (2026-10-18) is folded into
the sections above; the owner's decisions of the same date are recorded at
the top. This file was written before any code, so every "verified" claim
above is about the environment, not about the feature.
