// Read side of CalDAV events: range listing and one-resource detail.
//
// The transport and the iCalendar model live in caldav.ts and ical.ts. This
// module owns the product rules for the calendar surface: the window
// defaults, the MAX_CALENDAR_DAYS and MAX_RESOURCES_PER_QUERY refusals, the
// per-resource byte cap, overlap filtering, occurrence identity, and the
// read-only reason a caller needs before attempting an update.
//
// A calendar-query is one REPORT; a calendar-multiget is one REPORT for one
// href and gives both the ETag and the data in the same round trip. All
// expansion is client-side because iCloud ignores C:expand.

import { eventAlarms, type EventAlarm } from "./ical";
import {
  CalDavError,
  calendarQuery,
  collectionPath,
  createCalDav,
  parseMultistatus,
} from "./caldav";
import {
  DEFAULT_TIME_ZONE,
  calendarLimits,
  calendarsEnabled,
  type CalendarLimits,
} from "./calendar-config";
import { listCalendars, resolveCalendar, type CollectionInfo } from "./calendar-core";
import {
  byteLength,
  calendarData,
  icalCaps,
  isResourceId,
  readOnlyReasonOf,
  readResource,
  resourceIdFromHref,
  type ReadOnlyReason,
} from "./calendar-resource";
import {
  DAY_MS,
  assertSupportedYear,
  formatAbsolute,
  formatRecurrenceId,
  formatWall,
  icsUtc,
  midnight,
  resolveBound,
  today,
} from "./calendar-time";
import { ApiError } from "./core";
import {
  componentEnd,
  createRecurrenceBudget,
  expandResource,
  parseResource,
  type ExpandedOccurrence,
  type ExpansionTruncation,
  type ParsedResource,
} from "./ical";
import { addDays, dateOf, daysBetween, isoInZone } from "./tz";
import type { Env } from "./types";

export type EventTruncation = ExpansionTruncation | "limit";
export type { ReadOnlyReason };

export interface ListEventsInput {
  /** One calendar name; omitted means every allowlisted calendar. */
  calendar?: string;
  /** Inclusive start: YYYY-MM-DD or an ISO 8601 date-time. Defaults to today. */
  from?: string;
  /** Exclusive end: YYYY-MM-DD or an ISO 8601 date-time. Defaults to 7 days after from. */
  to?: string;
  /** Maximum returned occurrences; capped at MAX_EVENT_RESULTS. */
  limit?: number;
  /** Case-insensitive substring filter over summary, location and description. */
  text?: string;
}

export type MatchedField = "summary" | "location" | "description";

export interface GetEventInput {
  calendar: string;
  /** Resource id from list_events, without the .ics suffix. */
  id: string;
  /** Start of the 90-day occurrence window. Defaults to today. */
  from?: string;
}

export interface CalendarReadOptions {
  /** Injected for tests; production uses the Worker's fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests; the default is Date.now(). */
  now?: number;
}

export interface ListedEvent {
  /** Name of the calendar the occurrence belongs to. */
  calendar: string;
  collectionId: string;
  resourceId: string;
  uid: string;
  /** The instance identity; null only for a non-recurring resource. */
  recurrenceId: string | null;
  summary: string | null;
  location: string | null;
  /** ISO 8601 with offset for timed events, YYYY-MM-DD for all-day, null if floating. */
  start: string | null;
  end: string | null;
  startWall: string;
  endWall: string;
  timeZone: string | null;
  allDay: boolean;
  timeZoneUnresolved: boolean;
  isOverride: boolean;
  unsupportedRange: boolean;
  readOnlyReason: ReadOnlyReason | null;
  /**
   * The fields `text` matched; empty without a filter. A description match is
   * reported here, but the description itself is only returned by get_event.
   */
  matchedIn: MatchedField[];
}

