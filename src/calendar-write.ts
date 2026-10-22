// Write side of CalDAV events: create, update or delete one non-recurring
// event.
//
// Product rules for the calendar surface:
// - inputs are structured fields, never raw iCalendar;
// - a create generates a UUIDv4 resource (or accepts a caller id so a retry is
//   idempotent) and uses If-None-Match: *;
// - an update or delete requires the exact strong ETag from get_event,
//   re-reads the resource, refuses recurring/scheduling resources, then uses
//   If-Match; deletion is immediate and has no trash;
// - the serialized payload is UTC or DATE only: no TZID, RRULE, RDATE,
//   EXDATE, ATTENDEE, ORGANIZER or VALARM is ever written;
// - every attempted write is logged with the principal, action, collection,
//   resource and outcome, but never with the summary or the description.
//
// The read-modify-write is deliberate: an iCloud event can carry a VTIMEZONE,
// VALARMs and Apple X- properties that a naive overwrite would destroy.

import { CalDavError, createCalDav, resourcePath } from "./caldav";
import {
  DEFAULT_TIME_ZONE,
  calendarLimits,
  calendarsEnabled,
  calendarWritesEnabled,
  type CalendarLimits,
} from "./calendar-config";
import { resolveCalendar } from "./calendar-core";
import {
  assertStrongEtag,
  byteLength,
  icalCaps,
  isResourceId,
  readResource,
} from "./calendar-resource";
import {
  assertZone,
  formatAbsolute,
  icsDate,
  icsUtc,
  parseDateOnly,
  parseWallDateTime,
} from "./calendar-time";
import {
  FORBIDDEN_WRITE_PROPERTIES,
  auditWrite,
  escapeIcalText,
  normalizeSummary,
  normalizeText,
  readOnlyCollectionError,
  reconcileMutationError,
  serializeIcal,
  withWriteLimit,
  type WriteOptions,
} from "./calendar-write-core";
import { ApiError } from "./core";
import {
  componentEnd,
  mutateResource,
  parseResource,
  type ParsedResource,
} from "./ical";
import { compareDates, dateOf, isoDate, isoInZone, wallClockToUtc, type DateParts } from "./tz";
import type { Env } from "./types";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WALL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export interface CreateEventInput {
  calendar: string;
  /** Optional caller-supplied resource id; the same id makes a retry idempotent. */
  id?: string;
  summary: string;
  /** Wall clock YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD for an all-day event. */
  start: string;
  /** Exclusive end, in the same form as start. */
  end: string;
  /** IANA zone for a timed event; defaults to Europe/Rome. */
  timeZone?: string;
  /** Inferred from the form of start/end when omitted. */
  allDay?: boolean;
  location?: string | null;
  description?: string | null;
}

export interface UpdateEventInput {
  calendar: string;
  id: string;
  /** The strong ETag returned by get_event. */
  etag: string;
  summary?: string;
  start?: string;
  end?: string;
  timeZone?: string;
  allDay?: boolean;
  /** null removes the property. */
  location?: string | null;
  /** null removes the property. */
  description?: string | null;
}

export interface DeleteEventInput {
  calendar: string;
  id: string;
  /** The strong ETag returned by get_event. */
  etag: string;
}

/** Kept as the event module's public name for the shared write options. */
export type CalendarWriteOptions = WriteOptions;

export interface EventWriteResult {
  calendar: string;
  collectionId: string;
  resourceId: string;
  uid: string;
  /** The PUT response ETag, or null when iCloud omitted it. */
  etag: string | null;
  summary: string | null;
  /** ISO 8601 with offset, YYYY-MM-DD, or null when the stored value is floating. */
  start: string | null;
  end: string | null;
  timeZone: string | null;
  allDay: boolean;
}

export interface DeleteEventResult {
  ok: true;
  calendar: string;
  collectionId: string;
  resourceId: string;
  uid: string;
  summary: string | null;
}

interface ResolvedEventTime {
  allDay: boolean;
  zone: string | null;
  startDate: DateParts | null;
  endDate: DateParts | null;
  startInstant: number | null;
  endInstant: number | null;
  startIso: string;
  endIso: string;
}

/**
 * Resolve the wall-clock inputs to a time to write. The caller never gets to
 * inject an offset or a TZID: the form of start/end selects DATE or a wall
 * clock read in `timeZone`, and a timed value is stored as UTC.
 */
