# Feature-gap roadmap

**Status (2026-10-28):** specification; nothing implemented. Baseline is
`origin/main` at `8d2d9b8`. Branch from it, not from an older docs branch: at
that commit the Worker has 10 mail tools (`list_mailboxes`, `search_mail`,
`get_mail_message`, `get_mail_attachment`, `read_mail`, `archive_mail`,
`delete_mail`, `restore_mail`, `send_mail`, `save_draft`) and 6 calendar tools,
16 in total. README still says eight mail tools and 14 in total; correct it the
first time a unit touches the tool list.

**Why:** OpenAI shipped first-party iCloud Mail and iCloud Calendar plugins for
ChatGPT (2026-10-27). Comparing their tool lists with this proxy showed that it
loses mostly on *finding* things (a person, an event, a message), not on acting.
Opus 5.5 and GPT Astra were asked independently which functions to add; this
plan is the owner's decision after reading both. What was left out is in
[feature-gap-not-planned.md](feature-gap-not-planned.md).

**Principle:** keep the proxy narrow. A unit may add reads freely, may add
writes only when they are reversible or confined to the owner's own calendar,
and must keep the existing style: separate scope, hard caps, ETag or fixed
destination, one audit line with metadata only, untrusted-content labelling.
The static bearer stays the owner and holds every scope.

## Decisions taken

| Item | Decision |
| --- | --- |
| Split `mail:read` into finer scopes | Yes, first (unit 1) |
| Contacts (CardDAV, read-only) | Yes (unit 2) |
| Multi-calendar search including notes | Yes (unit 3) |
| Richer mail search, then UTF-8 | Yes (unit 4) |
| Unread and flag/unflag, one message per call | Yes (unit 5) |
| Event reminders (`VALARM`) | Yes (unit 6) |
| Basic recurrence on create | Yes (unit 7), shipped together with whole-series update and delete so a created series can always be fixed or removed |
| `save_draft` scope | `mail:modify` (owner delegated the choice, 2026-10-28) |
| Time zones for recurring events | Write `TZID` with `VTIMEZONE` (owner agreed, 2026-10-28) |
| Bulk operations on several messages | Not now |
| Outgoing attachments, forward with attachments | Not now |

## Order and dependencies

1. Scope split. Everything below registers its tools against the new scopes.
2. Contacts, 3. calendar search, 4. mail search, 5. flags, 6. alarms,
   7. recurrence. After unit 1 they are independent; this order is by value for
   the least risk. Units 2, 4b, 6 and 7 start with a read-only probe whose result
   can change the design, so run the probe before writing code.

Every unit is done when all of this holds:

- `npm test`, typecheck and bundle validation pass, with tests for each
  refusal path (no network call made when a request is refused).
- `scripts/lib/verify.mjs` expects the exact new tool set and the tests that
  cover it are updated.
- README (API, MCP, Security model), the MCP server instructions and the tool
  descriptions agree with the behaviour. The tool-count sentences are right.
- A review pass found nothing open. Calendar writes and contacts are also
  accepted live against the `Scratch` calendar or a disposable record, and the
  result is recorded under "Deployment and acceptance" in this file, in the
  style of [calendar-delete-event.md](calendar-delete-event.md).

## 1. Split the mail scope

**What:** `mail:read` is today the umbrella for all ten mail tools, so a
connector granted "read my mail" can also send, archive and trash. Split it.

| Scope | Tools | Implies |
| --- | --- | --- |
| `mail:read` | `list_mailboxes`, `search_mail`, `get_mail_message`, `get_mail_attachment` | |
| `mail:modify` | `read_mail`, `archive_mail`, `restore_mail`, `save_draft`, and unit 5's flag tool | `mail:read` |
| `mail:trash` | `delete_mail` | `mail:read` |
| `mail:send` | `send_mail` | `mail:read` (replies read the parent) |

`save_draft` sits in `mail:modify` because it only appends to Drafts and sends
nothing. This is decided; a separate drafts scope is not planned.

**Migration** follows the `calendar:delete` precedent
([calendar-delete-event.md](calendar-delete-event.md)): a grant that holds only
`mail:read` keeps reading and gets `insufficient_scope` on the write tools until
it reconnects and the owner approves them. Every ChatGPT and claude.ai
connector must be reconnected once after deploy. Say so in the deploy notes.

**Implementation:**

- `src/scopes.ts`: add the three scopes to `SCOPES`; generalise the implication
  in `hasScope` (today only the two calendar scopes imply a read scope).
