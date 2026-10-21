# Calendars and reminders over CalDAV

**What**: let the agent read calendars and reminders and create or update them,
through the same Worker, the same `/mcp` endpoint and the same OAuth consent it
already uses for mail. Owner request (2026-10-21): *"leggo e creo calendari
chiamando un tool del server mcp, come faccio con le mail, magari anche da
ChatGPT connesso al plugin"*.

**What this is not**: a full CalDAV client. No invitations or replies (iTIP
scheduling), no sharing or ACL changes, no free/busy, no managed attachments,
no location reminders, no subtasks/sections/tags, no deletion, no Contacts
(CardDAV) or Notes. Deletion is deliberately absent because CalDAV `DELETE` is
immediate — unlike mail there is no trash — and the owner asked for read and
create, not removal.

## Why one deployment and not a second project

The alternative was a new `icloud-calendar-proxy` with its own Worker, OAuth app
and MCP connector. It was rejected for the reason that already superseded
`plans/outbound-send-proxy.md` with `plans/email-send.md`: the isolation it buys
is mostly imaginary and the cost is real.

- **One connector, one consent.** In ChatGPT a connector *is* an MCP server.
  Two projects mean two entries in Settings → Connectors, two grants, two tokens
  to rotate, and a model correlating two tool namespaces for the request that
  matters most ("put a reminder on this email").
- **The Apple credential is shared anyway.** One app-specific password grants
  mail, calendars and reminders at Apple's side. A second Worker does not
  isolate it unless a *second* password is also created — which can be done for
  this Worker just as well.
- **The plumbing is already paid for.** OAuth + PKCE + epoch + consent
  (~540 lines), guided setup and verify (~1,900), deploy profiles, the error
  model, the annotation and audit conventions all apply unchanged.
- **The boundary already moved.** `email-send.md` added SMTP and
  `mailbox-mutations.md` added MOVE-class operations; the Worker is no longer a
  read proxy, so "keep the read proxy pure" can no longer be argued.

One endpoint, per-tool scope checks. Split routes remain a fallback for tool
count, not for authorization: `@cloudflare/workers-oauth-provider` 1.2.3 accepts
`apiHandlers: Record<route, handler>` instead of `apiRoute` + `apiHandler`, but
every handler in that map shares one resource-server configuration —
`requiredScopes` and `scopesSupported` are provider options, not per-route
(verified in `dist/oauth-provider.js:2634–2685`). Splitting would separate tool
surfaces, not scope policies; real per-route policies need separate
resource-server composition and separate audience metadata, which is not worth
it here.

## Verified on the live account (2026-10-21, read-only)

`scripts/probe-caldav.mjs` reproduces this; it refuses any method outside
`PROPFIND`, `REPORT`, `OPTIONS`, `GET`, `HEAD`, and validates every
response-derived URL against the discovered origin and path before attaching
credentials. Nothing was created, modified or deleted. `<dsid>` replaces the
numeric account segment.

| Probe | Result |
| --- | --- |
| `PROPFIND /` → `current-user-principal` | 207; `/<dsid>/principal/` |
| `PROPFIND principal` → `calendar-home-set` | 207; absolute URL on the shard host, `https://pNN-caldav.icloud.com:443/<dsid>/calendars/` |
| `PROPFIND home` Depth 1 | 207; 10 entries: the account home, 6 calendars/reminder lists, and `inbox`, `notification`, `outbox` with no display name |
| Component sets | `Lavoro`, `Personale`, `Casa SP`, `Spesa Belun` = `VEVENT`; `Casa SP⚠️`, `Reminders` = `VTODO`; `outbox` advertises both |
| **VTODO exists** | Yes: `Casa SP⚠️` returns 3 VTODO resources. The iOS 13 CloudKit migration did not hide reminders on this account. |
| Component-set XML | Apple writes `name='VEVENT'` with **single quotes** — a double-quote-only parser silently sees zero components |
| Home collection itself | Has a display name and advertises `VEVENT, VTODO, VFREEBUSY`, but its `resourcetype` is `collection` only. Display name + components is **not** enough to identify a calendar. |
| `PROPFIND` Depth 0 on a collection | `getctag`, `calendar-color`, `current-user-privilege-set` (`read`, `write`, `write-properties`, `write-content`, `bind`, `unbind`), `supported-calendar-data`; `max-resource-size` arrives in a **404 `propstat`** |
| Time-range filter | Works: `Lavoro` has 549 resources total, 41 overlapping 2020–2030, 0 in the next 30 days (the calendar is dormant) |
| `C:calendar-data/c:expand` | **Ignored.** Two identical requests differing only by `<c:expand start="20260101T000000Z" end="20261231T000000Z"/>` returned **byte-identical** bodies (1,814,924 bytes), same 549 resources / 610 VEVENTs / 150 event RRULEs / 62 RECURRENCE-ID. Client-side expansion is mandatory. |
| Rule shapes on that calendar | The 150 event rules are **all `FREQ=WEEKLY`**; 14 carry `BY*` parts, 141 `UNTIL`, 9 `COUNT`. The 3,376 `FREQ=YEARLY` lines in the response belong to **VTIMEZONE**, not events — a naive count over the whole body is off by 20×. |
| Local start forms | Of 610 VEVENTs: 397 `DTSTART;TZID=`, 95 `DTSTART:…Z`, 115 `DTSTART;VALUE=DATE:`. All three are common, none is an edge case. |
| VTODO and time-range | 3 resources without a filter, **0** for Oct–Nov 2026. The server applied *something*; whether undated items are dropped is unknown (RFC 4791 §9.9 matching also considers `CREATED`/`COMPLETED`), so v1 queries unfiltered and filters client-side. |
| ETag | Strong and quoted: `"mq7p46um"`; resource names are `<UUID>.ics` |
| `GET <resource>.ics` | 200, `text/calendar; charset=UTF-8`, full VCALENDAR |
| `PROPFIND` on a resource | Returns `getetag` but **not** `calendar-data` |
| `calendar-multiget` | Returns `getetag` + `calendar-data` in one round trip |
| iCalendar shape | `PRODID:-//Apple Inc.//macOS 26.5.1//EN`, `TZID=Europe/Rome`, sometimes an embedded VTIMEZONE with historical `STANDARD`/`DAYLIGHT` blocks, VALARMs, `X-APPLE-CREATOR-TEAM-IDENTITY` |
| `OPTIONS` | `DAV: 1, access-control, calendar-access, calendar-schedule, calendar-auto-schedule, …` |

