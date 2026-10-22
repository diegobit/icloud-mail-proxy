# Calendars over CalDAV

**Status (2026-10-22):** calendar-only, with an opt-in one-off event delete
tool added in the follow-up plan `plans/calendar-delete-event.md`. The legacy
CalDAV reminder surface was removed after the live probe showed it could not
reach the lists the owner actually uses. Calendars remain in production;
reminders are a separate future project.

**What:** let an agent read calendars and create, update or delete one-off
events through the same Worker, `/mcp` endpoint and OAuth consent used for
mail. Owner request (2026-10-21): *"leggo e creo calendari chiamando un tool
del server mcp, come faccio con le mail, magari anche da ChatGPT connesso al
plugin"*.

**What this is not:** a full CalDAV client. No invitations or replies (iTIP
scheduling), no sharing or ACL changes, no free/busy, no managed attachments,
no Contacts (CardDAV) or Notes. Deletion is limited to one non-recurring
`VEVENT` after a strong ETag check; there is no trash, and recurring or
scheduling resources stay read-only. The original release deliberately had no
deletion because CalDAV `DELETE` is immediate; the owner later asked for this
narrow tool. Reminders are not part of this surface.

## Why one deployment

The alternative was a second Worker with its own OAuth app and MCP connector.
It was rejected: one connector and one consent are simpler for the agent, the
same Apple app-specific password already grants CalDAV, and the OAuth, setup,
verify, error and audit plumbing is already paid for here. One endpoint still
has per-tool scope checks.

## Removed: legacy reminders

Apple moved the Reminders app to a CloudKit-backed store in iOS 13. CalDAV
`VTODO` only exposes lists that were never migrated. On this account the CalDAV
home had two legacy VTODO collections (`Casa SP⚠️` and `Reminders`), while the
Reminders app and iCloud web showed `Diego`, `AIT`, `Spesa`, `Spezia todo`,
`Icebox` and `Scratch`. A VTODO list created with `MKCALENDAR` and a reminder
created in the legacy `Reminders` list were visible to CalDAV and to the Worker
but never appeared in the Reminders app or iCloud web.

The reminder half therefore could not read or write the reminders the owner
uses. The owner approved removing it rather than shipping a misleading
legacy-only tool. Removed in this branch:

- `list_reminder_lists`, `list_reminders`, `get_reminder`, `create_reminder`,
  `update_reminder`, `complete_reminder`;
- the reminder REST routes and their schemas;
- `ALLOWED_REMINDER_LISTS`, `REMINDERS_WRITE`, `MAX_REMINDERS`;
- `reminders:read` / `reminders:write` scopes and consent copy;
- reminder setup/verify prompts and discovery;
- `src/calendar-reminders.ts`, `src/calendar-reminder-write.ts` and their
  tests;
- reminder documentation.

The generic iCalendar parser still understands `VTODO`; it is a library
capability, not an exposed integration. Calendar discovery requires `VEVENT`
and excludes mixed or VTODO-only collections.

## CloudKit exploration (2026-10-22)

A research pass asked whether the Worker could talk to CloudKit directly. It
cannot, on any supported path:

- CloudKit Web Services API tokens are minted by the container owner; nobody
  but Apple owns `com.apple.reminders`.
- Server-to-server keys are limited to the public database; Reminders is in the
  private database.
- Web auth tokens require an interactive Apple ID login and expire.
- The private reverse-engineered clients (iCloud session cookies, SRP/2FA, PCS)
  are brittle, ToS-risky, and lose CRDT, attachment and recurrence fidelity.

**Recommendation:** keep the Worker as the single MCP/OAuth surface and put a
small macOS EventKit companion behind a Cloudflare Tunnel + Access service
token. The Worker would proxy reminder tools to it. This is a separate project:
the Mac must stay online, and TCC permission attribution under launchd is the
top risk. It is not part of this PR.

## Verified on the live account

`scripts/probe-caldav.mjs` reproduces the read-only probe; it allows only
`PROPFIND`, `REPORT`, `OPTIONS`, `GET` and `HEAD`, and validates every
response-derived URL against the discovered origin and path before attaching
credentials.

