// Time-zone arithmetic for CalDAV data, using Intl only.
//
// ical.js bundles no IANA database and its TimezoneService is global, so a
// zone registered for one request would leak into the next one in the same
// isolate. Intl carries the platform's tz database instead: no registration,
// no global state, and no dependency on a VTIMEZONE block that a remote
// resource controls.
//
// Wall-clock conversion follows RFC 5545 section 3.3.5: an ambiguous time
// (the repeated hour when DST ends) resolves to the first occurrence, and a
// skipped time (the missing hour when DST starts) is interpreted with the UTC
// offset in effect *before* the gap. For Europe/Rome that turns 02:30 on the
// spring-forward day into 03:30 local, which is what RFC 5545 specifies.

/** A date and time as written on a clock, with no zone attached. */
export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second: number; // 0-59
}

export interface DateParts {
  year: number;
  month: number;
  day: number;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const FORMATTER_LIMIT = 64;
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9._+\-/]{0,63}$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  if (!ZONE_NAME.test(zone)) throw new RangeError(`not a usable IANA time zone: ${JSON.stringify(zone)}`);
  const cached = formatters.get(zone);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatters.delete(zone);
  formatters.set(zone, formatter);
  while (formatters.size > FORMATTER_LIMIT) {
    const oldest = formatters.keys().next().value;
    if (oldest === undefined) break;
    formatters.delete(oldest);
  }
  return formatter;
}

function offsetOf(name: string): number | null {
  if (name === "GMT" || name === "UTC") return 0;
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(name);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = match[3] === undefined ? 0 : Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  const total = hours * 60 + minutes;
  return match[1] === "-" ? -total : total;
}

/** UTC offset of `zone` at an instant, in minutes east of UTC. */
export function offsetMinutes(zone: string, instantMs: number): number {
  if (!Number.isFinite(instantMs)) throw new RangeError("the instant is not a finite number");
  const parts = formatterFor(zone).formatToParts(new Date(instantMs));
  const name = parts.find((part) => part.type === "timeZoneName")?.value;
  if (name === undefined) throw new RangeError(`Intl did not report an offset for ${zone}`);
  const offset = offsetOf(name);
  if (offset === null) throw new RangeError(`Intl reported an unusable offset for ${zone}: ${name}`);
  return offset;
}

/** Like `offsetMinutes`, but null for a zone Intl does not know. */
export function tryOffsetMinutes(zone: string, instantMs: number): number | null {
  try {
    return offsetMinutes(zone, instantMs);
  } catch {
    return null;
  }
}

/** The local clock in `zone` at an instant. */
export function wallClockInZone(zone: string, instantMs: number): WallClock {
  if (!Number.isFinite(instantMs)) throw new RangeError("the instant is not a finite number");
  const parts = formatterFor(zone).formatToParts(new Date(instantMs));
  const field = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (value === undefined) throw new RangeError(`Intl did not report ${type} for ${zone}`);
    return Number(value);
  };
  return {
    year: field("year"),
    month: field("month"),
    day: field("day"),
    hour: field("hour"),
    minute: field("minute"),
    second: field("second"),
  };
}

/** Milliseconds for a wall-clock reading taken as if it were UTC. */
export function wallAsUtcMs(wall: WallClock): number {
  assertWallClock(wall);
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hour, wall.minute, wall.second, 0);
  return date.getTime();
}

export function wallFromUtcMs(instantMs: number): WallClock {
  const date = new Date(instantMs);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
  };
}

function sameWall(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute &&
    a.second === b.second
  );
}

/**
 * The instant at which `zone`'s clock reads `wall`.
 *
 * A repeated wall-clock reading (the end of DST) resolves to the earlier
 * instant. A skipped reading (the start of DST) uses the offset in effect
 * before the transition, so 02:30 on a spring-forward day lands at 03:30
 * local rather than 01:30.
 */
export function wallClockToUtc(zone: string, wall: WallClock): number {
  assertWallClock(wall);
  const naive = wallAsUtcMs(wall);

  // Probe both sides of the nearest transitions: two days is more than any
  // real transition window, and 26 hours covers an ambiguous reading without
  // assuming the transition happens at a round hour.
  const offsets = new Set<number>();
  for (const delta of [-2 * DAY_MS, -DAY_MS, 0, DAY_MS, 2 * DAY_MS]) {
    offsets.add(offsetMinutes(zone, naive + delta));
  }
  offsets.add(offsetMinutes(zone, naive - 26 * HOUR_MS));
  offsets.add(offsetMinutes(zone, naive + 26 * HOUR_MS));

  const candidates: number[] = [];
  for (const offset of offsets) {
    const instant = naive - offset * MINUTE_MS;
    if (sameWall(wallClockInZone(zone, instant), wall)) candidates.push(instant);
  }
  if (candidates.length > 0) return Math.min(...candidates);

  // No offset maps to this reading: it is in a gap. Find the offset in effect
  // immediately before the transition that created the gap.
  let before = offsetMinutes(zone, naive - 2 * DAY_MS);
  let low = naive - 2 * DAY_MS;
  let high = naive + 2 * DAY_MS;
  const lowOffset = offsetMinutes(zone, low);
  const highOffset = offsetMinutes(zone, high);
  if (lowOffset !== highOffset) {
    for (let step = 0; step < 40 && high - low > 1000; step += 1) {
      const middle = Math.floor((low + high) / 2);
      if (offsetMinutes(zone, middle) === lowOffset) low = middle;
      else high = middle;
    }
    before = offsetMinutes(zone, low);
  }
  return naive - before * MINUTE_MS;
}