Three consequences drive the design: **`expand` is unavailable**, so every range
query fetches recurring masters and expands them in the Worker; **the time-range
filter narrows but does not guarantee** (masters whose first instance is years
old come back, and VTODO matching is not fully specified), so results are
re-checked client-side; and **writes must be read-modify-write**, because a
resource can carry a VTIMEZONE, VALARMs and Apple properties that a naive
overwrite would destroy.

## Decisions for the owner before implementing

Answered by the owner on 2026-10-21:

1. **Allowlists — everything.** Both domains use the `*` value: every
   collection that passes the `resourcetype` + display-name filter is allowed,
   including `Spesa Belun` (shared) and calendars or lists created later. `*`
   is an explicit opt-in; an empty value still disables the domain, so a fresh
   deployment never exposes calendars by accident. Writes to a shared
   collection are visible to the other people immediately.
2. **Writes — on at first deploy.** `CALENDAR_WRITE=1` and
   `REMINDERS_WRITE=1` from the first production deploy. Acceptance still runs
   against the scratch targets first; the write-gating checks run in
   `wrangler dev` with the flags at `0`, not by turning production off and on.
3. **Scratch targets.** The `Scratch` calendar is visible over CalDAV. The
   `Scratch` reminder list was created in the app but is not yet visible to the
   probe (checked twice on 2026-10-21, before and after a 20 s wait); re-check
   before the reminder acceptance, since iCloud may not have synced it yet.
   No acceptance write touches `Lavoro`, `Personale`, `Casa SP` or
   `Spesa Belun`.
4. **Zone names.** `Europe/Rome` is the default when the caller omits
   `timeZone`.

Everything else (description only in `get_event`, completed reminders excluded
by default, UTC serialization for writes, recurring resources read-only) is an
engineering default recorded below, not a question for the owner.

## Design

### `src/caldav.ts` — transport

```ts
export class CalDavError extends Error {
  status: number;        // 0 for a transport failure
  code: string;          // unauthorized | forbidden | not_found | conflict |
                         // too_many_resources | recurrence_too_complex |
                         // mutation_state_unknown | upstream_error | malformed
  davStatus?: string;    // e.g. "HTTP/1.1 412 Precondition Failed"
}

export interface CalDavOptions { fetchImpl?: typeof fetch; timeoutMs?: number }
export function createCalDav(env: Env, options?: CalDavOptions): CalDav
```

- `fetch` with `Authorization: Basic base64(ICLOUD_USER:ICLOUD_APP_PASSWORD)`,
  `redirect: "manual"`, `AbortSignal.timeout(CALDAV_TIMEOUT_MS)`. A 301/302 on a
  CalDAV request means the shard moved: drop the discovery cache, re-discover
  once, retry once; never follow the redirect with credentials attached.
- **Destination validation happens in two phases**, because the principal lives
  outside the calendar home and the home is unknown during bootstrap:
  1. *Bootstrap* — only `https://caldav.icloud.com`, and only two requests: the
     root and the exact principal path Apple returns (`/<dsid>/principal/`).
     After the principal is parsed the bootstrap exception is narrowed from `/`
     to that path by **equality**, not prefix — `/dsid/principal/anything` is
     refused; nothing else may carry credentials.
  2. *Pinned* — the `calendar-home-set` is validated **before** it is trusted:
     `https:`, port 443, no userinfo, a hostname matching
     `^p\d+-caldav\.icloud\.com$`, no encoded separators (`%2e`, `%2f`, `%5c`),
     a trailing-slash directory, and a path that is exactly the principal's
     account calendars directory — `/<dsid>/calendars/` derived from the
     principal's own `/<dsid>/principal/`. Only then is the origin pinned, and
     every later URL must be on that origin with a path under that home.
  A host allowlist alone is not enough: `*.caldav.icloud.com` does **not** match
  the real shard `p42-caldav.icloud.com`, and pinning whatever host a response
  names would hand the Basic credential to that host. `scripts/probe-caldav.mjs`
  implements exactly these checks, including the dsid-derived home path.
- Discovery: root → `current-user-principal` → principal →
  `calendar-home-set`. Memoized per isolate in a capped map (user → URLs, TTL
  10 minutes). Only URLs, never content, so the no-cache stance of
  `plans/kv-message-cache.md` still holds.
- Response reading is bounded before parsing: stop the stream past
  `MAX_RESPONSE_BYTES`, refuse a `Content-Length` above it, and reject a body
  containing `<!DOCTYPE` or `<!ENTITY` before handing it to the parser.
- Pure request builders exported for byte-exact tests: `propfind(props, depth)`,
  `calendarQuery({ component, timeRange })`, `calendarMultiget(hrefs)`,
  `putResource(href, ics, etag)`, `resourcePath(collectionId, uid)`.
- `.ics` bodies are `text/calendar; charset=utf-8`; `If-None-Match: *` on
  create, `If-Match: <etag>` on update.