| Probe | Result |
| --- | --- |
| `PROPFIND /` → `current-user-principal` | 207; `/<dsid>/principal/` |
| `PROPFIND principal` → `calendar-home-set` | 207; absolute URL on the shard host |
| `PROPFIND home` Depth 1 | 207; account home, five calendars, two legacy VTODO collections, and `inbox` / `notification` / `outbox` with no display name |
| Component sets | `Lavoro`, `Personale`, `Casa SP`, `Spesa Belun`, `Scratch` = `VEVENT`; `Casa SP⚠️`, `Reminders` = `VTODO`; `outbox` advertises both |
| Component-set XML | Apple writes `name='VEVENT'` with single quotes — a double-quote-only parser silently sees zero components |
| Home collection itself | Has a display name and advertises `VEVENT, VTODO, VFREEBUSY`, but its `resourcetype` is collection-only. Display name + components is not enough. |
| `C:calendar-data/c:expand` | Ignored; two requests differing only by `expand` returned byte-identical bodies (1,814,924 bytes). Client-side expansion is mandatory. |
| Local start forms | Of 610 VEVENTs: 397 `TZID`, 95 `Z`, 115 `VALUE=DATE`. All three are common. |
| ETag | Strong and quoted (`"mq7p46um"`); resource names are `<UUID>.ics`. |
| `calendar-multiget` | Returns `getetag` + `calendar-data` in one round trip. |
| `PROPFIND` on a resource | Returns `getetag` but not `calendar-data`. |
| `OPTIONS` | `calendar-access`, `calendar-schedule`, `calendar-auto-schedule`, … |

Three consequences drive the design: `expand` is unavailable, so recurring
masters are expanded in the Worker; the server filter narrows but does not
guarantee, so overlap is re-checked client-side; and writes must be
read-modify-write, because a resource can carry a `VTIMEZONE`, `VALARM` and
Apple properties that a naive overwrite would destroy.

## Surface

With calendars enabled and writes off, the Worker exposes 11 tools: eight mail
tools plus `list_calendars`, `list_events`, `get_event`. With
`CALENDAR_WRITE=1` it adds `create_event`, `update_event` and `delete_event`,
for 14.

| Tool | Scope | Enabled by |
| --- | --- | --- |
| `list_calendars`, `list_events`, `get_event` | `calendar:read` | `ALLOWED_CALENDARS` |
| `create_event`, `update_event`, `delete_event` | `calendar:write` | `ALLOWED_CALENDARS` + `CALENDAR_WRITE=1` |
| the eight mail tools | `mail:read` | always |

The static bearer reaches every enabled tool. OAuth grants hold the scopes the
owner selected on the consent page; `calendar:write` implies `calendar:read`.
An older grant holding only `mail:read` must reconnect before using calendars.

## Design

### Transport (`src/caldav.ts`)

- Bootstraps at `https://caldav.icloud.com/`, follows
  `current-user-principal` and `calendar-home-set` to the account shard, and
  pins every later request to the discovered origin and home path.
- Refuses redirects, encoded path separators, control characters and
  non-absolute hrefs; requires a strong quoted ETag for updates and deletes.
- Uses Cloudflare `fetch` with a timeout, a response-size cap and no caching.
- `calendar-query` and `calendar-multiget` REPORTs; single-resource GET;
  PUT with `If-None-Match: *` for create or `If-Match` for update.

### Parsing and recurrence (`src/ical.ts`, `src/calendar-time.ts`)

- One VCALENDAR contains one component type; the calendar path reads VEVENT
  only. A resource mixing VEVENT and VTODO is rejected.
- Handles `Z`, floating and `VALUE=DATE` values, and `TZID` values known to the
  platform `Intl` database, including the IANA identifiers Apple normally
  writes; `Europe/Rome` is the default. Embedded `VTIMEZONE` definitions are
  preserved on update but are not interpreted, so a custom `TZID` that `Intl`
  cannot resolve stays unresolved.
- Recurrence is expanded with a bounded cursor over the requested window, not
  `ical.js`'s iterator. `RRULE`, `RDATE`, `EXDATE`, `RECURRENCE-ID` and
  overrides are supported; candidate counts are capped per rule and per
  request.
- Monthly and yearly rules use local wall-clock arithmetic, not fixed
  milliseconds, so DST changes and month lengths stay correct.
- A floating or unresolved `TZID` value names no instant: it is excluded from
  range results but remains visible in `get_event` with
  `timeZoneUnresolved: true`.

### Discovery and allowlists (`src/calendar-core.ts`)

- A collection is a calendar only when `resourcetype` contains
  `C:calendar`, it has a display name, and its component set contains VEVENT
  without VTODO. This excludes the home collection, pseudo-collections,
  reminder lists and mixed collections.
- `ALLOWED_CALENDARS` is a comma-separated list of exact display names or `*`
  alone. Empty disables the domain. A name outside the allowlist returns
  `calendar_not_allowed`; a configured name with no match fails closed with
  `configured_calendar_missing`; duplicates return
  `ambiguous_calendar_name`.