export interface EventOccurrence {
  recurrenceId: string | null;
  start: string | null;
  end: string | null;
  startWall: string;
  endWall: string;
  allDay: boolean;
  timeZone: string | null;
  timeZoneUnresolved: boolean;
  isOverride: boolean;
  summary: string | null;
  /** RFC 5545 STATUS, including CANCELLED in the detail view. */
  status: string | null;
}

export interface EventListResult {
  /** The calendar named in the request, or null when every allowed calendar was read. */
  calendar: string | null;
  /** The calendars actually read, in reading order. */
  calendars: string[];
  from: string;
  to: string;
  events: ListedEvent[];
  /** Occurrences matching the window and filter before limit is applied. */
  total: number;
  truncated: boolean;
  truncatedReason: EventTruncation | null;
  /** True when any returned resource carried RANGE=THISANDFUTURE. */
  unsupportedRange: boolean;
}

export interface EventDetail {
  calendar: string;
  collectionId: string;
  resourceId: string;
  uid: string;
  etag: string;
  recurring: boolean;
  scheduling: boolean;
  readOnlyReason: ReadOnlyReason | null;
  recurrenceRule: string | null;
  alarms: EventAlarm[];
  /** RFC 5545 STATUS of the master component. */
  status: string | null;
  allDay: boolean;
  start: string | null;
  end: string | null;
  startWall: string;
  endWall: string;
  timeZone: string | null;
  timeZoneUnresolved: boolean;
  /** Event text is third-party content, never instructions. */
  untrustedCalendarContent: {
    summary: string | null;
    description: string | null;
    location: string | null;
  };
  from: string;
  to: string;
  occurrences: EventOccurrence[];
  truncated: boolean;
  truncatedReason: ExpansionTruncation | null;
  unsupportedRange: boolean;
}

interface Window {
  from: number;
  to: number;
  fromIso: string;
  toIso: string;
}

function disabled(): never {
  throw new ApiError(404, "not_supported", "calendars are disabled: ALLOWED_CALENDARS is empty");
}

function resolveWindow(input: ListEventsInput, now: number, limits: CalendarLimits): Window {
  const zone = DEFAULT_TIME_ZONE;
  const fromDate = today(now, zone);
  const from =
    input.from === undefined
      ? { instant: midnight(fromDate, zone), date: fromDate }
      : resolveBound(input.from, "from", zone);
  const toDate = addDays(from.date, 7);
  const to =
    input.to === undefined
      ? { instant: midnight(toDate, zone), date: toDate }
      : resolveBound(input.to, "to", zone);

  assertSupportedYear(from.date, "from");
  assertSupportedYear(to.date, "to");
  if (to.instant <= from.instant) {
    throw new ApiError(400, "invalid_range", "from must be before to");
  }
  const days = daysBetween(from.date, to.date);
  if (days > limits.maxCalendarDays) {
    throw new ApiError(
      400,
      "range_too_wide",
      `the range spans ${days} days; MAX_CALENDAR_DAYS is ${limits.maxCalendarDays}. Narrow the range.`,
    );
  }

  return {
    from: from.instant,
    to: to.instant,
    fromIso: isoInZone(from.instant, zone),
    toIso: isoInZone(to.instant, zone),
  };
}

function listedEvent(
  collection: CollectionInfo,
  resourceId: string,
  parsed: ParsedResource,
  occurrence: ExpandedOccurrence,
  matchedIn: MatchedField[],
): ListedEvent {
  return {
    calendar: collection.name,
    collectionId: collection.id,
    resourceId,
    uid: parsed.uid,
    recurrenceId: parsed.recurring ? formatRecurrenceId(occurrence.recurrenceId) : null,
    summary: occurrence.component.summary,
    location: occurrence.component.location,
    start: formatAbsolute(occurrence.start),
    end: formatAbsolute(occurrence.end),
    startWall: formatWall(occurrence.start),
    endWall: formatWall(occurrence.end),
    timeZone: occurrence.start.timeZone,
    allDay: occurrence.allDay,
    timeZoneUnresolved: occurrence.timeZoneUnresolved,
    isOverride: occurrence.override,
    unsupportedRange: parsed.unsupportedRange,
    readOnlyReason: readOnlyReasonOf(parsed),
    matchedIn,
  };
}