### XML parsing

No DOM in Workers (`HTMLRewriter` is HTML, not XML), so add `fast-xml-parser`
(pure JS, no network, no code generation) with `ignoreAttributes: false`,
`removeNSPrefix: true`, `parseTagValue: false`, `parseAttributeValue: false`,
`processEntities: true`, `htmlEntities: false`, `trimValues: false`.

Traps the probe already exposed, each with a test:

- fast-xml-parser collapses a single child to an object; `response`, `propstat`
  and `comp` must be normalised to arrays.
- A collection can carry two `propstat` groups, one `200` and one `404`
  (`max-resource-size` was in the 404 one). Only properties from a 2xx group may
  be read.
- Attribute quoting is not uniform: match `name="VEVENT"` and `name='VEVENT'`.

### Identity, ids and allowlists

`list_calendars` returns, for every allowlisted collection:

```json
{ "id": "3ED435B2-…", "name": "Lavoro", "kind": "calendar", "color": "#91DAC2FF", "readOnly": false }
```

A collection is usable only if its `resourcetype` contains `C:calendar`, it has
a display name, and its component set matches the domain (`VEVENT` for
calendars, `VTODO` for reminders). That triple excludes the home collection
(collection only) and the `inbox`/`notification`/`outbox` pseudo-collections
(no display name).

`id` is the collection's last path segment. Config allowlists by **name**, as
`ALLOWED_MAILBOXES` does, and the name is resolved against the discovered
collections on every request: zero matches is `configured_calendar_missing`,
more than one is `ambiguous_calendar_name`, both fail closed.

Event and reminder ids are the resource filename without `.ics` — a UUID in
practice, stable across renames. They are validated against
`^[A-Za-z0-9._-]{1,128}$`, rejected if `.` or `..`, then percent-encoded. The
resolved href must stay under the selected collection's path.

Every occurrence returned by `list_events` carries its identity explicitly:
`{ collectionId, resourceId, uid, recurrenceId, readOnlyReason }`, where
`recurrenceId` is the original `RECURRENCE-ID` (null for a non-recurring event)
and `readOnlyReason` is `"recurring"` or `"scheduling"` when the resource may
not be mutated. A model that tries anyway gets an error naming both ids and
saying that neither instance nor series edits are supported, that retrying will
not help, and that the user must edit it in Apple Calendar.

### Time zones and recurrence

Apple stores `DTSTART;TZID=Europe/Rome:…` (397 of 610 VEVENTs on one calendar),
`DTSTART:…Z` (95) and `DTSTART;VALUE=DATE:…` (115). Reads must handle all three.
Writing is the hard part: `ical.js` bundles no IANA database, and
`ICAL.TimezoneService` is **global** — registering a zone for one request would
leak it into the next in the same isolate.

- `src/tz.ts` uses `Intl` only: `offsetMinutes(zone, instantMs)` via
  `Intl.DateTimeFormat(…, { timeZoneName: "longOffset" })`, and
  `wallClockToUtc(zone, parts)` following RFC 5545 §3.3.5 — an ambiguous
  wall-clock time resolves to the first occurrence, a skipped one is interpreted
  with the **UTC offset before the gap** (so `02:30` on a spring-forward day
  becomes `03:30` local), which is not the same as "the instant before the gap".
  Pure functions, tested on `Europe/Rome` and on a non-hour transition
  (`Australia/Lord_Howe`, 30 minutes).
- Reads keep the resource's own zone: `start` (ISO 8601 with offset, for
  comparisons), `startWall` and `timeZone`. If a `TZID` cannot be resolved
  (a retired or misspelled zone such as `Europe/Nowhere`) the event stays
  **floating**: `timeZoneUnresolved: true`, no absolute `start`, and it is
  excluded from range filtering rather than compared as if it were UTC. A
  floating time is never silently coerced into an instant.
- Recurrence expansion happens in wall-clock space for `TZID` events — which is
  what "every Monday at 09:00" means — and in UTC for `Z` events.
- **Writes are UTC or DATE only.** `create_event` accepts a wall clock plus an
  IANA zone and converts to UTC with `Intl`; it never emits a bare `TZID`
  without a VTIMEZONE, which Apple has not been shown to accept. Since v1
  forbids creating recurring events, the DST-drift objection to UTC storage does
  not apply: a one-off `10:00 Europe/Rome` is stored as `08:00Z` and rendered at
  10:00 by a client displaying the event in `Europe/Rome` (and at the
  corresponding time in any other zone the client is set to).

`src/ical.ts` wraps `ical.js` (exact version pinned; chosen over `node-ical`,
which drags in `rrule`, `luxon` and `moment-timezone`):

- `parseResource(ics)` uses `ical.js` as a component tree and property reader
  only: no `ICAL.Event`, no `ICAL.Time`, no `Timezone`/`TimezoneService`. Apple's
  VTIMEZONE blocks are preserved verbatim for round-trips but never used to
  resolve an instant; times are read as raw values plus `TZID` and converted in
  `src/tz.ts` with `Intl`. This keeps ical.js's recurrence machinery — which its
  `Timezone` type also uses internally — out of the request path entirely.
- `expandResource(parsed, { from, to })` → occurrences. The master's
  `RRULE`/`RDATE`/`EXDATE` drive the cursor described below; `RECURRENCE-ID`
  components replace the matching instance. `RANGE=THISANDFUTURE` is detected and the
  resource is reported as `unsupportedRange: true` rather than half-expanded.
- `mutateResource(ics, uid, mutate)` → read-modify-write that preserves
  VALARMs, X-properties, VTIMEZONE, `UID`, `DTSTAMP` and the `DTEND`/`DURATION`
  pairing. Creates build a minimal VCALENDAR (`PRODID` ours, `VERSION:2.0`,
  `CALSCALE:GREGORIAN`).