- `?all=1` is the static-bearer-only bootstrap view used by setup. It returns
  every discovered calendar before allowlist filtering and works while the
  domain is disabled.

### Reads

- `list_events` takes a calendar name and a `[from, to)` window; `from`
  defaults to today in `Europe/Rome`, `to` to seven days later.
- `MAX_CALENDAR_DAYS` (90), `MAX_RESOURCES_PER_QUERY` (300),
  `MAX_EVENT_RESULTS` (50), `MAX_RESOURCE_BYTES` (262144) and
  `MAX_RESPONSE_BYTES` (4194304) bound the work. A too-wide window is
  `range_too_wide`; too many resources is `too_many_resources`; a truncated
  result says whether the result cap or a recurrence budget cut it.
- Results are occurrences sorted by start. Each carries `collectionId`,
  `resourceId`, `uid`, `recurrenceId`, wall clocks, zone, all-day flag,
  `isOverride` and `readOnlyReason`.
- `get_event` returns the master detail, the ETag and all overrides. Recurring
  and scheduling resources are readable but read-only in v1.

### Writes

- `create_event` accepts structured fields only, generates a UUIDv4 resource
  unless the caller supplies an id, and uses `If-None-Match: *`. A retry that
  hits the same id returns `already_exists`.
- `update_event` requires the exact strong ETag from `get_event`, re-reads the
  resource, refuses recurring or scheduling resources, and uses `If-Match`. A
  stale tag is `409 conflict`.
- `delete_event` requires the exact strong ETag, re-reads the resource,
  refuses recurring, scheduling and non-VEVENT resources, and sends `DELETE`
  with `If-Match`. Deletion is immediate; there is no trash.
- Serialization is UTC or `DATE` only. No `TZID`, `RRULE`, `RDATE`, `EXDATE`,
  `ATTENDEE`, `ORGANIZER` or `VALARM` is ever written. An existing `VALARM` is
  preserved by read-modify-write.
- A PUT or DELETE whose response never arrived returns
  `mutation_state_unknown`; the caller must reconcile with `get_event`, never
  blind-retry.
- `CALENDAR_WRITE_LIMITER` allows 30 writes per minute per connecting IP. A
  missing binding fails closed.
- Each attempt writes one `calendar_write` audit line with principal, action,
  calendar id, resource id and outcome — never the summary, description or
  location.

### Scopes and consent

- Scopes are `mail:read`, `calendar:read`, `calendar:write`,
  `offline_access`.
- `calendar:write` implies `calendar:read`; the stored grant is never widened.
- The consent page offers only the scopes the deployment enables and
  preselects what the client requested. The owner may deselect.
- The static bearer is the owner and holds every enabled scope.

### REST

- `GET /v1/calendars[?all=1]`
- `GET /v1/calendars/:calendar/events`
- `GET /v1/calendars/:calendar/events/:id`
- `POST /v1/calendars/:calendar/events`
- `PUT /v1/calendars/:calendar/events/:id`
- `DELETE /v1/calendars/:calendar/events/:id` (requires `If-Match`)

Same bodies and error codes as the MCP tools. Write routes answer
`404 not_supported` when `CALENDAR_WRITE` is off. `/v1/reminder-lists` no
longer exists.

## Status

- Calendar implementation, tests, typecheck and bundle: green before the
  reminder removal.
- Reminder removal: source, tests, setup/verify, docs and config updated;
  final local suite 651 tests / 35 files, typecheck and bundle clean.
- Production calendar acceptance (pre-removal version): create, rename, stale
  ETag conflict, recurring refusal and scheduling refusal all passed against
  `Scratch`. The acceptance event remains on `Scratch`; the original release
  had no delete tool.
- Calendar-only release deployed to production as version
  `05264555-f39e-4e6b-b684-33b7f26435f3`. The live surface is 13 tools with
  `CALENDAR_WRITE=1`; writes off would be 11. `verifyDeployment` passed and
  `/v1/reminder-lists` returns 404.
- Codex review at `b7c2648` requested changes; all findings are fixed in
  `1a5c7aa` with regression tests: IMAP failures after COPY are
  `mutation_state_unknown`; `STATUS:CANCELLED` occurrences are hidden from
  lists and exposed in the detail; DST-gap instances are skipped without
  consuming `COUNT`; day/week `DURATION` is nominal; a yearly ordinal `BYDAY`
  intersects `BYMONTHDAY`; lookback follows the bounded event duration; the
  OAuth provider cache is keyed by origin and scope profile; and verify rejects
  unknown tools. The local suite is 664 tests / 35 files, typecheck and bundle
  clean; CI is green at `1a5c7aa`.