/** ISO 8601 wall-clock text without a zone: YYYY-MM-DDTHH:MM:SS. */
export function isoWall(wall: WallClock): string {
  assertWallClock(wall);
  return (
    `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}` +
    `T${pad(wall.hour, 2)}:${pad(wall.minute, 2)}:${pad(wall.second, 2)}`
  );
}

/** ISO 8601 date: YYYY-MM-DD. */
export function isoDate(parts: DateParts): string {
  assertDateParts(parts);
  return `${pad(parts.year, 4)}-${pad(parts.month, 2)}-${pad(parts.day, 2)}`;
}

/** Offset in ISO form: +02:00, -04:00, +00:00. */
export function formatOffset(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || Math.abs(minutes) > 24 * 60) {
    throw new RangeError(`not a valid UTC offset: ${minutes}`);
  }
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`;
}

/** ISO 8601 with the zone's offset at that instant, or Z for UTC. */
export function isoInZone(instantMs: number, zone: string): string {
  const wall = wallClockInZone(zone, instantMs);
  const offset = offsetMinutes(zone, instantMs);
  return `${isoWall(wall)}${offset === 0 ? "Z" : formatOffset(offset)}`;
}

export function dateOf(wall: WallClock): DateParts {
  return { year: wall.year, month: wall.month, day: wall.day };
}

export function addDays(date: DateParts, days: number): DateParts {
  assertDateParts(date);
  if (!Number.isSafeInteger(days)) throw new RangeError("the day count is not an integer");
  const parsed = new Date(wallAsUtcMs({ ...date, hour: 0, minute: 0, second: 0 }));
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
  };
}

/** Whole days from `a` to `b`, positive when `b` is later. */
export function daysBetween(a: DateParts, b: DateParts): number {
  assertDateParts(a);
  assertDateParts(b);
  return Math.round(
    (wallAsUtcMs({ ...b, hour: 0, minute: 0, second: 0 }) -
      wallAsUtcMs({ ...a, hour: 0, minute: 0, second: 0 })) /
      DAY_MS,
  );
}

/** 0 = Sunday through 6 = Saturday. */
export function weekday(date: DateParts): number {
  assertDateParts(date);
  return new Date(wallAsUtcMs({ ...date, hour: 0, minute: 0, second: 0 })).getUTCDay();
}

export function daysInMonth(year: number, month: number): number {
  if (!Number.isSafeInteger(year) || year < 1 || year > 9999) throw new RangeError("the year is out of range");
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) throw new RangeError("the month is out of range");
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function compareDates(a: DateParts, b: DateParts): number {
  if (a.year !== b.year) return a.year < b.year ? -1 : 1;
  if (a.month !== b.month) return a.month < b.month ? -1 : 1;
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  return 0;
}

export function clampWallToDate(wall: WallClock): WallClock {
  return { ...wall, hour: 0, minute: 0, second: 0 };
}

export function assertWallClock(wall: WallClock): void {
  if (
    !Number.isSafeInteger(wall.year) ||
    wall.year < 1 ||
    wall.year > 9999 ||
    !Number.isSafeInteger(wall.month) ||
    wall.month < 1 ||
    wall.month > 12 ||
    !Number.isSafeInteger(wall.day) ||
    wall.day < 1 ||
    wall.day > daysInMonth(wall.year, wall.month) ||
    !Number.isSafeInteger(wall.hour) ||
    wall.hour < 0 ||
    wall.hour > 23 ||
    !Number.isSafeInteger(wall.minute) ||
    wall.minute < 0 ||
    wall.minute > 59 ||
    !Number.isSafeInteger(wall.second) ||
    wall.second < 0 ||
    wall.second > 59
  ) {
    throw new RangeError(`not a valid wall-clock time: ${JSON.stringify(wall)}`);
  }
}

function assertDateParts(date: DateParts): void {
  if (
    !Number.isSafeInteger(date.year) ||
    date.year < 1 ||
    date.year > 9999 ||
    !Number.isSafeInteger(date.month) ||
    date.month < 1 ||
    date.month > 12 ||
    !Number.isSafeInteger(date.day) ||
    date.day < 1 ||
    date.day > daysInMonth(date.year, date.month)
  ) {
    throw new RangeError(`not a valid calendar date: ${JSON.stringify(date)}`);
  }
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}