- **Expansion is ours, not `ical.js`'s iterator.** A cap on *results* does not
  bound computation, and `ical.js`'s `RecurIterator.next()` runs internal search
  loops that the caller cannot meter: `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` never
  finds a candidate, and `INTERVAL=2147483647` walks billions of steps inside a
  single `next()` (reproduced in review; no timer can preempt synchronous JS).
  So `ical.js` is used for **parsing and serializing only**, and occurrences are
  generated by a cursor over the query window — at most `MAX_CALENDAR_DAYS` (90)
  day steps, 3 month steps, or 1 year step per rule, no matter what the rule
  says. That is bounded by construction rather than by inspection.
- `COUNT`-limited rules are expanded from `DTSTART` and stop at `COUNT`, because
  a window cursor cannot know how many occurrences preceded `from`. `COUNT`
  bounds occurrences, not candidates: `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;
  COUNT=1000` scans ~1.5 million days to find its occurrences. The cursor
  therefore also counts **candidate** steps — 50,000 per rule and 200,000 per
  request — and stops with `recurrence_too_complex` (per rule) or
  `truncated: true, reason: "recurrence_budget"` (per request) before the scan
  can cost real CPU. `UNTIL` and unbounded rules use the window cursor and stop
  at the earlier of the window end and `UNTIL`.
- The accepted rule subset is what the generator implements
  (`FREQ` in `DAILY|WEEKLY|MONTHLY|YEARLY` with `INTERVAL` ≤ 52,
  `BYDAY` ≤ 7 values, `BYMONTHDAY`, `BYMONTH`, `COUNT` ≤ 1000, `UNTIL` inside
  ±10 years); everything else — sub-daily frequencies, `BYSETPOS`, `BYYEARDAY`,
  `BYWEEKNO`, `BYSECOND`, `BYMINUTE`, `BYHOUR`, out-of-range numerics,
  impossible intersections such as `BYMONTH=2;BYMONTHDAY=30` — is refused with
  `recurrence_too_complex` before any expansion. On this account that keeps 150
  of 150 event rules, all `WEEKLY`. `RDATE`/`EXDATE` lists are capped at 500
  entries each; a longer list is `recurrence_too_complex`, not a partial
  expansion.

### Reads

`list_events(env, { calendar, from, to, limit, text? })`:

1. reject a range wider than `MAX_CALENDAR_DAYS` with `range_too_wide`, and a
   missing `from` defaults to today;
2. one `calendar-query` REPORT with `(getetag, calendar-data)` and a
   `time-range`;
3. stop with `too_many_resources` if the multistatus announces more than
   `MAX_RESOURCES_PER_QUERY` — narrowing the range is the caller's fix;
4. refuse any single `calendar-data` over `MAX_RESOURCE_BYTES` rather than
   parsing it;
5. parse, expand, and keep occurrences whose interval **overlaps** `[from, to)`:
   `start < to && end > from`, with all-day ends exclusive, zero-duration events
   treated as a point, and floating times excluded from the comparison (see
   above);
6. optional `text` filter over summary and location only, case-insensitive;
7. sort by start, cap at `limit`, return `{ calendar, from, to, events, total,
   truncated }`.

`get_event` uses `calendar-multiget` for one href, which returns the ETag and
the data in a single round trip (`PROPFIND` does not return `calendar-data` on
iCloud). It returns the description, the recurrence rule as text and the next
occurrences inside a 90-day window from `from` (default today).

### Writes

- `create_event` → `PUT <collection>/<uuidv4>.ics`, `If-None-Match: *`. Fields:
  summary (≤200 chars), start/end wall clock plus `timeZone`, `allDay`,
  location, description (≤8 KB). `RRULE`, `RDATE`, `ATTENDEE`, `ORGANIZER`,
  `VALARM` and arbitrary properties are refused with `unsupported_field`. The
  serialized payload is validated again before the PUT, so a schedule-capable
  collection cannot be talked into receiving scheduling properties.
- `update_event` → requires the `etag` returned by `get_event`. The
  precondition contract is explicit:
  - exactly one opaque strong ETag, quoted; `W/`-prefixed (weak), `*`,
    comma-separated lists and malformed values are refused with `invalid_etag`;
  - the tag is preserved byte-for-byte, including quotes, and used verbatim in
    `If-Match`;
  - the resource is re-read before the PUT and its scheduling/recurring status is
    checked again — an event that gained an attendee in Apple Calendar since the
    last read is refused, not overwritten;
  - a 412 becomes `conflict: the event changed since you read it; call
    get_event again`, never a blind retry.
- A write whose request was dispatched and whose response never arrived returns
  `mutation_state_unknown`, not `upstream_error`: the server may have applied it.
  The caller reconciles with one `get_event` on the id it supplied.
- Idempotent creates: the caller may pass the `id` it wants. A retry that finds
  the resource already present (412 on `If-None-Match: *`) returns
  `already_exists` with that id, and the model is told to read and compare rather
  than create a second copy.
- **Recurring resources are read-only.** A resource with `RRULE`, `RDATE` or a
  `RECURRENCE-ID` component is refused for update with
  `recurring_not_supported`: updating the master silently changes every future
  occurrence, and editing one occurrence is a separate feature.
- **Scheduling resources are read-only.** If any component in the resource
  carries `ORGANIZER` or `ATTENDEE`, the update is refused with
  `scheduling_not_supported`. iCloud advertises `calendar-auto-schedule`, so a
  PUT or DELETE on such a resource can send invitations, updates or
  cancellations to third parties (RFC 6638). Existing events can carry those
  properties even though this client never writes them, and stripping them to
  "get around" the check would itself be a silent cancellation.