- `src/mcp.ts`: change the `guard(authority, "mail:read", ...)` calls per the
  table above.
- `src/oauth-pages.ts` and the authorize flow: offer the new scopes on the
  consent page with the same preselection rule; update the copy so
  `mail:read` no longer claims to include sending.
- `scripts/lib/verify.mjs`: the deployment check that the challenge names
  `mail:read` keeps working; the metadata check expects the new scope list.
- README MCP and Security sections: replace "`mail:read` is the umbrella".

**Tests:** per tool, a grant holding only the wrong scope gets
`insufficient_scope` and the underlying call is never made; implied-read
behaviour; the bearer reaches everything; an old `mail:read`-only grant keeps
reading (extend `test/scopes.test.ts`, `test/oauth.integration.test.mjs`,
`test/oauth-pages.test.ts`).

**Effort:** M. **Status:** ready.

## 2. Contacts, read-only

**What:** `search_contacts` and `get_contact` over CardDAV, plus REST
`GET /v1/contacts?q=` and `GET /v1/contacts/:id`. Purpose: resolve "write to
Marco" without hunting for the address in old mail.

**First, probe.** Add a read-only `scripts/probe-carddav.mjs` in the style of
`scripts/probe-caldav.mjs` (only PROPFIND, REPORT, OPTIONS, GET). It must answer:

- Does discovery work with the app-specific password? An Apple developer-forum
  thread reports 401s during CardDAV discovery; if it fails for this account
  the unit stops here and is recorded as blocked.
- Principal, `addressbook-home-set`, the per-user shard host (expected
  `pNN-contacts.icloud.com`), the address-book collections.
- Does `addressbook-query` with a `text-match` on `FN`/`EMAIL` work, or must
  the Worker list the book and filter locally? vCard version returned (expected
  3.0), ETag and href shape, response size for the whole book.

**Contract:**

- New opt-in `CONTACTS_ENABLED` (tracked default `"0"`), mirroring how calendars
  are opt-in. When off, no tools are registered, REST answers `404
  not_supported`, and no scope is offered.
- New scope `contacts:read`, offered on the consent page only when enabled.
- `query` is mandatory, at least 2 characters after trimming: there is no
  "list everything" and no dump. At most `MAX_CONTACT_RESULTS` (default 10).
- Returned fields only: `id`, `name`, `emails[]`, `phones[]`, `organization`.
  Never notes, addresses, birthdays, photos or related names. `get_contact`
  returns the same fields.
- Contact text is third-party content: label it `untrustedContactContent`, like
  `untrustedEmailContent`, and say so in the tool description.
- If the probe shows server-side filtering is unsupported, list the book with a
  hard `MAX_CONTACT_RESOURCES` cap and fail closed with `too_many_resources`
  above it instead of filtering a truncated list.
- Audit: one `contact_search` line with principal and result count; never the
  query or any field. A per-IP limiter (30 per minute, fails closed when the
  binding is missing) follows `CALENDAR_WRITE_LIMITER`, so an injected agent
  cannot harvest the address book quickly.
- Nothing writes: no `PUT`, `DELETE` or `PROPPATCH` exists in the contacts
  client.

**Implementation:** `src/carddav.ts` (reuse the DAV helpers in `src/caldav.ts`:
PROPFIND/multistatus parsing, auth, shard following), `src/vcard.ts` (line
unfolding, `N`/`FN`/`EMAIL`/`TEL`/`ORG`, escaped commas), a `contacts-core.ts`
and the registration in `src/mcp.ts` and `src/rest.ts`; `wrangler.base.jsonc`
vars and binding; setup asks whether to enable contacts.

**Tests:** vCard parser fixtures (folded lines, escapes, multiple emails),
discovery and shard redirect with a fake server, query below minimum length,
result cap, disabled-domain 404, scope refusal, limiter fail-closed, audit line
has no query.

**Effort:** M. **Status:** ready, gated on the probe.

## 3. Search events across calendars, notes included

**What:** `list_events` today needs one calendar and filters `text` over summary
and location only (`matchesText` in `src/calendar-events.ts`). Make `calendar`
optional and match the description too, so "find the accountant appointment"
works without knowing the calendar.

**Contract:**

- `calendar` omitted means every allowlisted calendar. Naming one behaves
  exactly as today, so existing callers are unaffected.
- `text` also matches the description. The parsed component already carries it
  (`get_event` returns it under `untrustedCalendarContent`); list results do not
  gain a `description` field. They gain `matchedIn: ("summary" | "location" |
  "description")[]` so the caller can see why an event matched without receiving
  the note.
