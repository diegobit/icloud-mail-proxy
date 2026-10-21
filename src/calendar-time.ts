// Shared parsing and formatting for calendar and reminder tool arguments.
//
// Event windows and reminder due bounds accept the same strict forms: a bare
// YYYY-MM-DD, or a date-time with an optional Z/offset. A value without an
// offset is read in DEFAULT_TIME_ZONE by the caller, never by guessing UTC.
// Formatting keeps the resource's own zone: a TZID value is rendered with the
// offset in effect at that instant, a Z value with Z, a DATE as a bare date.

import { ApiError } from "./core";
import type { IcalTime } from "./ical";
import {
  assertWallClock,
  dateOf,
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

export const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/;

export interface Bound {
  instant: number;
  /** The date of the bound in the display zone. */
  date: DateParts;
}

function invalid(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}

/** Parse a strict YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[Z|±HH:MM] value. */
export function parseBoundValue(
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

export function resolveBound(value: string, label: string, zone: string): Bound {
  const parsed = parseBoundValue(value, label);
  const instant =
    parsed.offsetMinutes === null
      ? wallClockToUtc(zone, parsed.wall)
      : wallAsUtcMs(parsed.wall) - parsed.offsetMinutes * 60_000;
  return { instant, date: dateOf(wallClockInZone(zone, instant)) };
}

export function midnight(date: DateParts, zone: string): number {
  return wallClockToUtc(zone, { ...date, hour: 0, minute: 0, second: 0 });
}

export function today(now: number, zone: string): DateParts {
  return dateOf(wallClockInZone(zone, now));
}

export function assertSupportedYear(date: DateParts, label: string): void {
  if (date.year < 2 || date.year > 9998) {
    throw new ApiError(
      400,
      "invalid_request",
      `${label} is outside the supported years (2-9998)`,
    );
  }
}

/** UTC iCalendar timestamp for a CalDAV time-range. */
export function icsUtc(instant: number): string {
  const wall = wallFromUtcMs(instant);
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return (
    `${pad(wall.year, 4)}${pad(wall.month, 2)}${pad(wall.day, 2)}` +
    `T${pad(wall.hour, 2)}${pad(wall.minute, 2)}${pad(wall.second, 2)}Z`
  );
}

/** ISO 8601 with offset for timed values, YYYY-MM-DD for all-day, null if floating. */
export function formatAbsolute(time: IcalTime): string | null {
  if (time.dateOnly) return isoDate(dateOf(time.wall));
  if (time.utc === null) return null;
  return isoInZone(time.utc, time.timeZone ?? "UTC");
}

/** The wall-clock reading, with midnight for a DATE. */
export function formatWall(time: IcalTime): string {
  return time.dateOnly ? `${isoDate(dateOf(time.wall))}T00:00:00` : isoWall(time.wall);
}

export function formatRecurrenceId(time: IcalTime): string {
  if (time.dateOnly) return isoDate(dateOf(time.wall));
  if (time.utc === null) return isoWall(time.wall);
  return isoInZone(time.utc, time.timeZone ?? "UTC");
}
