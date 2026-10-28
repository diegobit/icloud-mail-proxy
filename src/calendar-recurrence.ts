// The one repeat shape the writer accepts: a single simple RRULE.
//
// plans/feature-gap-roadmap.md, unit 7. An open-ended series is refused so a
// created event always has a bound the read-side recurrence budget can meet,
// and the rule is limited to the keys `isSimpleSeries` accepts, so a series the
// writer creates can always be updated or deleted through the same API. Times
// are not part of the rule: DTSTART carries the anchor and, for a timed series,
// the IANA TZID that keeps the local clock steady across a DST change.

import { ApiError } from "./core";
import { icsDate, icsUtc, parseDateOnly, parseWallDateTime } from "./calendar-time";
import { compareDates, dateOf, daysInMonth, wallClockToUtc, weekday, type DateParts } from "./tz";

export const RECURRENCE_FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY"] as const;
export type RecurrenceFrequency = (typeof RECURRENCE_FREQUENCIES)[number];

const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
type WeekdayCode = (typeof WEEKDAY_CODES)[number];

/** 0 = Sunday through 6 = Saturday, matching tz.weekday. */
const WEEKDAY_NUMBERS: Record<WeekdayCode, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

export const MAX_RECURRENCE_INTERVAL = 12;
/** A hard ceiling on UNTIL, independent of MAX_RECURRENCE_COUNT. */
export const MAX_RECURRENCE_YEARS = 2;

export interface RecurrenceInput {
  freq: string;
  interval?: number;
  /** Weekday codes; only with WEEKLY. */
  byDay?: string[];
  count?: number;
  /** Wall clock YYYY-MM-DDTHH:MM:SS for a timed series, YYYY-MM-DD for all-day. */
  until?: string;
}

export interface ResolvedRecurrence {
  /** The RRULE value, without the `RRULE:` prefix. */
  text: string;
  count: number | null;
  /** UTC instant of UNTIL for a timed series. */
  untilInstant: number | null;
  /** UNTIL for an all-day series. */
  untilDate: DateParts | null;
}

export interface RecurrenceContext {
  allDay: boolean;
  /** IANA zone of a timed series; ignored for all-day. */
  zone: string | null;
  /** Start date in the event's zone, used for the two-year bound. */
  startDate: DateParts;
  /** Start instant, for the timed lower bound. */
  startInstant: number | null;
  maxCount: number;
}

function invalid(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}

/** Validate the caller's repeat and render the single RRULE line value. */
export function resolveRecurrence(
  input: RecurrenceInput,
  context: RecurrenceContext,
): ResolvedRecurrence {
  const freq = String(input.freq ?? "").toUpperCase();
  if (!(RECURRENCE_FREQUENCIES as readonly string[]).includes(freq)) {
    invalid(`recurrence.freq must be one of ${RECURRENCE_FREQUENCIES.join(", ")}`);
  }

  const interval = input.interval ?? 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_RECURRENCE_INTERVAL) {
    invalid(`recurrence.interval must be an integer from 1 to ${MAX_RECURRENCE_INTERVAL}`);
  }

  const byDay = resolveByDay(input.byDay, freq, context.startDate);

  if (input.count === undefined && input.until === undefined) {
    invalid("recurrence needs exactly one of count and until: an open-ended series is not supported");
  }
  if (input.count !== undefined && input.until !== undefined) {
    invalid("recurrence accepts count or until, not both");
  }

  const until = input.until === undefined ? null : resolveUntil(input.until, context);
  let count: number | null = null;
  if (input.count !== undefined) {
    if (!Number.isInteger(input.count) || input.count < 1 || input.count > context.maxCount) {
      invalid(`recurrence.count must be an integer from 1 to ${context.maxCount}`);
    }
    count = input.count;
  }

  const parts = [`FREQ=${freq}`];
  if (interval !== 1) parts.push(`INTERVAL=${interval}`);
  if (byDay.length > 0) parts.push(`BYDAY=${byDay.join(",")}`);
  if (count !== null) {
    parts.push(`COUNT=${count}`);
  } else if (until !== null) {
    parts.push(`UNTIL=${until.dateOnly ? icsDate(until.date) : icsUtc(until.instant)}`);
  }

  return {
    text: parts.join(";"),
    count,
    untilInstant: until === null || until.dateOnly ? null : until.instant,
    untilDate: until !== null && until.dateOnly ? until.date : null,
  };
}

function resolveByDay(
  value: string[] | undefined,
  freq: string,
  startDate: DateParts,
): WeekdayCode[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid("recurrence.byDay must be an array of weekday codes");
  if (freq !== "WEEKLY") invalid("recurrence.byDay only applies to a WEEKLY series");
  if (value.length === 0) invalid("recurrence.byDay must name at least one weekday");
  if (value.length > 7) invalid("recurrence.byDay accepts at most seven weekdays");
  const days: WeekdayCode[] = [];
  for (const entry of value) {
    const code = String(entry).toUpperCase();
    if (!(WEEKDAY_CODES as readonly string[]).includes(code)) {
      invalid(`recurrence.byDay value ${JSON.stringify(entry)} is not one of ${WEEKDAY_CODES.join(", ")}`);
    }
    if (!days.includes(code as WeekdayCode)) days.push(code as WeekdayCode);
  }
  // RFC 5545 3.8.5.3: a rule whose BYDAY excludes DTSTART's weekday is
  // undefined, and iCloud's expansion of it is not something to guess at.
  const startCode = (Object.keys(WEEKDAY_NUMBERS) as WeekdayCode[])
    .find((code) => WEEKDAY_NUMBERS[code] === weekday(startDate));
  if (startCode !== undefined && !days.includes(startCode)) {
    invalid(`recurrence.byDay must include the start weekday ${startCode}`);
  }
  return days;
}

type ResolvedUntil =
  | { dateOnly: true; date: DateParts }
  | { dateOnly: false; date: DateParts; instant: number };

function resolveUntil(value: string, context: RecurrenceContext): ResolvedUntil {
  const limit = addYearsClamped(context.startDate, MAX_RECURRENCE_YEARS);
  if (context.allDay) {
    const date = parseDateOnly(value, "recurrence.until");
    assertUntilWindow(date, limit, context.startDate);
    return { dateOnly: true, date };
  }

  const zone = context.zone;
  if (zone === null) invalid("a timed series needs a time zone");
  const wall = parseWallDateTime(value, "recurrence.until");
  const instant = wallClockToUtc(zone, wall);
  assertUntilWindow(dateOf(wall), limit, context.startDate);
  if (context.startInstant !== null && instant < context.startInstant) {
    invalid("recurrence.until must not be before start");
  }
  return { dateOnly: false, date: dateOf(wall), instant };
}

function assertUntilWindow(until: DateParts, limit: DateParts, start: DateParts): void {
  if (compareDates(until, start) < 0) {
    invalid("recurrence.until must not be before start");
  }
  if (compareDates(until, limit) > 0) {
    invalid(`recurrence.until must be within ${MAX_RECURRENCE_YEARS} years of start`);
  }
}

/** Add whole years, clamping 29 February to the last day of the target month. */
export function addYearsClamped(date: DateParts, years: number): DateParts {
  const year = Math.min(date.year + years, 9999);
  const day = Math.min(date.day, daysInMonth(year, date.month));
  return { year, month: date.month, day };
}