- `update_event` on an allowlisted collection that is not writable per
  `current-user-privilege-set` is refused, not attempted.

### Reminders

`VTODO` resources in the collections that advertise `VTODO` and have a display
name. `list_reminders` queries **without a time-range** and filters client-side:
open by default, `includeCompleted`, `dueFrom`/`dueTo`, cancelled excluded,
undated included. Server-side range filtering cannot be trusted to be a superset
(the probe returned 3 unfiltered and 0 for a 30-day window), and a client-side
filter cannot recover what the server already dropped, so v1 fetches the list
bounded by `MAX_REMINDERS` and returns `truncated` instead of a partial truth.

Mapping: `SUMMARY`, `DESCRIPTION`, `DUE` (date or date-time), `DTSTART` (the
"remind me on a day" time — note it is **not** an alarm and produces no push
notification), `PRIORITY` (0 none, 1 high, 5 medium, 9 low), `STATUS`
(`NEEDS-ACTION`/`COMPLETED`/`CANCELLED`), `COMPLETED`, `PERCENT-COMPLETE`.

`get_reminder` returns the notes (untrusted), the full field mapping and the
ETag needed by an update. `complete_reminder` is a read-modify-write with
`If-Match`: `STATUS:COMPLETED`, `COMPLETED:<now UTC>`, `PERCENT-COMPLETE:100`.
`update_reminder` un-completes by setting `STATUS:NEEDS-ACTION` and **removing**
both `COMPLETED` and `PERCENT-COMPLETE`, so a reopened reminder does not read as
100% done. Recurring VTODOs are read-only for the same reason as events.
Flagged state, sections, subtasks, tags, attachments and location alarms are not
represented; the tool description says a created reminder has a title, notes,
due date and priority.

### Scopes and consent

Today `src/oauth-authorize.ts:19` hardcodes `GRANTED_SCOPE = ["mail:read"]`,
used twice (`:230`, `:242`), and `src/index.ts:158` advertises
`scopesSupported: ["mail:read", "offline_access"]`.

Advertising is not enough: when an authorization request carries no `scope`,
the library stores an empty scope (`oauth-provider.js:5520`) and issuance uses
the application-supplied grant (`:5622`, `:3565`), so a client that asks for
nothing would never get write access no matter what the metadata says. The
consent page is therefore the source of truth:

- `scopesSupported`: `mail:read`, `calendar:read`, `calendar:write`,
  `reminders:read`, `reminders:write`, `offline_access`.
- The page **offers the deployment's enabled scopes** (read scopes for enabled
  domains, plus the write scopes whose flags are on), preselected with what the
  client requested, and the owner may deselect. The selection is passed to both
  `approveConsent` and `completeAuthorization` as `scope`, replacing both
  `GRANTED_SCOPE` uses. The library explicitly permits granting supported scopes
  beyond the original request (`:2200–2214`), which is what makes write reachable
  for a client that requested nothing.
- Narrowing is stored on the **grant**, not just on an access token: refresh
  cannot exceed the stored grant (`:3717`, `:4916–4918`). Integration tests
  cover a narrowed grant staying narrowed across refresh and an old read-only
  grant remaining read-only.
- `requiredScopes` stays the minimal advertised set for enabled domains and is
  used in the 401 challenge. It is not the mechanism that mints write.
- Per-tool checks live in one matrix function, `requireScope(authority, scope)`,
  called by every tool that needs one. `mail:read` remains the umbrella for all
  eight existing mail tools — including `send_mail` and `delete_mail` — because
  that is what existing grants carry. Splitting `mail:write` is a separate
  migration; the plan documents the wart rather than silently widening it.
- **The static bearer must keep working.** On the `resolveExternalToken` path the
  library sets `ctx.auth.scope = []` (`:4580–4584`), so a naive
  `scope.includes(...)` check would break every bearer client. Rule:
  `props.via === "bearer"` → owner, all scopes; otherwise check `ctx.auth.scope`
  with `calendar:write ⇒ calendar:read` and `reminders:write ⇒
  reminders:read`. Unit test included.
- The provider cache in `src/index.ts` is keyed by origin only. Because the
  offered scope set is a function of `env`, the cache key must include a small
  scope-profile fingerprint (which domains and write flags are enabled), or a
  config change would be pinned to the first origin's provider for the isolate's
  lifetime. `PROVIDER_LIMIT` then bounds origin × profile.
- Grants minted before this change hold `["mail:read"]`: calendar tools answer
  `insufficient_scope` until the owner reconnects and the consent page offers
  the new scopes. That is the intended path and is verified in acceptance, not
  assumed. The spec-compliant alternative — per-tool `securitySchemes` plus
  `_meta["mcp/www_authenticate"]` step-up, as OpenAI documents for plugins — is
  recorded as a later improvement, because client support is unverified and one
  POST can carry several tool calls.

Tool-to-scope inventory (19 tools: 8 existing, 11 new):

| Tool | Scope |
| --- | --- |
| `list_mailboxes`, `search_mail`, `get_mail_message`, `get_mail_attachment`, `archive_mail`, `delete_mail`, `send_mail`, `save_draft` | `mail:read` (umbrella, unchanged) |
| `list_calendars`, `list_events`, `get_event` | `calendar:read` |
| `create_event`, `update_event` | `calendar:write` |
| `list_reminder_lists`, `list_reminders`, `get_reminder` | `reminders:read` |
| `create_reminder`, `update_reminder`, `complete_reminder` | `reminders:write` |

### Config, `Env` and the write bound