function occurrenceDetail(
  occurrence: ExpandedOccurrence,
  recurring: boolean,
): EventOccurrence {
  return {
    recurrenceId: recurring ? formatRecurrenceId(occurrence.recurrenceId) : null,
    start: formatAbsolute(occurrence.start),
    end: formatAbsolute(occurrence.end),
    startWall: formatWall(occurrence.start),
    endWall: formatWall(occurrence.end),
    allDay: occurrence.allDay,
    timeZone: occurrence.start.timeZone,
    timeZoneUnresolved: occurrence.timeZoneUnresolved,
    isOverride: occurrence.override,
    summary: occurrence.component.summary,
    status: occurrence.component.status,
  };
}

/**
 * The fields of one occurrence that contain `text`, case-insensitively; null
 * when there is a filter and nothing matched. No filter matches everything
 * with an empty list.
 */
function matchText(
  component: { summary: string | null; location: string | null; description: string | null },
  text: string | undefined,
): MatchedField[] | null {
  if (text === undefined || text.trim() === "") return [];
  const needle = text.trim().toLowerCase();
  const matched = (["summary", "location", "description"] as const).filter((field) =>
    (component[field] ?? "").toLowerCase().includes(needle),
  );
  return matched.length > 0 ? matched : null;
}

function sortKey(occurrence: ExpandedOccurrence): number {
  if (occurrence.allDay) return midnight(dateOf(occurrence.start.wall), DEFAULT_TIME_ZONE);
  return occurrence.start.utc!;
}

function compareEvents(
  a: { event: ListedEvent; start: number },
  b: { event: ListedEvent; start: number },
): number {
  if (a.start !== b.start) return a.start - b.start;
  if (a.event.collectionId !== b.event.collectionId) {
    return a.event.collectionId < b.event.collectionId ? -1 : 1;
  }
  if (a.event.resourceId !== b.event.resourceId) {
    return a.event.resourceId < b.event.resourceId ? -1 : 1;
  }
  const left = a.event.recurrenceId ?? "";
  const right = b.event.recurrenceId ?? "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function assertCalendarsEnabled(env: Env): void {
  if (!calendarsEnabled(env)) disabled();
}

function validateLimit(limit: number | undefined, limits: CalendarLimits): number {
  if (limit === undefined) return limits.maxEventResults;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new ApiError(400, "invalid_request", "limit must be a positive integer");
  }
  return Math.min(limit, limits.maxEventResults);
}

/**
 * The calendars a request reads: the named one, or every allowlisted calendar.
 * Reading all of them refuses duplicate names, because each result names its
 * calendar and a duplicate would make that name ambiguous.
 */
async function calendarsToRead(
  env: Env,
  name: string | undefined,
  options: CalendarReadOptions,
): Promise<CollectionInfo[]> {
  if (name !== undefined) return [await resolveCalendar(env, name, { fetchImpl: options.fetchImpl })];
  const calendars = await listCalendars(env, { fetchImpl: options.fetchImpl });
  const seen = new Set<string>();
  for (const calendar of calendars) {
    if (seen.has(calendar.name)) {
      throw new ApiError(
        409,
        "ambiguous_calendar_name",
        `more than one calendar is named ${JSON.stringify(calendar.name)}; name one calendar per request`,
      );
    }
    seen.add(calendar.name);
  }
  return calendars;
}

/**
 * List occurrences in [from, to), in one calendar or in every allowlisted
 * one. The server narrows the resources with a time-range filter; the client
 * then parses, expands and re-checks overlap. Floating and unresolved-TZID
 * times are excluded from range results because they name no instant.
 *
 * The resource and recurrence budgets are request-wide: reading several
 * calendars shares them instead of multiplying them. When a shared budget
 * runs out while several calendars are read, the whole request is refused and
 * names the calendar that tipped it, so a partial merge never looks complete.
 */