- The fixed branch is redeployed as production version
  `55d4b277-24c8-48e4-910b-5bef3201a4a7`; `verifyDeployment` passed with 13
  tools, five calendars and `list_events`, and `/v1/reminder-lists` is still
  404.
- A second Codex review at `afe5c75` confirmed all eight findings fixed and
  requested two corrections: the plan overstated custom `VTIMEZONE` support,
  and the IMAP mutation tests swallowed scripted-server assertion failures.
  Both are fixed in `535695d`; a final review at `535695d` returned `APPROVED`
  with no new findings. CI is green at `535695d`.
- `535695d` changes only the plan and tests, so production remains on the
  runtime from `1a5c7aa` (version `55d4b277-24c8-48e4-910b-5bef3201a4a7`);
  no redeploy was needed.
- Final acceptance: the owner confirmed the `Scratch` event is visible on the
  iPhone at 2026-10-23 10:00 `Europe/Rome`. The narrowed-grant OAuth behavior
  was verified against a local worker running the same OAuth flow: a
  `mail:read` grant answers `insufficient_scope` for `list_events`, while
  reconnecting with `mail:read calendar:read` passes the scope check. PR #11 is
  ready to merge.

## Verification log

- 2026-10-21, read-only probe: discovery 207/207, `expand` byte-identical,
  strong quoted ETags, `calendar-multiget` returns data, 610 VEVENTs across all
  three start forms.
- 2026-10-22, local: calendar and reminder implementation green; later
  reminder removal left 35 test files / 651 tests passing, typecheck clean.
- 2026-10-22, production (version
  `69444862-313c-4d52-91d2-aa769438a974`): `verifyDeployment` passed, including
  `?all=1` and the 7-day `list_events`, with 19 tools. Created a one-off event
  on `Scratch` for 2026-10-23 10:00 `Europe/Rome`; the API returned
  `10:00+02:00` and `get_event` showed `08:00Z`. Renamed it; a stale ETag
  returned `409 conflict` and left the summary unchanged. `update_event`
  refused a recurring `Lavoro` resource and a scheduling resource; both were
  unchanged after the refusal.
- 2026-10-22, reminder blocker: the owner's Reminders lists are CloudKit-only;
  CalDAV reaches only legacy VTODO lists. Reminder surface removed.
- 2026-10-22, CloudKit research: no supported Worker-only path; recommended a
  macOS EventKit companion behind Cloudflare Tunnel + Access as a separate
  project.
- 2026-10-22, calendar-only production deploy: `verifyDeployment` passed with
  13 tools, OAuth metadata, `?all=1` (five calendars), a seven-day
  `list_events` on `Scratch`, and a 404 on `/v1/reminder-lists`. CI on the PR
  is green at head `0300cd6`.
- 2026-10-22, Codex review fixes: regression tests cover every finding; the
  full suite is 664 tests / 35 files, with typecheck and bundle clean. CI is
  green at `1a5c7aa`.
- 2026-10-22, redeploy after review fixes (version
  `55d4b277-24c8-48e4-910b-5bef3201a4a7`): `verifyDeployment` passed with 13
  tools, OAuth metadata, `?all=1` (five calendars), a seven-day `list_events`
  on `Scratch`, and a 404 on `/v1/reminder-lists`.
- 2026-10-22, second and final Codex reviews: round 2 at `afe5c75` found two
  documentation/test issues; both were fixed in `535695d`. The final review
  returned `APPROVED` with no new findings; 664 tests / 35 files and typecheck
  are clean, and CI is green at `535695d`.
- 2026-10-22, final acceptance: the owner confirmed the iPhone event. A local
  worker using the same OAuth flow returned `insufficient_scope` for a
  `mail:read` grant on `list_events`, then passed the scope check after
  reconnecting with `mail:read calendar:read`. PR #11 is ready to merge.
- 2026-10-22, follow-up: the owner asked for a delete tool. `delete_event` is
  specified in `plans/calendar-delete-event.md`; with writes on the surface is
  14 tools, and 11 with writes off. It deletes one non-recurring `VEVENT` after
  a strong ETag check; recurring/scheduling resources and `VTODO` cleanup remain
  out of scope, and there is no trash.

## Open items

- Optional cleanup of CalDAV-only test artifacts: the `MCP Acceptance` VTODO
  list and its reminder, the legacy `Reminders` test reminder, and
  `acceptance-reminder-2026-10-24` / `mcp-test-2026-10-23`. They do not appear
  in the Reminders app. `delete_event` cannot remove VTODO resources; cleanup
  remains a direct CalDAV or Apple Calendar action.