`ALLOWED_CALENDARS`, `ALLOWED_REMINDER_LISTS` (comma-separated names, or `*`
for every collection that passes the discovery filter), `CALENDAR_WRITE`,
`REMINDERS_WRITE` (`"1"`/`"0"`), `MAX_CALENDAR_DAYS` 90, `MAX_EVENT_RESULTS` 50,
`MAX_REMINDERS` 200, `MAX_RESPONSE_BYTES` 4194304, `MAX_RESOURCE_BYTES` 262144,
`MAX_RESOURCES_PER_QUERY` 300, `MAX_OCCURRENCES_PER_RESOURCE` 200,
`MAX_RDATE_EXDATE` 500, `MAX_RECURRENCE_CANDIDATES_PER_RULE` 50000,
`MAX_RECURRENCE_CANDIDATES_PER_REQUEST` 200000, `CALDAV_TIMEOUT_MS` 15000.
Defaults live in `wrangler.base.jsonc` and are documented in `DEPLOY.md`.
`*` must be written literally and alone; a mixed value like `*,Lavoro` is a
config error, not a superset. Names are trimmed, compared case-sensitively, and
a name that matches nothing is ignored (it may belong to another device).
An empty or absent value disables the domain: no tools, no routes, no scopes.

Writes get a real bound, not just an audit line: a `ratelimits` binding
`CALENDAR_WRITE_LIMITER` (30 requests/minute per connecting IP) gates the write
tools when writes are enabled, mirroring the OAuth limiters. It is per IP, not
per principal, and the single-owner deployment makes that acceptable; the audit
trail is the second line.

### REST

Mirrors the MCP surface: `GET /v1/calendars`, `GET
/v1/calendars/:calendar/events`, `GET|PUT /v1/calendars/:calendar/events/:id`,
`POST /v1/calendars/:calendar/events`, `GET /v1/reminder-lists`, `GET|POST
/v1/reminder-lists/:list/reminders`, `GET|PUT
/v1/reminder-lists/:list/reminders/:id`, `POST
/v1/reminder-lists/:list/reminders/:id/complete`. Same bodies, same error
envelope. No DELETE routes.

Bootstrap exception: `GET /v1/calendars?all=1` and `GET
/v1/reminder-lists?all=1`, reachable **only** with the static bearer, return
every collection's name, kind, colour and id *before* allowlist filtering, with
no event content. Setup needs this to offer choices: without it, discovery
either returns nothing (empty allowlist disables the domain) or only what is
already allowed, so a new deployment could never configure the feature.

### Errors and audit

`CalDavError` maps into the existing envelope via `mapError` in `rest.ts` and
`guard()` in `mcp.ts`. A transport failure before dispatch is `upstream_error`;
after dispatch it is `mutation_state_unknown` for writes. Apple's 401/403 is
`upstream_unauthorized` (message: the app-specific password may have been
revoked); 412 is `conflict`; a malformed multistatus is `malformed`, never a
silent empty list.

One `console.log` line per write with the principal, action, calendar id,
resource id and outcome — including `conflict` and `mutation_state_unknown`, so a
failed write is visible too — and no summary, description or raw upstream body.
Console-only history is not durable; `wrangler tail` shows it live and nothing
archives it, which matches the mailbox-mutations convention and is stated in the
README.

## Security

- **Untrusted content.** Event summaries, descriptions, locations and reminder
  notes can be written by anyone who invites the owner or shares a list. They are
  third-party content with the same standing as an email body: the server
  instructions and the README say so, and `get_event`/`get_reminder` label them
  the way `get_mail_message` labels `untrustedEmailContent`.
- **Bounded writes.** Allowlisted, writable, non-scheduling, non-recurring
  **resources** only; one resource per call; update needs the ETag from a read;
  rate-limited; audited. No `PROPPATCH`, no ACL, no `MKCALENDAR`, no `MOVE`, no
  arbitrary URL.
- **No new credential.** The mail app-specific password is reused, so there is
  nothing new to leak or rotate.
- **No content caching.** The discovery cache holds URLs only.
- **No invitation surface.** No `ORGANIZER`, `ATTENDEE`, `PARTSTAT` or `VALARM`
  is ever created or edited; existing VALARMs are preserved untouched, and
  resources that already carry scheduling properties are not mutated at all.
- **Shared collections.** A write to a calendar shared with other people is
  visible to them immediately; the tool result names the collection and the
  README says it.

## Steps (each leaves the repo green)

0. **Probe, committed.** `scripts/probe-caldav.mjs`: the checks in the table
   above, read-only by construction, destination-validated, `<dsid>`-redacted.
1. **Transport.** `src/caldav.ts`, request builders, multistatus parser,
   `CalDavError`, `fetchImpl` injection, bounded response reading, two-phase
   destination validation. Tests: recorded iCloud fixtures, single-vs-array
   children, 200+404 propstat, single-quoted attributes, redirect → re-discover
   once, a foreign host, the shard host, a path outside the home. Run
   `npm run check:bundle` and one workerd fixture parse here, not at the end.
2. **Scopes, config, discovery.** `requireScope` matrix, bearer passthrough,
   scope-profile provider cache key, consent page offering/narrowing wired into
   both `approveConsent` and `completeAuthorization`, new `Env` fields and
   `wrangler.base.jsonc` vars, `GET /v1/calendars[?all=1]` and
   `/v1/reminder-lists[?all=1]`, MCP `list_calendars`. Also update the two other
   places that name the challenge scope: `src/index.ts:58` and
   `scripts/lib/verify.mjs:335`, with their tests. This step is where the
   authorization model lands, because every later tool depends on it.
