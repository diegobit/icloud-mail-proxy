# Delete one calendar event

**Status (2026-10-23):** the first release (version
`828704ea-6843-49b0-9f5e-f5695d788076`) exposed deletion through the existing
`calendar:write` scope. A security review found that pre-existing grants could
therefore delete without a fresh consent. The follow-up fix adds a separate
`calendar:delete` scope; existing grants must reconnect and approve it. This is
the follow-up to `plans/calendar-reminders.md`; reminders remain out of scope.

**What:** add `delete_event` to the calendar surface and a matching
`DELETE /v1/calendars/:calendar/events/:id` route. The owner asked for the
missing delete capability after the calendar-only release
(*"No delete tool?? add it"*, 2026-10-22).

**What this is not:** a trash, a bulk-delete tool, a recurrence editor or a
CalDAV collection/resource administration API. It deletes one non-recurring
`VEVENT` from one writable, allowlisted calendar. It cannot delete a whole
series, an occurrence, an event with an organizer or attendees, a `VTODO`, or
a calendar collection. Deletion is immediate on iCloud, exactly like Apple
Calendar's delete action; there is no undo through this Worker.

## Contract

- The OAuth tool requires the separate `calendar:delete` scope. A grant holding
  only `calendar:write` returns `insufficient_scope` until it reconnects and the
  owner approves deletion. The static bearer remains the owner.
- The caller must first read the event with `get_event` and pass its exact
  strong ETag. `W/`, `*`, comma-separated lists, spaces, empty and malformed
  tags are refused with `400 invalid_etag` before any network work.
- The server resolves the calendar through `ALLOWED_CALENDARS`, refuses a
  read-only collection, re-reads the resource, checks the current ETag, and
  only then sends `DELETE` with `If-Match`. A stale tag returns `409 conflict`
  and nothing is deleted.
- A resource that is not a `VEVENT` returns `422 not_an_event`; a recurring
  resource returns `422 recurring_not_supported`; a resource with
  `ORGANIZER`/`ATTENDEE` returns `422 scheduling_not_supported`. All three are
  refused before the DELETE.
- The same `CALENDAR_WRITE_LIMITER` gate and audit line apply. The audit action
  is `delete_event`; the summary, description and location are never logged.
- A dropped DELETE response, an iCloud `202 Accepted`, another unexpected 2xx
  or a 5xx returns `502 mutation_state_unknown`. The DELETE may have landed;
  reconcile with `get_event`. A `404` there means the event is gone. Never
  blind-retry.
- Return `{ ok, calendar, collectionId, resourceId, uid, summary }`. There is
  no ETag to return because the resource is gone.
- The MCP tool is registered only when `CALENDAR_WRITE=1`; with writes off the
  surface remains 11 tools. With writes on it is 14 tools.

## Surface

| Surface | Shape |
| --- | --- |
| MCP | `delete_event({ calendar, id, etag })` |
| REST | `DELETE /v1/calendars/:calendar/events/:id` with `If-Match` |

The REST route takes no JSON body. The MCP and REST paths share the same core
function and error mapping.

## Implementation

- `src/caldav.ts`: add `deleteResource` (strong ETag, `If-Match`) and
  `CalDav.delete`; accept 200/204, treat 412 as `conflict`, and map 202 to
  `mutation_state_unknown`.
- `src/calendar-write.ts`: add `DeleteEventInput`, `DeleteEventResult` and
  `deleteEvent`, using the existing rate limiter, allowlist, read-only check,
  ETag re-read, parser and audit helper.
- `src/calendar-write-core.ts`: extend the write action union and mutation
  reconciliation action with delete.
- `src/mcp.ts`: register `delete_event` with a destructive annotation.
- `src/oauth-pages.ts`: add a separate `calendar:delete` consent choice, and
  remove deletion from the `calendar:write` copy so an old write grant cannot
  silently gain irreversible deletion.
- `src/rest.ts`: add the conditional DELETE handler and route.
- `scripts/lib/verify.mjs` and its tests: expect 14 tools with writes on and
  reject a missing or extra delete tool.

## Tests

- Caldav builder: method, `If-Match`, no body, weak/space/invalid ETag refusal.
- Caldav transport: 204 success, 412 conflict, 202/other 2xx/5xx unknown,
  invalid ETag before the network.
- Core: success, stale ETag, invalid ETag (including spaces), read-only
  collection, missing event, writes disabled, missing/denied limiter,
  recurring/scheduling/VTODO refusal with no DELETE, 412, 202, 5xx and dropped
  DELETE.
- OAuth: a `calendar:write` grant without `calendar:delete` is refused with
  `insufficient_scope`; a `calendar:delete` grant passes the scope check.
- Update: a VTODO returns `422 not_an_event` without a PUT.
- REST: `If-Match` required, success shape, writes-disabled 404.
- Setup verification: 14-tool exact set with writes on; 11 without writes.
- Full suite, typecheck and bundle.

## Review

- Round 1 at `d74e97e` found two issues: HTTP 202 was treated as success, and
  spaces passed ETag validation. Both are fixed in `e572d33` with regressions.
- A later review of `e572d33` found that pre-existing `calendar:write` grants
  could delete without a fresh consent, although the old copy said deletion was
  not offered. It also found that only 202 was treated as an ambiguous DELETE,
  that a VTODO update returned the wrong error, and that the refusal tests did
  not prove zero DELETEs. This follow-up adds the separate `calendar:delete`
  scope, maps 5xx/unexpected 2xx DELETEs to `mutation_state_unknown`, returns
  `422 not_an_event` from updates, and strengthens the tests.
- `npm test` is 689 tests / 36 files; typecheck, bundle validation and
  `git diff --check origin/main...HEAD` are clean.

## Deployment and acceptance

- Initial production deployment was version
  `828704ea-6843-49b0-9f5e-f5695d788076`; `verifyDeployment` passed with 14
  tools, OAuth metadata, five calendars, folder discovery and a seven-day
  `list_events` on `Scratch`.
- Live conditional-delete acceptance on `Scratch` with a disposable event:
  create returned `201`, a stale ETag returned `409 conflict` and left the
  event readable, the fresh ETag returned `200 { ok: true }`, `get_event`
  then returned `404 not_found`, and a repeat DELETE with the old ETag returned
  `404 not_found`. The disposable event is gone.
- Production retains `ALLOWED_CALENDARS="*"` and `CALENDAR_WRITE="1"`.

## Open items

- The legacy VTODO test artifacts from the calendar plan are not removable
  through this tool; they remain a separate direct CalDAV/Apple Calendar
  cleanup.