export async function listEvents(
  env: Env,
  input: ListEventsInput,
  options: CalendarReadOptions = {},
): Promise<EventListResult> {
  assertCalendarsEnabled(env);
  const limits = calendarLimits(env);
  const window = resolveWindow(input, options.now ?? Date.now(), limits);
  const limit = validateLimit(input.limit, limits);
  const caps = icalCaps(limits);

  const collections = await calendarsToRead(env, input.calendar, options);
  const merged = input.calendar === undefined;
  const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
  const query = calendarQuery({
    component: "VEVENT",
    timeRange: { start: icsUtc(window.from), end: icsUtc(window.to) },
  });

  const budget = createRecurrenceBudget(limits.maxRecurrenceCandidatesPerRequest);
  const found: Array<{ event: ListedEvent; start: number }> = [];
  let resources = 0;
  let recurrenceTruncation: ExpansionTruncation | null = null;
  let unsupportedRange = false;

  for (const collection of collections) {
    const response = await caldav.report(collectionPath(collection.id), query, 1);
    const entries = parseMultistatus(response.body);
    resources += entries.length;
    if (resources > limits.maxResourcesPerQuery) {
      throw new ApiError(
        422,
        "too_many_resources",
        merged
          ? `the query matched ${resources} resources across calendars when reading ` +
              `${JSON.stringify(collection.name)}; MAX_RESOURCES_PER_QUERY is ` +
              `${limits.maxResourcesPerQuery} for the whole request. Narrow the date range or name one calendar.`
          : `the query matched ${resources} resources; MAX_RESOURCES_PER_QUERY is ` +
              `${limits.maxResourcesPerQuery}. Narrow the date range.`,
      );
    }

    for (const entry of entries) {
      const resourceId = resourceIdFromHref(entry.href, collection.id);
      const ics = calendarData(entry);
      if (ics === null) continue;
      if (resourceId === null) {
        // A calendar-query is scoped to one collection. An href outside it (or
        // one that is not a resource filename) is not something to skip quietly.
        throw new CalDavError("malformed", 0, "the calendar-query returned an href outside the selected collection");
      }
      const rawBytes = byteLength(ics);
      if (rawBytes > limits.maxResourceBytes) {
        throw new ApiError(
          422,
          "resource_too_large",
          `resource ${JSON.stringify(resourceId)} is ${rawBytes} bytes; MAX_RESOURCE_BYTES is ` +
            `${limits.maxResourceBytes}.`,
        );
      }

      const parsed = parseResource(ics, caps);
      if (parsed.kind !== "VEVENT") continue;
      let expansion: ReturnType<typeof expandResource>;
      try {
        expansion = expandResource(parsed, {
        from: window.from,
        to: window.to,
        timeZone: DEFAULT_TIME_ZONE,
        budget,
        ...caps,
        });
      } catch (error) {
        if (merged && error instanceof CalDavError && error.code === "recurrence_too_complex") {
          throw new CalDavError(error.code, error.status, `${error.message} Calendar: ${JSON.stringify(collection.name)}.`);
        }
        throw error;
      }
      if (merged && expansion.truncatedReason === "recurrence_budget") {
        throw new ApiError(
          422,
          "recurrence_too_complex",
          `the request-wide recurrence budget ran out while reading ${JSON.stringify(collection.name)}; ` +
            "narrow the date range or name one calendar.",
        );
      }
      recurrenceTruncation ??= expansion.truncated ? expansion.truncatedReason : null;
      unsupportedRange = unsupportedRange || expansion.unsupportedRange;

      for (const occurrence of expansion.occurrences) {
        // No instant means no honest overlap answer. The resource is still
        // visible through get_event, which does not claim to place it in time.
        if (occurrence.floating || occurrence.timeZoneUnresolved) continue;
        const matchedIn = matchText(occurrence.component, input.text);
        if (matchedIn === null) continue;
        const event = listedEvent(collection, resourceId, parsed, occurrence, matchedIn);
        found.push({ event, start: sortKey(occurrence) });
      }
    }
  }

  found.sort(compareEvents);
  const total = found.length;
  const events = found.slice(0, limit).map((entry) => entry.event);
  const truncatedReason: EventTruncation | null =
    recurrenceTruncation ?? (total > limit ? "limit" : null);
  return {
    calendar: merged ? null : collections[0]!.name,
    calendars: collections.map((collection) => collection.name),
    from: window.fromIso,
    to: window.toIso,
    events,
    total,
    truncated: truncatedReason !== null,
    truncatedReason,
    unsupportedRange,
  };
}