- Each result names its calendar. Results are merged and sorted by start, with
  the same `MAX_EVENT_RESULTS` cap.
- The window stays at most `MAX_CALENDAR_DAYS` (90). The resource and recurrence
  budgets (`MAX_RESOURCES_PER_QUERY`, the two recurrence budgets) are
  request-wide, shared by all calendars, not multiplied per calendar. If the
  shared budget is exceeded, refuse the whole request and name the calendar that
  tipped it; never return a partial merge that looks complete.
- Config errors keep failing closed (`configured_calendar_missing`,
  `ambiguous_calendar_name`).

**Implementation:** `src/calendar-events.ts` (iterate the allowlist, shared
budget object, `matchesText` over the description), `src/mcp.ts` and
`src/rest.ts` input schemas and descriptions.

**Tests:** all-calendars merge order, one calendar unchanged, description-only
match with `matchedIn`, shared budget exceeded, a calendar error fails the
request, truncation flags.

**Effort:** S. **Status:** ready.

## 4. Richer mail search

**What:** structured filters in `search_mail` and `GET /v1/search`.

**4a. Filters.** Add to `SearchParams` (`src/types.ts`):

- `to`, `cc` substring filters, like `from`.
- `flagged: boolean`, next to `unseen`.
- `from`, `subject`, `text` accept a string or an array of strings; an array
  means OR within that one field.
- `not: { from?, subject?, text? }` exclusions.
- A single builder produces the IMAP criteria from this closed shape. The agent
  never supplies a raw SEARCH string or a free boolean tree: that would be
  injection into the protocol. Cap the array length (4) and the total number of
  criteria. Unknown keys stay rejected.
- `hasAttachment` is not an IMAP SEARCH key; the proxy derives
  `hasAttachments` from `BODYSTRUCTURE` after the fetch. Add it only as a
  post-filter inside the existing `MAX_RESULTS` and `MAX_SEARCH_DAYS` bounds and
  state in the description that it can return fewer than `limit` per page;
  otherwise leave it out.

**4b. UTF-8.** Implement [utf8-search.md](utf8-search.md): IMAP literals with
`+` continuation handling and `SEARCH CHARSET UTF-8`, removing the ASCII-only
`invalid_criteria`. Probe first whether `imap.mail.me.com` accepts the `UTF-8`
charset and advertises `UTF8=ACCEPT`; if not, stop and record the finding in
that plan rather than guessing. When this lands, update the status line of
`utf8-search.md` to point here.

**Tests:** criteria builder snapshots (OR, NOT, nesting refused, over-long
arrays refused), `invalid_criteria` for unknown keys, literal framing in
`test/imap-parse.test.ts`, fake-server integration for 4b.

**Effort:** 4a S, 4b M. **Status:** 4a ready; 4b gated on the charset probe.

## 5. Mark unread and flag

**What:** `read_mail` only sets `\Seen`. Add one tool that sets or clears
exactly two flags on one message:
`set_mail_flag({ mailbox, uidValidity, uid, flag: "seen" | "flagged", value })`.
`seen: false` is "mark unread". Keep `read_mail` unchanged for compatibility.

**Contract:**

- Scope `mail:modify`. Idempotent; safe to repeat after a timeout, like
  `read_mail`.
- The command is built by a function beside `buildStoreSeen` in
  `src/imap-mutations.ts`: `UID STORE <uid> +FLAGS.SILENT (\Seen)` or
  `-FLAGS.SILENT (\Flagged)`, with the flag taken from a two-value whitelist.
  No other flag, no bare `STORE`, no `EXPUNGE`.
- One message per call, source mailbox must be in `ALLOWED_MAILBOXES`,
  `uidValidity` checked, missing message gives `message_not_found`.
- Audit: a `mail_mutation` line with action `flag`, mailbox, uid, flag and
  value. No subject, no body.
- Residual risk, to state in README: an injected instruction can mark messages
  read or unread or flag them, which can hide a message. It is reversible and
  audited; bulk is deliberately absent (see not-planned).

**Tests:** both flags both directions, other flags preserved, whitelist refusal,
`uidvalidity_mismatch`, `message_not_found`, scope refusal, no command is sent
for an invalid flag.

**Effort:** S. **Status:** ready.

## 6. Event reminders (`VALARM`)

**What:** let `create_event` and `update_event` set up to 2 display alarms, and
let `get_event` show an event's alarms. Today a created event never carries a
`VALARM` and an update preserves existing ones
([calendar-reminders.md](calendar-reminders.md) records why a naive overwrite
destroys them). These are the alarms of an event, not the Reminders app, which
lives in CloudKit and stays out of scope.

