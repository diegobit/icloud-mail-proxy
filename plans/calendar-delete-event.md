# Delete one calendar event

**Status (2026-10-22):** in progress. This is the follow-up to
`plans/calendar-reminders.md`; reminders remain out of scope.

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

- The caller must first read the event with `get_event` and pass its exact
  strong ETag. `W/`, `*`, comma-separated lists, empty and malformed tags are
  refused with `400 invalid_etag` before any network work.
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
- A dropped DELETE response, or an iCloud `202 Accepted`, returns `502
  mutation_state_unknown`. The DELETE may have landed; reconcile with
  `get_event`. A `404` there means the event is gone. Never blind-retry.
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
  `CalDav.delete`; accept 200/202/204 and treat 412 as `conflict`.
- `src/calendar-write.ts`: add `DeleteEventInput`, `DeleteEventResult` and
  `deleteEvent`, using the existing rate limiter, allowlist, read-only check,
  ETag re-read, parser and audit helper.
- `src/calendar-write-core.ts`: extend the write action union and mutation
  reconciliation action with delete.
- `src/mcp.ts`: register `delete_event` with a destructive annotation.
- `src/oauth-pages.ts`: make the `calendar:write` consent copy say that
  deletion is part of the scope, and that it is immediate.
- `src/rest.ts`: add the conditional DELETE handler and route.
- `scripts/lib/verify.mjs` and its tests: expect 14 tools with writes on and
  reject a missing or extra delete tool.

## Tests

- Caldav builder: method, `If-Match`, no body, weak/space/invalid ETag refusal.
- Caldav transport: 204 success, 412 conflict, 202 unknown, invalid ETag before
  the network.
- Core: success, stale ETag, invalid ETag (including spaces), read-only
  collection, missing event, writes disabled, missing/denied limiter,
  recurring/scheduling/VTODO refusal, DELETE 412, 202 and dropped DELETE.
- REST: `If-Match` required, success shape, writes-disabled 404.
- Setup verification: 14-tool exact set with writes on; 11 without writes.
- Full suite, typecheck and bundle.

## Open items

- Codex review of the branch and fixes before merge.
- Deploy only after review and acceptance. Production currently runs the
  calendar-only runtime from `1a5c7aa`; this change adds a new runtime surface.
- The legacy VTODO test artifacts from the calendar plan are not removable
  through this tool; they remain a separate direct CalDAV/Apple Calendar
  cleanup.