function resolveEventTime(
  start: string,
  end: string,
  allDayInput: boolean | undefined,
  timeZone: string | undefined,
): ResolvedEventTime {
  const startIsDate = DATE_ONLY.test(start);
  const endIsDate = DATE_ONLY.test(end);
  const startIsDateTime = WALL_DATE_TIME.test(start);
  const endIsDateTime = WALL_DATE_TIME.test(end);
  if (!((startIsDate && endIsDate) || (startIsDateTime && endIsDateTime))) {
    throw new ApiError(
      400,
      "invalid_request",
      "start and end must both be YYYY-MM-DD or both be YYYY-MM-DDTHH:MM:SS",
    );
  }

  const allDay = allDayInput ?? startIsDate;
  if (allDay && !startIsDate) {
    throw new ApiError(400, "invalid_request", "an all-day event needs start and end as YYYY-MM-DD");
  }
  if (!allDay && !startIsDateTime) {
    throw new ApiError(
      400,
      "invalid_request",
      "a timed event needs start and end as YYYY-MM-DDTHH:MM:SS",
    );
  }

  if (allDay) {
    if (timeZone !== undefined) {
      throw new ApiError(400, "invalid_request", "timeZone does not apply to an all-day event");
    }
    const startDate = parseDateOnly(start, "start");
    const endDate = parseDateOnly(end, "end");
    if (compareDates(startDate, endDate) >= 0) {
      throw new ApiError(
        400,
        "invalid_range",
        "end must be after start; an all-day end is exclusive",
      );
    }
    return {
      allDay: true,
      zone: null,
      startDate,
      endDate,
      startInstant: null,
      endInstant: null,
      startIso: isoDate(startDate),
      endIso: isoDate(endDate),
    };
  }

  const zone = assertZone(timeZone ?? DEFAULT_TIME_ZONE);
  const startWall = parseWallDateTime(start, "start");
  const endWall = parseWallDateTime(end, "end");
  const startInstant = wallClockToUtc(zone, startWall);
  const endInstant = wallClockToUtc(zone, endWall);
  if (endInstant <= startInstant) {
    throw new ApiError(400, "invalid_range", "end must be after start after conversion to UTC");
  }
  return {
    allDay: false,
    zone,
    startDate: null,
    endDate: null,
    startInstant,
    endInstant,
    startIso: isoInZone(startInstant, zone),
    endIso: isoInZone(endInstant, zone),
  };
}

