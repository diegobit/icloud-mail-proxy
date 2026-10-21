// Read side of CalDAV events: range listing and one-resource detail.
//
// The transport and the iCalendar model live in caldav.ts and ical.ts. This
// module owns the product rules from plans/calendar-reminders.md: the window
// defaults, the MAX_CALENDAR_DAYS and MAX_RESOURCES_PER_QUERY refusals, the
// per-resource byte cap, overlap filtering, occurrence identity, and the
// read-only reason a caller needs before attempting an update.
//
// A calendar-query is one REPORT; a calendar-multiget is one REPORT for one
// href and gives both the ETag and the data in the same round trip. All
// expansion is client-side because iCloud ignores C:expand.

import {
  CalDavError,
  calendarMultiget,
  calendarQuery,
  collectionPath,
  createCalDav,
  parseMultistatus,
  propText,
  resourcePath,
  type DavResponse,
} from "./caldav";
import {
  DEFAULT_TIME_ZONE,
  calendarLimits,
  calendarsEnabled,
  type CalendarLimits,
} from "./calendar-config";
import { resolveCollection, type CollectionInfo } from "./calendar-core";
import { ApiError } from "./core";
import {
  componentEnd,
  createRecurrenceBudget,
  expandResource,
  parseResource,
  type ExpandedOccurrence,
  type ExpansionTruncation,
  type IcalCaps,
  type IcalTime,
  type ParsedResource,
} from "./ical";
import {
  addDays,
  assertWallClock,
  dateOf,
  daysBetween,
  isoDate,
  isoInZone,
  isoWall,
  wallAsUtcMs,
  wallClockInZone,
  wallClockToUtc,
  wallFromUtcMs,
  type DateParts,
  type WallClock,
} from "./tz";
import type { Env } from "./types";

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/;
const RESOURCE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ETAG = /^(?:W\/)?"[\x20-\x21\x23-\x7e]*"$/;

export type ReadOnlyReason = "recurring" | "scheduling";
export type EventTruncation = ExpansionTruncation | "limit";

export interface ListEventsInput {
  calendar: string;
  /** Inclusive start: YYYY-MM-DD or an ISO 8601 date-time. Defaults to today. */
  from?: string;
  /** Exclusive end: YYYY-MM-DD or an ISO 8601 date-time. Defaults to 7 days after from. */
  to?: string;
  /** Maximum returned occurrences; capped at MAX_EVENT_RESULTS. */
  limit?: number;
  /** Case-insensitive substring filter over summary and location. */
  text?: string;
}

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
}