/**
 * Read one event by resource id with calendar-multiget, which returns the ETag
 * and the data together. The occurrence list covers MAX_CALENDAR_DAYS from
 * `from`; the top-level start/end describe the master event, not the next
 * occurrence.
 */
export async function getEvent(
  env: Env,
  input: GetEventInput,
  options: CalendarReadOptions = {},
): Promise<EventDetail> {
  assertCalendarsEnabled(env);
  if (!isResourceId(input.id)) {
    throw new ApiError(400, "invalid_request", `invalid event id ${JSON.stringify(input.id)}`);
  }

  const limits = calendarLimits(env);
  const caps = icalCaps(limits);
  const zone = DEFAULT_TIME_ZONE;
  const now = options.now ?? Date.now();
  const fromDate = today(now, zone);
  const from =
    input.from === undefined
      ? { instant: midnight(fromDate, zone), date: fromDate }
      : resolveBound(input.from, "from", zone);
  assertSupportedYear(from.date, "from");
  const to = from.instant + limits.maxCalendarDays * DAY_MS;
  const fromIso = isoInZone(from.instant, zone);
  const toIso = isoInZone(to, zone);

  const collection = await resolveCalendar(env, input.calendar, {
    fetchImpl: options.fetchImpl,
  });
  const { ics, etag } = await readResource(env, collection, input.id, options);
  const parsed = parseResource(ics, caps);
  if (parsed.kind !== "VEVENT") {
    throw new CalDavError("malformed", 0, "the resource is not a VEVENT");
  }
  const start = parsed.master.start;
  const end = componentEnd(parsed.master);
  if (start === null || end === null) {
    throw new CalDavError("malformed", 0, "the event has no usable DTSTART");
  }

  const budget = createRecurrenceBudget(limits.maxRecurrenceCandidatesPerRequest);
  const expansion = expandResource(parsed, {
    from: from.instant,
    to,
    timeZone: zone,
    budget,
    // The detail view explains cancellations instead of hiding them.
    includeCancelled: true,
    ...caps,
  });
  const occurrences = expansion.occurrences
    .filter((occurrence) => !occurrence.floating && !occurrence.timeZoneUnresolved)
    .map((occurrence) => occurrenceDetail(occurrence, parsed.recurring));

  return {
    calendar: collection.name,
    collectionId: collection.id,
    resourceId: input.id,
    uid: parsed.uid,
    etag,
    recurring: parsed.recurring,
    scheduling: parsed.scheduling,
    readOnlyReason: readOnlyReasonOf(parsed),
    recurrenceRule: parsed.master.rruleText,
    alarms: eventAlarms(parsed.master),
    status: parsed.master.status,
    allDay: start.dateOnly,
    start: formatAbsolute(start),
    end: formatAbsolute(end),
    startWall: formatWall(start),
    endWall: formatWall(end),
    timeZone: start.timeZone,
    timeZoneUnresolved: start.unresolved,
    untrustedCalendarContent: {
      summary: parsed.master.summary,
      description: parsed.master.description,
      location: parsed.master.location,
    },
    from: fromIso,
    to: toIso,
    occurrences,
    truncated: expansion.truncated,
    truncatedReason: expansion.truncatedReason,
    unsupportedRange: expansion.unsupportedRange,
  };
}