3. **Time and iCalendar.** `src/tz.ts` and `src/ical.ts` with fixtures:
   `Europe/Rome` DST edges, `Lord_Howe`, all-day, `Z`, `TZID`, `RDATE`, `EXDATE`,
   override by `RECURRENCE-ID`, `RANGE=THISANDFUTURE`, an unknown TZID, the
   window cursor for all four frequencies, `COUNT` rules expanded from `DTSTART`
   (so a February listing of a January series is correct), the candidate cap
   (`FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;COUNT=1000` must not scan 1.5M days), and
   hostile rules that must be refused before expansion
   (`BYMONTH=2;BYMONTHDAY=30`, `INTERVAL=2147483647`, `FREQ=SECONDLY`, a
   10,000-entry `RDATE`). A test asserts
   that `ICAL.Event`, `ICAL.Time`, `ICAL.Timezone` and the recurrence iterator are
   never constructed.
4. **Read events.** `list_events`, `get_event`, overlap semantics, occurrence
   identity, caps, `too_many_resources`, `range_too_wide`, REST parity.
5. **Read reminders.** `list_reminder_lists`, `list_reminders`, `get_reminder`,
   unfiltered bounded listing, client-side filters.
6. **Write events.** `create_event`, `update_event` behind `CALENDAR_WRITE`, the
   ETag contract, re-read before update, the recurring/scheduling refusals, the
   rate limiter.
7. **Write reminders.** `create_reminder`, `update_reminder`,
   `complete_reminder`, same preconditions and refusals.
8. **Docs.** README (a "Calendars and reminders" section, API reference,
   security-model paragraph, untrusted-content bullet), `DEPLOY.md` (new vars,
   how to confirm names, what `*` means and how writes are gated),
   `.dev.vars.example`.
9. **Setup and verify.** Because the domain is disabled until a non-empty
   allowlist exists, setup runs a three-deploy sequence, resumable at each
   boundary: (a) bootstrap deploy with the current config; (b) call the
   bearer-only `?all=1` discovery on the deployed Worker — it cannot use the
   stored Apple password, which Cloudflare never returns — print names and
   kinds, ask which to allow (with `*` as the offered default), persist both
   allowlists in the setup state and the config fragment; (c) **redeploy** with
   the new config, then verify. Persisting without the final deploy would leave
   the Worker with the domains disabled or the old allowlists. When the config
   already carries `*`, step (b) is presentation only and (c) is a no-op
   redeploy; the flow still runs so a stricter deployment works unchanged.
   `verify` adds a read-only 7-day `list_events`, the `?all=1` discovery check,
   and `tools/list` containment. Verify never writes.
10. **Live acceptance.** Deploy with `CALENDAR_WRITE=1` and
    `REMINDERS_WRITE=1` (the owner's choice: writes are on from the first
    deploy) and run the checks below against the `Scratch` calendar and the
    scratch reminder list. There is no off-then-on flip; the write-gating
    checks run locally with the flags at `0`.

## Acceptance (live, on owner-created scratch targets)

Both `Scratch` collections exist (one calendar, one reminder list); no other
collection is written.

- Create a one-off event tomorrow at 10:00 `Europe/Rome`, confirm it renders at
  10:00 on the iPhone, rename it through `update_event` with the returned ETag,
  confirm. The stored UTC instant is computed for the actual date (CEST until
  the October change, CET after), not hardcoded.
- Create a reminder with a due date, complete it, confirm the iPhone shows it
  completed, reopen it and confirm `PERCENT-COMPLETE` is gone.
- Reuse a stale ETag: expect `conflict`, and confirm the resource was not
  overwritten.
- Attempt `update_event` on a resource with `RRULE`: expect
  `recurring_not_supported`, and confirm nothing changed.
- Attempt `update_event` on an event with an attendee: expect
  `scheduling_not_supported`.
- In local `wrangler dev` with `CALENDAR_WRITE=0` and `REMINDERS_WRITE=0`,
  confirm the write tools are absent from `tools/list` and the REST write
  routes answer `not_supported`.
- With a grant narrowed to read on the consent page, confirm
  `insufficient_scope`; confirm the static bearer still works; reconnect and
  confirm the write tools work with a write-scope grant.

## Open items and risks

- **Deletion is not in this plan.** It needs its own decision because CalDAV
  `DELETE` has no trash; `delete_event`/`delete_reminder` are deliberately absent.
- **Editing one occurrence of a series** (EXDATE + override) is out of scope and
  is the most likely follow-up request.
- **Cost on a large calendar.** `Personale` has 2,989 resources and the full
  `Lavoro` calendar is 1.8 MB of XML. The 90-day window, the resource cap and the
  byte cap keep a call bounded, but this must be measured in workerd during
  step 1 rather than assumed.
- **`C:expand` may appear** in a future server version; the code must not depend
  on either behaviour.
- **Zone names drift.** A retired or misspelled TZID (e.g. `Europe/Nowhere`)
  cannot be resolved; the floating fallback covers it, flagged rather than
  guessed.
- **Reminders migration.** The probe proves CalDAV `VTODO` access on this
  account, not that every item visible in Reminders on the iPhone is there. The
  acceptance step compares one list against the phone.
- **`outbox` advertises both components** and is writable protocol-wise; it is
  excluded by the `resourcetype` + display-name + allowlist triple, with a test.
- **Tool list size.** 19 tools (8 existing + 11 new). If a client truncates,
  split into routes as described above — for tool count, not for scopes.
- **`mail:read` covers mail writes.** Existing behaviour, now documented. A
  `mail:write` split is a separate migration.
- **Project name.** `icloud-mail-proxy` no longer describes the Worker, and "all
  Apple connections" eventually means Contacts (CardDAV) and Notes. Renaming
  touches the domain, Worker name, README and every client; out of scope here.

## Estimate