export interface EventListResult {
  calendar: string;
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

interface Bound {
  instant: number;
  date: DateParts;
}

interface Window {
  from: number;
  to: number;
  fromIso: string;
  toIso: string;
}

function invalid(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}

function disabled(): never {
  throw new ApiError(404, "not_supported", "calendars are disabled: ALLOWED_CALENDARS is empty");
}

function capsOf(limits: CalendarLimits): IcalCaps {
  return {
    maxRdateExdate: limits.maxRdateExdate,
    maxRecurrenceCandidatesPerRule: limits.maxRecurrenceCandidatesPerRule,
    maxRecurrenceCandidatesPerRequest: limits.maxRecurrenceCandidatesPerRequest,
    maxOccurrencesPerResource: limits.maxOccurrencesPerResource,
  };
}

/** Parse a strict YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[Z|±HH:MM] value. */
function parseBoundValue(
  value: string,
  label: string,
): { wall: WallClock; offsetMinutes: number | null } {
  const date = DATE_RE.exec(value);
  if (date !== null) {
    const wall = {
      year: Number(date[1]),
      month: Number(date[2]),
      day: Number(date[3]),
      hour: 0,
      minute: 0,
      second: 0,
    };
    try {
      assertWallClock(wall);
    } catch {
      invalid(`${label} is not a valid date: ${JSON.stringify(value)}`);
    }
    return { wall, offsetMinutes: null };
  }

  const dateTime = DATE_TIME_RE.exec(value);
  if (dateTime === null) {
    invalid(`${label} must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[Z|±HH:MM]`);
  }
  const wall = {
    year: Number(dateTime[1]),
    month: Number(dateTime[2]),
    day: Number(dateTime[3]),
    hour: Number(dateTime[4]),
    minute: Number(dateTime[5]),
    second: Number(dateTime[6]),
  };
  try {
    assertWallClock(wall);
  } catch {
    invalid(`${label} is not a valid date-time: ${JSON.stringify(value)}`);
  }

  const zone = dateTime[7];
  if (zone === undefined) return { wall, offsetMinutes: null };
  if (zone === "Z") return { wall, offsetMinutes: 0 };
  const sign = zone.startsWith("-") ? -1 : 1;
  const hours = Number(zone.slice(1, 3));
  const minutes = Number(zone.slice(4, 6));
  if (hours > 23 || minutes > 59) invalid(`${label} has an invalid UTC offset: ${JSON.stringify(value)}`);
  return { wall, offsetMinutes: sign * (hours * 60 + minutes) };
}

function resolveBound(value: string, label: string, zone: string): Bound {
  const parsed = parseBoundValue(value, label);
  const instant =
    parsed.offsetMinutes === null
      ? wallClockToUtc(zone, parsed.wall)
      : wallAsUtcMs(parsed.wall) - parsed.offsetMinutes * 60_000;
  return { instant, date: dateOf(wallClockInZone(zone, instant)) };
}

function midnight(date: DateParts, zone: string): number {
  return wallClockToUtc(zone, { ...date, hour: 0, minute: 0, second: 0 });
}

function assertSupportedYear(date: DateParts, label: string): void {
  if (date.year < 2 || date.year > 9998) {
    throw new ApiError(
      400,
      "invalid_request",
      `${label} is outside the supported years (2-9998)`,
    );
  }
}

function today(now: number, zone: string): DateParts {
  return dateOf(wallClockInZone(zone, now));
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

/** UTC iCalendar timestamp for a CalDAV time-range. */
function icsUtc(instant: number): string {
  const wall = wallFromUtcMs(instant);
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return (
    `${pad(wall.year, 4)}${pad(wall.month, 2)}${pad(wall.day, 2)}` +
    `T${pad(wall.hour, 2)}${pad(wall.minute, 2)}${pad(wall.second, 2)}Z`
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function resourceIdFromHref(href: string, collectionId: string): string | null {
  let url: URL;
  try {
    url = new URL(href, "https://caldav.icloud.com/");
  } catch {
    return null;
  }
  const marker = `/${collectionId}/`;
  const index = url.pathname.lastIndexOf(marker);
  if (index === -1) return null;
  const tail = url.pathname.slice(index + marker.length);
  if (tail === "" || tail.includes("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    return null;
  }
  if (!decoded.endsWith(".ics")) return null;
  const id = decoded.slice(0, -4);
  return RESOURCE_ID.test(id) && id !== "." && id !== ".." ? id : null;
}

function calendarData(response: DavResponse): string | null {
  const raw = propText(response, "calendar-data");
  return raw === null ? null : raw.trim();
}

function readOnlyReason(parsed: ParsedResource): ReadOnlyReason | null {
  if (parsed.recurring) return "recurring";
  if (parsed.scheduling) return "scheduling";
  return null;
}

function formatAbsolute(time: IcalTime): string | null {
  if (time.dateOnly) return isoDate(dateOf(time.wall));
  if (time.utc === null) return null;
  return isoInZone(time.utc, time.timeZone ?? "UTC");
}

function formatWall(time: IcalTime): string {
  return time.dateOnly ? `${isoDate(dateOf(time.wall))}T00:00:00` : isoWall(time.wall);
}

function formatRecurrenceId(time: IcalTime): string {
  if (time.dateOnly) return isoDate(dateOf(time.wall));
  if (time.utc === null) return isoWall(time.wall);
  return isoInZone(time.utc, time.timeZone ?? "UTC");
}

function listedEvent(
  collection: CollectionInfo,
  resourceId: string,
  parsed: ParsedResource,
  occurrence: ExpandedOccurrence,
): ListedEvent {
  return {
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
    readOnlyReason: readOnlyReason(parsed),
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
  };
}

function matchesText(event: ListedEvent, text: string | undefined): boolean {
  if (text === undefined || text.trim() === "") return true;
  const needle = text.trim().toLowerCase();
  return (
    (event.summary ?? "").toLowerCase().includes(needle) ||
    (event.location ?? "").toLowerCase().includes(needle)
  );
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
 * List occurrences in [from, to). The server narrows the resources with a
 * time-range filter; the client then parses, expands and re-checks overlap.
 * Floating and unresolved-TZID times are excluded from range results because
 * they name no instant.
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
  const caps = capsOf(limits);

  const collection = await resolveCollection(env, "calendar", input.calendar, {
    fetchImpl: options.fetchImpl,
  });
  const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
  const response = await caldav.report(
    collectionPath(collection.id),
    calendarQuery({
      component: "VEVENT",
      timeRange: { start: icsUtc(window.from), end: icsUtc(window.to) },
    }),
    1,
  );
  const entries = parseMultistatus(response.body);
  if (entries.length > limits.maxResourcesPerQuery) {
    throw new ApiError(
      422,
      "too_many_resources",
      `the query matched ${entries.length} resources; MAX_RESOURCES_PER_QUERY is ` +
        `${limits.maxResourcesPerQuery}. Narrow the date range.`,
    );
  }

  const budget = createRecurrenceBudget(limits.maxRecurrenceCandidatesPerRequest);
  const found: Array<{ event: ListedEvent; start: number }> = [];
  let recurrenceTruncation: ExpansionTruncation | null = null;
  let unsupportedRange = false;

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
    const expansion = expandResource(parsed, {
      from: window.from,
      to: window.to,
      timeZone: DEFAULT_TIME_ZONE,
      budget,
      ...caps,
    });
    recurrenceTruncation ??= expansion.truncated ? expansion.truncatedReason : null;
    unsupportedRange = unsupportedRange || expansion.unsupportedRange;

    for (const occurrence of expansion.occurrences) {
      // No instant means no honest overlap answer. The resource is still
      // visible through get_event, which does not claim to place it in time.
      if (occurrence.floating || occurrence.timeZoneUnresolved) continue;
      const event = listedEvent(collection, resourceId, parsed, occurrence);
      if (!matchesText(event, input.text)) continue;
      found.push({ event, start: sortKey(occurrence) });
    }
  }

  found.sort(compareEvents);
  const total = found.length;
  const events = found.slice(0, limit).map((entry) => entry.event);
  const truncatedReason: EventTruncation | null =
    recurrenceTruncation ?? (total > limit ? "limit" : null);
  return {
    calendar: collection.name,
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
  if (!RESOURCE_ID.test(input.id) || input.id === "." || input.id === "..") {
    throw new ApiError(400, "invalid_request", `invalid event id ${JSON.stringify(input.id)}`);
  }

  const limits = calendarLimits(env);
  const caps = capsOf(limits);
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

  const collection = await resolveCollection(env, "calendar", input.calendar, {
    fetchImpl: options.fetchImpl,
  });
  const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
  const { homeUrl } = await caldav.discover();
  const href = new URL(resourcePath(collection.id, input.id), homeUrl).pathname;
  const response = await caldav.report(
    collectionPath(collection.id),
    calendarMultiget([href]),
    1,
  );
  const entries = parseMultistatus(response.body);

  let match: DavResponse | null = null;
  for (const entry of entries) {
    const entryId = resourceIdFromHref(entry.href, collection.id);
    if (entryId !== input.id) {
      throw new CalDavError("malformed", 0, "the calendar-multiget returned an unrelated href");
    }
    if (match !== null) {
      throw new CalDavError("malformed", 0, "the calendar-multiget returned the event more than once");
    }
    match = entry;
  }
  if (match === null || match.status === 404) {
    throw new CalDavError("not_found", 404, `the event ${JSON.stringify(input.id)} was not found`);
  }
  if (match.status !== null && match.status >= 400) {
    throw new CalDavError(
      match.status === 403 ? "forbidden" : "upstream_error",
      match.status,
      `iCloud returned ${match.status} for the event ${JSON.stringify(input.id)}`,
    );
  }

  const ics = calendarData(match);
  if (ics === null) {
    throw new CalDavError("malformed", 0, "the event response has no calendar-data");
  }
  const rawBytes = byteLength(ics);
  if (rawBytes > limits.maxResourceBytes) {
    throw new ApiError(
      422,
      "resource_too_large",
      `resource ${JSON.stringify(input.id)} is ${rawBytes} bytes; MAX_RESOURCE_BYTES is ` +
        `${limits.maxResourceBytes}.`,
    );
  }

  const etag = propText(match, "getetag")?.trim() ?? "";
  if (etag === "" || !ETAG.test(etag)) {
    throw new CalDavError("malformed", 0, "the event has no usable ETag");
  }

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
    readOnlyReason: readOnlyReason(parsed),
    recurrenceRule: parsed.master.rruleText,
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