function buildEventIcs(input: {
  uid: string;
  summary: string;
  location: string | null;
  description: string | null;
  time: ResolvedEventTime;
  now: number;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//icloud-mail-proxy//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${escapeIcalText(input.uid)}`,
    `DTSTAMP:${icsUtc(input.now)}`,
  ];
  if (input.time.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(input.time.startDate!)}`);
    lines.push(`DTEND;VALUE=DATE:${icsDate(input.time.endDate!)}`);
  } else {
    lines.push(`DTSTART:${icsUtc(input.time.startInstant!)}`);
    lines.push(`DTEND:${icsUtc(input.time.endInstant!)}`);
  }
  lines.push(`SUMMARY:${escapeIcalText(input.summary)}`);
  if (input.location !== null) lines.push(`LOCATION:${escapeIcalText(input.location)}`);
  if (input.description !== null) lines.push(`DESCRIPTION:${escapeIcalText(input.description)}`);
  lines.push("END:VEVENT", "END:VCALENDAR");
  return serializeIcal(lines);
}

/**
 * Re-parse a freshly built event and assert the fields that matter. This is
 * the second line of defence: even if the builder were changed, a scheduling
 * or recurrence property cannot reach iCloud.
 */
function validateCreatedEvent(
  ics: string,
  limits: CalendarLimits,
  expected: { uid: string; summary: string; time: ResolvedEventTime },
): ParsedResource {
  const parsed = parseResource(ics, icalCaps(limits));
  if (parsed.kind !== "VEVENT" || parsed.components.length !== 1) {
    throw new ApiError(500, "internal_error", "the serialized event is not exactly one VEVENT");
  }
  if (parsed.uid !== expected.uid) {
    throw new ApiError(500, "internal_error", "the serialized event changed the UID");
  }
  if (
    parsed.recurring ||
    parsed.scheduling ||
    parsed.master.jcal[1].some(([name]) => FORBIDDEN_WRITE_PROPERTIES.has(name))
  ) {
    throw new ApiError(
      400,
      "unsupported_field",
      "the event would carry a recurrence or scheduling property, which v1 never writes",
    );
  }
  if (parsed.master.alarms > 0) {
    throw new ApiError(400, "unsupported_field", "the event would carry a VALARM, which is not supported");
  }
  if (parsed.master.summary !== expected.summary) {
    throw new ApiError(500, "internal_error", "the serialized summary did not round-trip");
  }

  const start = parsed.master.start;
  const end = parsed.master.end;
  if (expected.time.allDay) {
    if (
      start === null ||
      end === null ||
      !start.dateOnly ||
      !end.dateOnly ||
      isoDate(dateOf(start.wall)) !== expected.time.startIso ||
      isoDate(dateOf(end.wall)) !== expected.time.endIso
    ) {
      throw new ApiError(500, "internal_error", "the serialized all-day start/end did not round-trip");
    }
  } else if (
    start === null ||
    end === null ||
    start.utc !== expected.time.startInstant ||
    end.utc !== expected.time.endInstant
  ) {
    throw new ApiError(500, "internal_error", "the serialized timed start/end did not round-trip");
  }
  return parsed;
}

function assertCalendarWriteEnabled(env: Env): void {
  if (calendarWritesEnabled(env)) return;
  throw new ApiError(
    404,
    "not_supported",
    calendarsEnabled(env)
      ? "calendar writes are disabled: set CALENDAR_WRITE to 1"
      : "calendars are disabled: ALLOWED_CALENDARS is empty",
  );
}

export async function createEvent(
  env: Env,
  input: CreateEventInput,
  options: CalendarWriteOptions = {},
): Promise<EventWriteResult> {
  assertCalendarWriteEnabled(env);
  const limits = calendarLimits(env);
  const summary = normalizeSummary(input.summary);
  const location = normalizeText(input.location, "location") ?? null;
  const description = normalizeText(input.description, "description") ?? null;
  const time = resolveEventTime(input.start, input.end, input.allDay, input.timeZone);
  const id = input.id ?? crypto.randomUUID();
  if (!isResourceId(id)) {
    throw new ApiError(
      400,
      "invalid_request",
      `invalid event id ${JSON.stringify(id)}; use 1-128 letters, digits, dot, underscore or hyphen`,
    );
  }

  const ics = buildEventIcs({
    uid: id,
    summary,
    location,
    description,
    time,
    now: options.now ?? Date.now(),
  });
  const bytes = byteLength(ics);
  if (bytes > limits.maxResourceBytes) {
    throw new ApiError(
      422,
      "resource_too_large",
      `the event is ${bytes} bytes; MAX_RESOURCE_BYTES is ${limits.maxResourceBytes}`,
    );
  }
  validateCreatedEvent(ics, limits, { uid: id, summary, time });

  return withWriteLimit(env, options.rateLimitKey, async () => {
    const collection = await resolveCalendar(env, input.calendar, {
      fetchImpl: options.fetchImpl,
    });
    if (collection.readOnly) throw readOnlyCollectionError(collection);

    return auditWrite(options, "create_event", collection.id, id, async () => {
      const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
      const { homeUrl } = await caldav.discover();
      const href = new URL(resourcePath(collection.id, id), homeUrl).pathname;
      let response;
      try {
        response = await caldav.put(href, ics, null);
      } catch (error) {
        if (error instanceof CalDavError && error.code === "conflict") {
          throw new ApiError(
            409,
            "already_exists",
            `event ${JSON.stringify(id)} already exists; call get_event on that id and compare ` +
              "instead of creating a second copy",
          );
        }
        throw reconcileMutationError(error, "create", id, "get_event");
      }
      return {
        calendar: collection.name,
        collectionId: collection.id,
        resourceId: id,
        uid: id,
        etag: response.etag,
        summary,
        start: time.startIso,
        end: time.endIso,
        timeZone: time.zone,
        allDay: time.allDay,
      };
    });
  });
}

export async function updateEvent(
  env: Env,
  input: UpdateEventInput,
  options: CalendarWriteOptions = {},
): Promise<EventWriteResult> {
  assertCalendarWriteEnabled(env);
  const limits = calendarLimits(env);
  if (!isResourceId(input.id)) {
    throw new ApiError(
      400,
      "invalid_request",
      `invalid event id ${JSON.stringify(input.id)}; use 1-128 letters, digits, dot, underscore or hyphen`,
    );
  }
  assertStrongEtag(input.etag);
  const etag = input.etag;

  const summary = input.summary === undefined ? undefined : normalizeSummary(input.summary);
  const location = normalizeText(input.location, "location");
  const description = normalizeText(input.description, "description");
  const hasTime = input.start !== undefined || input.end !== undefined;
  if (!hasTime && (input.timeZone !== undefined || input.allDay !== undefined)) {
    throw new ApiError(
      400,
      "invalid_request",
      "timeZone and allDay only apply when start and end are provided",
    );
  }
  if (hasTime && (input.start === undefined || input.end === undefined)) {
    throw new ApiError(400, "invalid_request", "start and end must be provided together");
  }
  if (summary === undefined && location === undefined && description === undefined && !hasTime) {
    throw new ApiError(400, "invalid_request", "update_event needs at least one field to change");
  }
  const time = hasTime
    ? resolveEventTime(input.start!, input.end!, input.allDay, input.timeZone)
    : null;

  return withWriteLimit(env, options.rateLimitKey, async () => {
    const collection = await resolveCalendar(env, input.calendar, {
      fetchImpl: options.fetchImpl,
    });
    if (collection.readOnly) throw readOnlyCollectionError(collection);

    return auditWrite(options, "update_event", collection.id, input.id, async () => {
      const current = await readResource(env, collection, input.id, {
        fetchImpl: options.fetchImpl,
      });
      if (current.etag !== etag) {
        throw new ApiError(
          409,
          "conflict",
          "the event changed since you read it; call get_event again",
        );
      }

      const parsed = parseResource(current.ics, icalCaps(limits));
      if (parsed.kind !== "VEVENT") {
        throw new ApiError(
          422,
          "not_an_event",
          "this resource is not a VEVENT; update_event only updates calendar events",
        );
      }
      if (parsed.recurring) {
        throw new ApiError(
          422,
          "recurring_not_supported",
          "this event is recurring; v1 only writes one-off events, so it was not changed",
        );
      }
      if (parsed.scheduling) {
        throw new ApiError(
          422,
          "scheduling_not_supported",
          "this event has an organizer or attendees; v1 does not change scheduling resources",
        );
      }

      const output = mutateResource(current.ics, parsed.uid, (editor) => {
        if (summary !== undefined) editor.setText("summary", summary);
        if (location !== undefined) {
          if (location === null) editor.remove("location");
          else editor.setText("location", location);
        }
        if (description !== undefined) {
          if (description === null) editor.remove("description");
          else editor.setText("description", description);
        }
        if (time !== null) {
          // DTEND and DURATION are mutually exclusive; setting DTEND removes
          // any duration the event already carried.
          editor.remove("duration");
          if (time.allDay) {
            editor.setDate("dtstart", isoDate(time.startDate!));
            editor.setDate("dtend", isoDate(time.endDate!));
          } else {
            // Editor.setDateTimeUtc takes extended ISO, not the compact
            // iCalendar form used on the wire.
            editor.setDateTimeUtc("dtstart", isoInZone(time.startInstant!, "UTC"));
            editor.setDateTimeUtc("dtend", isoInZone(time.endInstant!, "UTC"));
          }
        }
      });

      const bytes = byteLength(output);
      if (bytes > limits.maxResourceBytes) {
        throw new ApiError(
          422,
          "resource_too_large",
          `the updated event is ${bytes} bytes; MAX_RESOURCE_BYTES is ${limits.maxResourceBytes}`,
        );
      }
      const updated = validateUpdatedEvent(output, limits, {
        uid: parsed.uid,
        summary,
        time,
      });

      const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
      const { homeUrl } = await caldav.discover();
      const href = new URL(resourcePath(collection.id, input.id), homeUrl).pathname;
      let response;
      try {
        response = await caldav.put(href, output, etag);
      } catch (error) {
        if (error instanceof CalDavError && error.code === "conflict") {
          throw new ApiError(
            409,
            "conflict",
            "the event changed since you read it; call get_event again",
          );
        }
        throw reconcileMutationError(error, "update", input.id, "get_event");
      }

      const start = updated.master.start;
      const end = componentEnd(updated.master);
      return {
        calendar: collection.name,
        collectionId: collection.id,
        resourceId: input.id,
        uid: updated.uid,
        etag: response.etag,
        summary: summary ?? updated.master.summary,
        start:
          time !== null
            ? time.startIso
            : start === null
              ? null
              : formatAbsolute(start),
        end: time !== null ? time.endIso : end === null ? null : formatAbsolute(end),
        timeZone: time !== null ? time.zone : start?.timeZone ?? null,
        allDay: time !== null ? time.allDay : updated.master.allDay,
      };
    });
  });
}

/**
 * Delete one non-recurring, non-scheduling event. The read-before-delete is
 * deliberate: it checks the caller's ETag, refuses a VTODO or a recurring /
 * scheduling resource, and gives the audit line a definite outcome before the
 * DELETE is sent. CalDAV deletion is immediate; there is no trash.
 */
export async function deleteEvent(
  env: Env,
  input: DeleteEventInput,
  options: CalendarWriteOptions = {},
): Promise<DeleteEventResult> {
  assertCalendarWriteEnabled(env);
  const limits = calendarLimits(env);
  if (!isResourceId(input.id)) {
    throw new ApiError(
      400,
      "invalid_request",
      `invalid event id ${JSON.stringify(input.id)}; use 1-128 letters, digits, dot, underscore or hyphen`,
    );
  }
  assertStrongEtag(input.etag);
  const etag = input.etag;

  return withWriteLimit(env, options.rateLimitKey, async () => {
    const collection = await resolveCalendar(env, input.calendar, {
      fetchImpl: options.fetchImpl,
    });
    if (collection.readOnly) throw readOnlyCollectionError(collection);

    return auditWrite(options, "delete_event", collection.id, input.id, async () => {
      const current = await readResource(env, collection, input.id, {
        fetchImpl: options.fetchImpl,
      });
      if (current.etag !== etag) {
        throw new ApiError(
          409,
          "conflict",
          "the event changed since you read it; call get_event again",
        );
      }

      const parsed = parseResource(current.ics, icalCaps(limits));
      if (parsed.kind !== "VEVENT") {
        throw new ApiError(
          422,
          "not_an_event",
          "this resource is not a VEVENT; delete_event only deletes calendar events",
        );
      }
      if (parsed.recurring) {
        throw new ApiError(
          422,
          "recurring_not_supported",
          "this event is recurring; delete_event only deletes one-off events, so nothing was deleted",
        );
      }
      if (parsed.scheduling) {
        throw new ApiError(
          422,
          "scheduling_not_supported",
          "this event has an organizer or attendees; delete_event does not delete scheduling resources",
        );
      }

      const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
      const { homeUrl } = await caldav.discover();
      const href = new URL(resourcePath(collection.id, input.id), homeUrl).pathname;
      try {
        await caldav.delete(href, etag);
      } catch (error) {
        if (error instanceof CalDavError && error.code === "conflict") {
          throw new ApiError(
            409,
            "conflict",
            "the event changed since you read it; call get_event again",
          );
        }
        throw reconcileMutationError(error, "delete", input.id, "get_event");
      }

      return {
        ok: true,
        calendar: collection.name,
        collectionId: collection.id,
        resourceId: input.id,
        uid: parsed.uid,
        summary: parsed.master.summary,
      };
    });
  });
}

/**
 * Validate a read-modify-write. Unlike a create, an existing event may carry
 * VALARMs, a DURATION and a floating or TZID start; only the fields this call
 * changed are checked, and the UID/component count are already enforced by
 * mutateResource.
 */
function validateUpdatedEvent(
  ics: string,
  limits: CalendarLimits,
  expected: { uid: string; summary: string | undefined; time: ResolvedEventTime | null },
): ParsedResource {
  const parsed = parseResource(ics, icalCaps(limits));
  if (parsed.kind !== "VEVENT" || parsed.components.length !== 1) {
    throw new ApiError(500, "internal_error", "the updated resource is not exactly one VEVENT");
  }
  if (parsed.uid !== expected.uid) {
    throw new ApiError(500, "internal_error", "the updated resource changed the UID");
  }
  if (parsed.recurring || parsed.scheduling) {
    throw new ApiError(500, "internal_error", "the updated resource became recurring or scheduled");
  }
  if (expected.summary !== undefined && parsed.master.summary !== expected.summary) {
    throw new ApiError(500, "internal_error", "the updated summary did not round-trip");
  }
  if (expected.time !== null) {
    const start = parsed.master.start;
    const end = parsed.master.end;
    if (expected.time.allDay) {
      if (
        start === null ||
        end === null ||
        !start.dateOnly ||
        !end.dateOnly ||
        isoDate(dateOf(start.wall)) !== expected.time.startIso ||
        isoDate(dateOf(end.wall)) !== expected.time.endIso
      ) {
        throw new ApiError(500, "internal_error", "the updated all-day start/end did not round-trip");
      }
    } else if (
      start === null ||
      end === null ||
      start.utc !== expected.time.startInstant ||
      end.utc !== expected.time.endInstant
    ) {
      throw new ApiError(500, "internal_error", "the updated timed start/end did not round-trip");
    }
  }
  return parsed;
}