10–12 focused days, i.e. 2–2.5 weeks part-time. Breakdown: 0 (0.5), 1 (1.5),
2 (1.5), 3 (1.5), 4 (1), 5 (0.5), 6 (1.5), 7 (1), 8 (1), 9 (1), 10 (0.5). The
read-only slice (0–4) is ~6 days and is useful on its own; the write half (6–7)
can follow. The earlier 7–9 day figure was wrong: it omitted the authorization
rework, the scheduling/recurrence refusals and the bounded-response work this
review surfaced.

## Review

Rounds 1–6: Codex `gpt-6.1-sol`, reasoning high, 2026-10-21. Round 1 verdict
*ready after fixes* (3 P0s, 14 P1s); round 2 *ready after these fixes* (2 P0s,
6 P1s, wording); round 3 *fix first* (1 P0, 2 P1s); round 4 two residual holes;
round 5 one unbounded case. Round 6 closed it: **implement as is**. Every finding
is folded in below.
Round 3 closed the scope-minting and setup-bootstrap P0s, then found that the
destination guard still trusted an unvalidated home URL, that the accepted rule
subset did not actually bound `ical.js`'s internal search, and that setup
persisted selections without redeploying. Round 4 confirmed the setup sequence
and found two remaining holes: the bootstrap path check used `startsWith`, and
"component-local VTIMEZONE resolution" would still have constructed an ical.js
iterator (and a window cursor cannot honour `COUNT`). Round 5 closed both and
found one last unbounded case: `COUNT` bounds occurrences, not candidates, so
the cursor now also counts candidate steps. All are fixed above: the
principal path is matched by equality, `ical.js` is a parser/serializer only
with no `Event`/`Time`/`Timezone` use, `COUNT` rules expand from `DTSTART`
(capped at 1000), and setup redeploys after persisting. Earlier rounds:

- Host allowlist rejects the real shard (`pNN-caldav` is not `*.caldav`), and
  destination validation is now two-phase (bootstrap, then pinned origin +
  home path) instead of host + path.
- Scheduling: existing `ORGANIZER`/`ATTENDEE` resources can generate iTIP
  messages on PUT; updates are refused, deletes are out of scope, and the
  resource is re-read before every write.
- `apiHandlers` does not give per-route scopes; the claim is withdrawn.
- Write consent: metadata alone does not mint scopes; the consent page now
  offers the deployment's enabled scopes, may narrow them, and passes the
  selection through both provider calls. Refresh cannot re-widen a narrowed
  grant. The reconnect path is verified, not assumed.
- Time zones: RFC 5545 uses the offset before the gap; writes are UTC/DATE only;
  unresolved zones stay floating and incomparable.
- Bounded computation: expansion is a window cursor of our own (not `ical.js`'s
  iterator), the accepted rule subset is what that cursor implements,
  response/per-resource byte caps, and hostile fixtures.
- Occurrence identity and refusal recovery are explicit, including
  `readOnlyReason` and an error that says retrying will not help.
- Reminders: unfiltered bounded listing rather than a server filter that cannot
  be trusted to be a superset; `get_reminder` added (19 tools).
- Setup can bootstrap through the bearer-only `?all=1` discovery, which was
  impossible with an allowlist-filtered endpoint.
- Probe metrics fixed: responses are counted without an off-by-one, bytes are
  UTF-8 bytes, and event rules are counted separately from VTIMEZONE rules
  (which had inflated the earlier RRULE figure 20×). Both files are committed on
  this branch, so "committed" is true.
- Round 6 confirmed the candidate caps bound every accepted rule: `UNTIL` stays
  window-bounded, an old `DTSTART` with `COUNT` stops at 50,000 candidates per
  rule, and 300 resources share the 200,000-candidate request budget.

## Verification log

- 2026-10-21, `scripts/probe-caldav.mjs --json`: discovery 207/207, 10 entries
  (home, 6 collections, 3 pseudo-collections), `expand` byte-identical (1,814,924 bytes both), 150 event RRULEs
  all `WEEKLY`, single resource `GET` 200 / `PROPFIND` no data / `multiget` data
  + strong quoted ETag, 3 VTODO resources unfiltered and 0 in a 30-day window.
- 2026-10-22, local: `npm test` 707 passed / 37 files, `npm run typecheck` clean,
  `npm run check:bundle` clean. `wrangler dev` with both write flags `0` and both
  allowlists `*`: `tools/list` returned 14 tools (mail plus read-only calendar
  and reminder tools, no writes), and all five REST write routes answered `404
  not_supported`.
- 2026-10-22, production (`https://icloud-mail.diegobit.com`, version
  `69444862-313c-4d52-91d2-aa769438a974`): `verifyDeployment` passed all checks,
  including `?all=1` (5 calendars, 2 reminder lists) and the 7-day
  `list_events`, with 19 tools. Created a one-off event on `Scratch` for
  2026-10-23 10:00 `Europe/Rome`; the API returned `10:00+02:00` and `get_event`
  showed the stored UTC instant `08:00Z`. Renamed it through `update_event`
  with the returned ETag; a stale ETag returned `409 conflict` and left the
  summary unchanged. `update_event` refused a recurring `Lavoro` resource with
  `422 recurring_not_supported` and a scheduling resource with `422
  scheduling_not_supported`; both ETags and summaries were unchanged after the
  refusal.
- 2026-10-22, blocked: the `Scratch` reminder list is still not visible over
  CalDAV (`probe-caldav.mjs` lists only `Casa SP⚠️` and `Reminders` as VTODO
  collections; `Scratch` is VEVENT-only). Reminder acceptance, the iPhone
  rendering check, and the OAuth narrowed-grant reconnect check are therefore
  pending owner action; no reminder write has been attempted.