**Probe first** on `Scratch` with a disposable event: write one `VALARM`
(`ACTION:DISPLAY`, `DESCRIPTION`, `TRIGGER:-PT30M`), read it back, and confirm
iCloud keeps it unchanged, does not add or rewrite alarms of its own, and the
alert actually appears on a device. Do not rely on RFC 5545 alone.

**Contract:**

- Input `alarms: [{ minutesBefore }]`, at most 2, `minutesBefore` an integer
  from 0 to 10080 (one week). Written as `ACTION:DISPLAY`, a fixed
  `DESCRIPTION`, relative `TRIGGER` before the start.
- `update_event`: `alarms` omitted preserves every existing alarm, as today. An
  array replaces only the alarms this tool can describe (display, relative,
  before start); any other alarm (audio, absolute, location-based, Apple `X-`
  alarms) is preserved untouched. `alarms: []` removes only the describable
  ones.
- `get_event` returns each alarm as `{ minutesBefore }` when representable,
  else `{ kind: "other" }`.
- Same `calendar:write` scope, ETag rules, limiter and audit line; the alarm
  text and minutes are not logged.

**Implementation:** `src/calendar-write.ts` (the guard at the
`unsupported_field` refusal for `VALARM` is replaced by this path),
`src/ical.ts` (alarm parsing exists around the `alarmComponents` read),
`src/mcp.ts` and `src/rest.ts` schemas, README Writes section ("never writes ...
VALARM").

**Tests:** create with 0, 1, 2 alarms; 3 refused; range refusal; update
preserves an Apple `X-` alarm and an audio alarm; `[]` removes only describable
alarms; `get_event` shape.

**Effort:** M. **Status:** ready, gated on the probe.

## 7. Basic recurrence on create

**What:** `create_event` accepts a simple repeat. Editing an occurrence and
"this and following" stay out (see not-planned).

**Contract:**

- `recurrence: { freq: "DAILY" | "WEEKLY" | "MONTHLY", interval?, byDay?,
  count? | until }`. Exactly one of `count` and `until` is required: no open-ended
  series. `interval` 1 to 12; `byDay` only with `WEEKLY`; caps
  `MAX_RECURRENCE_COUNT` (default 100) and an `until` at most two years out.
- Writes `RRULE` and nothing else about recurrence: no `RDATE`, `EXDATE`,
  `RECURRENCE-ID`.

**Two design problems this unit must solve (the owner wants recurrence
creation; the probe and tests decide how, not whether):**

1. **Time zones.** The writer stores timed values as UTC and never writes a
   `TZID` (README, Writes). A weekly 09:00 Rome series stored as UTC drifts an
   hour at each daylight-saving change. A recurring event is therefore written
   as `DTSTART;TZID=<iana>` with a `VTIMEZONE` (decided), and `src/tz.ts`
   deliberately does not depend on a `VTIMEZONE` block today. Probe on `Scratch`
   whether iCloud also accepts an IANA `TZID` without a `VTIMEZONE` (then the
   block is optional) and how it expands the series across a DST boundary.
   Otherwise generate the block from the zone's rules and test the transitions
   explicitly. One-off events keep the current UTC behaviour.
2. **Orphan series.** Recurring resources are read-only for `update_event` and
   `delete_event` today, so an agent could create a series it can never fix or
   remove. Creation therefore ships together with whole-series management, in
   the same release: `delete_event` gains `series: true` (scope
   `calendar:delete`, strong ETag, same refusals) and `update_event` is allowed
   on the master for non-recurrence fields (summary, location, description,
   alarms). Both apply only to a resource whose recurrence is a single simple
   `RRULE` with no `EXDATE`, `RDATE`, override or attendee; anything else stays
   read-only with `readOnlyReason`. Changing the recurrence itself on an
   existing series is not part of this unit (delete and recreate instead).

**Tests:** RRULE serialisation, cap refusals, `count`/`until` exclusivity, DST
boundary expansion read back through the existing recurrence cursor, series
delete and master update on a simple series, refusal when overrides or
`EXDATE` exist, `delete_event` with `series: true` on a simple series and the
unchanged refusal on an override or attendee series.

**Effort:** M for creation, plus M for the series delete/update it needs.
**Status:** ready, gated on the `Scratch` probe for the time-zone question.
Do not release creation without the series update and delete.

## Deployment and acceptance

Nothing deployed yet. Record here per unit: version id, `verifyDeployment`
tool count, and the live acceptance that was run.
