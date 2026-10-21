// iCalendar parsing, bounded recurrence expansion and safe mutation.
//
// ical.js is used as a parser and serializer only. Its Event, Time, Timezone
// and recurrence iterator types are deliberately never constructed: the
// iterator's internal loops cannot be metered, and the TimezoneService is
// global to the isolate. Values stay in jCal form, instants are resolved with
// Intl through src/tz.ts, and the recurrence cursor lives below.
//
// A resource is one VCALENDAR containing one component type (VEVENT or VTODO),
// one master, and zero or more RECURRENCE-ID overrides that share the master's
// UID.

import ICAL from "ical.js";
import { CalDavError } from "./caldav";
import { DEFAULT_TIME_ZONE } from "./calendar-config";
import {
  addDays,
  compareDates,
  dateOf,
  daysBetween,
  daysInMonth,
  isoDate,
  isoWall,
  wallAsUtcMs,
  wallClockInZone,
  wallClockToUtc,
  wallFromUtcMs,
  weekday,
  type DateParts,
  type WallClock,
} from "./tz";

// --- jCal shapes -----------------------------------------------------------

type JCalParameter = string | string[];
type JCalParams = Record<string, JCalParameter>;

export type JCalProperty = [string, JCalParams, string, ...unknown[]];
export type JCalComponent = [string, JCalProperty[], JCalComponent[]];

export type ComponentKind = "VEVENT" | "VTODO";

export interface IcalCaps {
  maxRdateExdate: number;
  maxRecurrenceCandidatesPerRule: number;
  maxRecurrenceCandidatesPerRequest: number;
  maxOccurrencesPerResource: number;
}

const DEFAULT_CAPS: IcalCaps = {
  maxRdateExdate: 500,
  maxRecurrenceCandidatesPerRule: 50_000,
  maxRecurrenceCandidatesPerRequest: 200_000,
  maxOccurrencesPerResource: 200,
};

const MAX_INTERVAL = 52;
const MAX_COUNT = 1000;
const MAX_RULE_SPAN_YEARS = 10;
const MAX_DURATION_DAYS = 3660;
const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z)?$/;
const DURATION_RE = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const BYDAY_RE = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/;
const FREQUENCIES = new Set(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"]);
const WEEKDAY_NAMES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const WEEKDAY_NUMBERS: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};
const RULE_KEYS = new Set([
  "freq",
  "interval",
  "count",
  "until",
  "byday",
  "bymonthday",
  "bymonth",
  "wkst",
]);
const TEXT_PROPERTIES = ["summary", "description", "location", "status"] as const;

// --- Public time model -----------------------------------------------------

export interface IcalTime {
  dateOnly: boolean;
  /** The clock reading as written in the property. */
  wall: WallClock;
  /** TZID as written, when the property carried one. */
  timeZone: string | null;
  /** Absolute instant, or null for DATE, floating and unresolved values. */
  utc: number | null;
  /** True when a TZID was present but Intl could not resolve it. */
  unresolved: boolean;
  /** The normalized jCal value this reading came from. */
  raw: string;
}

export interface ByDay {
  ordinal: number | null;
  weekday: number;
}

export interface RecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count: number | null;
  until: IcalTime | null;
  byDay: ByDay[];
  byMonthDay: number[];
  byMonth: number[];
  weekStart: number;
  text: string;
}

export interface ParsedComponent {
  kind: ComponentKind;
  /** Position among the VCALENDAR's subcomponents. */
  index: number;
  uid: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  status: string | null;
  priority: number | null;
  percentComplete: number | null;
  completed: IcalTime | null;
  start: IcalTime | null;
  due: IcalTime | null;
  end: IcalTime | null;
  allDay: boolean;
  /** Exact duration for date-time values. */
  durationMs: number | null;
  /** Whole-day duration for DATE values. */
  durationDays: number | null;
  rrule: RecurrenceRule | null;
  rruleText: string | null;
  rdate: IcalTime[];
  exdate: IcalTime[];
  recurrenceId: IcalTime | null;
  rangeThisAndFuture: boolean;
  organizer: boolean;
  attendee: boolean;
  alarms: number;
  jcal: JCalComponent;
}

export interface ParsedResource {
  kind: ComponentKind;
  uid: string;
  master: ParsedComponent;
  overrides: ParsedComponent[];
  components: ParsedComponent[];
  recurring: boolean;
  scheduling: boolean;
  unsupportedRange: boolean;
  jcal: JCalComponent;
  ics: string;
}

// --- Errors ----------------------------------------------------------------

function malformed(message: string): CalDavError {
  return new CalDavError("malformed", 0, message);
}

function tooComplex(message: string): CalDavError {
  return new CalDavError("recurrence_too_complex", 0, message);
}

function invalid(message: string): CalDavError {
  return new CalDavError("invalid_argument", 0, message);
}

// --- jCal helpers ----------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function propertiesOf(component: JCalComponent, name: string): JCalProperty[] {
  return component[1].filter((property) => property[0] === name);
}

function propertyOf(component: JCalComponent, name: string): JCalProperty | null {
  return propertiesOf(component, name)[0] ?? null;
}

function parameterOf(property: JCalProperty | null, name: string): string | null {
  if (property === null) return null;
  const value = property[1][name];
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw malformed(`the ${property[0]} property has an ambiguous ${name} parameter`);
    return value[0] ?? null;
  }
  return value;
}

function textOfComponent(component: JCalComponent, name: string): string | null {
  const property = propertyOf(component, name);
  if (property === null) return null;
  const value = property[3];
  return typeof value === "string" ? value : null;
}

function integerOfComponent(component: JCalComponent, name: string): number | null {
  const property = propertyOf(component, name);
  if (property === null) return null;
  const value = property[3];
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

// --- Time parsing ----------------------------------------------------------

export function timeKey(time: IcalTime): string {
  if (time.dateOnly) return `D:${isoDate(dateOf(time.wall))}`;
  if (time.utc !== null) return `T:${time.utc}`;
  return `F:${isoWall(time.wall)}`;
}

function parseTimeProperty(property: JCalProperty, label: string): IcalTime {
  const type = property[2];
  if (type !== "date" && type !== "date-time") {
    throw malformed(`${label} is not a DATE or DATE-TIME value`);
  }
  if (property.length < 4) throw malformed(`${label} has no value`);
  const raw = property[3];
  if (typeof raw !== "string") throw malformed(`${label} has a non-text value`);
  return parseTimeValue(raw, property[1], type, label);
}

function parseTimeValue(
  raw: string,
  params: JCalParams,
  type: "date" | "date-time",
  label: string,
): IcalTime {
  const tzid = parameterFromParams(params, "tzid");
  if (type === "date") {
    if (tzid !== null) throw malformed(`${label} is a DATE with a TZID`);
    const wall = parseDateValue(raw, label);
    return { dateOnly: true, wall, timeZone: null, utc: null, unresolved: false, raw };
  }

  const match = DATE_TIME_RE.exec(raw);
  if (!match) throw malformed(`${label} is not a valid DATE-TIME value`);
  const wall: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
  };
  assertWall(wall, label);
  const utcSuffix = match[7] === "Z";
  if (utcSuffix && tzid !== null) throw malformed(`${label} is UTC and also carries a TZID`);

  if (utcSuffix) {
    return { dateOnly: false, wall, timeZone: null, utc: wallAsUtcMs(wall), unresolved: false, raw };
  }
  if (tzid !== null) {
    const instant = tryZoneInstant(tzid, wall);
    if (instant === null) {
      return { dateOnly: false, wall, timeZone: tzid, utc: null, unresolved: true, raw };
    }
    return {
      dateOnly: false,
      wall,
      timeZone: tzid,
      utc: wallClockToUtc(tzid, wall),
      unresolved: false,
      raw,
    };
  }
  return { dateOnly: false, wall, timeZone: null, utc: null, unresolved: false, raw };
}

function parameterFromParams(params: JCalParams, name: string): string | null {
  const value = params[name];
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length !== 1) throw malformed(`an ambiguous ${name} parameter`);
    return value[0] ?? null;
  }
  return value;
}

function parseDateValue(raw: string, label: string): WallClock {
  const match = DATE_RE.exec(raw);
  if (!match) throw malformed(`${label} is not a valid DATE value`);
  const wall: WallClock = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
  };
  assertWall(wall, label);
  return wall;
}

function assertWall(wall: WallClock, label: string): void {
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
    throw malformed(`${label} is not a valid date or time`);
  }
}

function tryZoneInstant(zone: string, wall: WallClock): number | null {
  try {
    // Validate the zone before asking for an instant: wallClockToUtc would
    // throw for an unknown TZID, and an unknown zone must stay floating.
    return wallClockToUtc(zone, wall);
  } catch {
    return null;
  }
}

// --- Duration --------------------------------------------------------------

interface ParsedDuration {
  seconds: number;
}

function parseDurationProperty(property: JCalProperty, label: string): ParsedDuration {
  const value = property[3];
  if (typeof value !== "string") throw malformed(`${label} is not a duration`);
  const match = DURATION_RE.exec(value);
  if (!match) throw malformed(`${label} is not a valid iCalendar duration`);
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  if (weeks === undefined && days === undefined && hours === undefined && minutes === undefined && seconds === undefined) {
    throw malformed(`${label} is an empty duration`);
  }
  const totalSeconds =
    Number(weeks ?? 0) * 7 * 86_400 +
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);
  if (sign === "-" && totalSeconds > 0) throw malformed(`${label} is negative`);
  if (totalSeconds > MAX_DURATION_DAYS * 86_400) throw malformed(`${label} is longer than ${MAX_DURATION_DAYS} days`);
  return { seconds: totalSeconds };
}

// --- Recurrence rule parsing ----------------------------------------------

function parseRule(property: JCalProperty, start: IcalTime): RecurrenceRule {
  const value = property[3];
  if (!isRecord(value)) throw tooComplex("the RRULE value is not a recurrence object");
  for (const key of Object.keys(value)) {
    if (!RULE_KEYS.has(key)) throw tooComplex(`RRULE ${key.toUpperCase()} is not supported`);
  }

  const freq = String(value.freq ?? "").toUpperCase();
  if (!FREQUENCIES.has(freq)) throw tooComplex(`RRULE FREQ=${freq || "?"} is not supported`);
  const interval = parseInteger(value.interval, 1, "RRULE INTERVAL");
  if (interval < 1 || interval > MAX_INTERVAL) {
    throw tooComplex(`RRULE INTERVAL must be between 1 and ${MAX_INTERVAL}`);
  }
  const count = value.count === undefined ? null : parseInteger(value.count, 1, "RRULE COUNT");
  if (count !== null && (count < 1 || count > MAX_COUNT)) {
    throw tooComplex(`RRULE COUNT must be between 1 and ${MAX_COUNT}`);
  }

  const until = value.until === undefined ? null : parseUntil(String(value.until), start);
  if (count !== null && until !== null) throw tooComplex("RRULE has both COUNT and UNTIL");

  const byDay = parseByDay(value.byday);
  const byMonthDay = parseNumberList(value.bymonthday, "RRULE BYMONTHDAY");
  const byMonth = parseNumberList(value.bymonth, "RRULE BYMONTH");
  const weekStart = value.wkst === undefined ? 1 : parseInteger(value.wkst, 1, "RRULE WKST") - 1;

  if (byMonthDay.length > 31) throw tooComplex("RRULE BYMONTHDAY has too many values");
  if (byMonth.length > 12) throw tooComplex("RRULE BYMONTH has too many values");
  for (const day of byMonthDay) {
    if (day === 0 || day < -31 || day > 31) throw tooComplex("RRULE BYMONTHDAY is out of range");
  }
  for (const month of byMonth) {
    if (month < 1 || month > 12) throw tooComplex("RRULE BYMONTH is out of range");
  }
  if (weekStart < 0 || weekStart > 6) throw tooComplex("RRULE WKST is out of range");
  if (freq === "WEEKLY" && byMonthDay.length > 0) {
    throw tooComplex("RRULE BYMONTHDAY cannot be combined with WEEKLY");
  }
  if ((freq === "DAILY" || freq === "WEEKLY") && byDay.some((day) => day.ordinal !== null)) {
    throw tooComplex("RRULE ordinal BYDAY needs MONTHLY or YEARLY");
  }
  if (byDay.some((day) => day.ordinal !== null && Math.abs(day.ordinal) > 53)) {
    throw tooComplex("RRULE BYDAY ordinal is out of range");
  }
  assertPossibleIntersection(start, byMonth, byMonthDay, byDay);

  const rule: RecurrenceRule = {
    freq: freq as RecurrenceRule["freq"],
    interval,
    count,
    until,
    byDay,
    byMonthDay,
    byMonth,
    weekStart,
    text: "",
  };
  rule.text = formatRule(rule);
  return rule;
}

function parseInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) throw tooComplex(`${label} is not an integer`);
  return parsed;
}

function parseNumberList(value: unknown, label: string): number[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  const parsed = values.map((entry) => {
    const number = typeof entry === "number" ? entry : Number(entry);
    if (!Number.isSafeInteger(number)) throw tooComplex(`${label} is not an integer list`);
    return number;
  });
  return [...new Set(parsed)];
}

function parseByDay(value: unknown): ByDay[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > 7) throw tooComplex("RRULE BYDAY has more than seven values");
  const parsed: ByDay[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    const match = BYDAY_RE.exec(String(entry).toUpperCase());
    if (!match) throw tooComplex(`RRULE BYDAY value ${String(entry)} is not supported`);
    const ordinal = match[1] === undefined ? null : Number(match[1]);
    if (ordinal === 0) throw tooComplex("RRULE BYDAY ordinal cannot be zero");
    const weekdayNumber = WEEKDAY_NUMBERS[match[2]!]!;
    const key = `${ordinal ?? ""}:${weekdayNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ ordinal, weekday: weekdayNumber });
  }
  return parsed;
}

function parseUntil(raw: string, start: IcalTime): IcalTime {
  const dateMatch = DATE_RE.exec(raw);
  if (dateMatch) {
    if (!start.dateOnly) throw tooComplex("RRULE UNTIL is a DATE but DTSTART is a DATE-TIME");
    const wall = parseDateValue(raw, "RRULE UNTIL");
    return { dateOnly: true, wall, timeZone: null, utc: null, unresolved: false, raw };
  }
  const dateTimeMatch = DATE_TIME_RE.exec(raw);
  if (!dateTimeMatch) throw tooComplex("RRULE UNTIL is not a valid date or date-time");
  if (start.dateOnly) throw tooComplex("RRULE UNTIL is a DATE-TIME but DTSTART is a DATE");
  if (dateTimeMatch[7] !== "Z") throw tooComplex("RRULE UNTIL must be UTC");
  if (start.utc === null) throw tooComplex("RRULE UNTIL needs an absolute DTSTART");
  const wall: WallClock = {
    year: Number(dateTimeMatch[1]),
    month: Number(dateTimeMatch[2]),
    day: Number(dateTimeMatch[3]),
    hour: Number(dateTimeMatch[4]),
    minute: Number(dateTimeMatch[5]),
    second: Number(dateTimeMatch[6]),
  };
  assertWall(wall, "RRULE UNTIL");
  if (Math.abs(wall.year - start.wall.year) > MAX_RULE_SPAN_YEARS) {
    throw tooComplex(`RRULE UNTIL is more than ${MAX_RULE_SPAN_YEARS} years from DTSTART`);
  }
  return { dateOnly: false, wall, timeZone: null, utc: wallAsUtcMs(wall), unresolved: false, raw };
}

function assertPossibleIntersection(
  start: IcalTime,
  byMonth: number[],
  byMonthDay: number[],
  byDay: ByDay[],
): void {
  if (byMonth.length === 0) return;
  if (byMonthDay.length > 0) {
    // 2024 is a leap year, so February 29 counts as possible.
    const possible = byMonth.some((month) =>
      byMonthDay.some((day) => resolveMonthDay(2024, month, day) !== null),
    );
    if (!possible) throw tooComplex("RRULE BYMONTH and BYMONTHDAY never intersect");
    return;
  }
  if (byDay.length > 0) {
    if (byDay.every((day) => day.ordinal !== null && Math.abs(day.ordinal) > 5)) {
      throw tooComplex("RRULE BYMONTH and BYDAY never intersect");
    }
    return;
  }
  if (!byMonth.some((month) => start.wall.day <= daysInMonth(2024, month))) {
    throw tooComplex("RRULE BYMONTH never contains DTSTART's day of month");
  }
}

function formatRule(rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval !== 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.byMonth.length > 0) parts.push(`BYMONTH=${rule.byMonth.join(",")}`);
  if (rule.byMonthDay.length > 0) parts.push(`BYMONTHDAY=${rule.byMonthDay.join(",")}`);
  if (rule.byDay.length > 0) {
    parts.push(
      `BYDAY=${rule.byDay
        .map((day) => `${day.ordinal === null ? "" : day.ordinal}${WEEKDAY_NAMES[day.weekday]}`)
        .join(",")}`,
    );
  }
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  if (rule.until !== null) {
    if (rule.until.dateOnly) {
      parts.push(`UNTIL=${icsDate(rule.until.wall)}`);
    } else {
      parts.push(`UNTIL=${icsDateTimeUtc(rule.until.wall)}`);
    }
  }
  if (rule.weekStart !== 1) parts.push(`WKST=${WEEKDAY_NAMES[rule.weekStart]}`);
  return parts.join(";");
}

function icsDate(wall: WallClock): string {
  return `${String(wall.year).padStart(4, "0")}${String(wall.month).padStart(2, "0")}${String(wall.day).padStart(2, "0")}`;
}

function icsDateTimeUtc(wall: WallClock): string {
  return (
    `${icsDate(wall)}T` +
    `${String(wall.hour).padStart(2, "0")}${String(wall.minute).padStart(2, "0")}${String(wall.second).padStart(2, "0")}Z`
  );
}

// --- Component and resource parsing ---------------------------------------

export function parseResource(ics: string, options: Partial<IcalCaps> = {}): ParsedResource {
  const caps = resolveCaps(options);
  const jcal = parseJCal(ics);
  const children = jcal[2];
  const components: ParsedComponent[] = [];

  let kind: ComponentKind | null = null;
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const name = child[0].toUpperCase();
    if (name !== "VEVENT" && name !== "VTODO") continue;
    const componentKind = name as ComponentKind;
    if (kind === null) kind = componentKind;
    if (kind !== componentKind) throw malformed("a resource mixes VEVENT and VTODO components");
    components.push(parseComponent(child, componentKind, index, caps));
  }
  if (kind === null || components.length === 0) {
    throw malformed("the resource contains no VEVENT or VTODO component");
  }

  const firstUid = components[0]!.uid;
  for (const component of components) {
    if (component.uid !== firstUid) throw malformed("the components of a resource do not share one UID");
  }

  const masters = components.filter((component) => component.recurrenceId === null);
  if (masters.length !== 1) throw malformed("the resource must have exactly one master component");
  const master = masters[0]!;
  const overrides = components.filter((component) => component.recurrenceId !== null);
  if (kind === "VEVENT" && master.start === null) throw malformed("a VEVENT master has no DTSTART");
  for (const override of overrides) {
    if (override.start === null) throw malformed("a RECURRENCE-ID component has no DTSTART");
    if (override.rrule !== null || override.rdate.length > 0) {
      throw malformed("a RECURRENCE-ID component cannot carry its own recurrence rule");
    }
  }

  const recurring =
    master.rrule !== null ||
    master.rdate.length > 0 ||
    overrides.length > 0 ||
    master.jcal[1].some((property) => property[0] === "rrule" || property[0] === "rdate");
  const scheduling = components.some((component) => component.organizer || component.attendee);
  const unsupportedRange = components.some((component) => component.rangeThisAndFuture);

  return {
    kind,
    uid: firstUid,
    master,
    overrides,
    components,
    recurring,
    scheduling,
    unsupportedRange,
    jcal,
    ics,
  };
}

function parseJCal(ics: string): JCalComponent {
  let parsed: unknown;
  try {
    parsed = ICAL.parse(ics);
  } catch (error) {
    throw malformed(`the iCalendar data could not be parsed: ${messageOf(error)}`);
  }
  if (!Array.isArray(parsed) || parsed[0] !== "vcalendar") {
    throw malformed("the resource is not a single VCALENDAR");
  }
  if (!Array.isArray(parsed[1]) || !Array.isArray(parsed[2])) {
    throw malformed("the VCALENDAR has no property or component arrays");
  }
  return parsed as JCalComponent;
}

function parseComponent(
  jcal: JCalComponent,
  kind: ComponentKind,
  index: number,
  caps: IcalCaps,
): ParsedComponent {
  const uid = textOfComponent(jcal, "uid");
  if (uid === null || uid.trim() === "") throw malformed("a component has no UID");

  const startProperty = propertyOf(jcal, "dtstart");
  const start = startProperty === null ? null : parseTimeProperty(startProperty, "DTSTART");
  const endProperty = propertyOf(jcal, kind === "VEVENT" ? "dtend" : "due");
  const end = endProperty === null ? null : parseTimeProperty(endProperty, kind === "VEVENT" ? "DTEND" : "DUE");
  const due = kind === "VTODO" && endProperty !== null ? end : null;
  const durationProperties = propertiesOf(jcal, "duration");
  if (durationProperties.length > 1) throw malformed("a component has more than one DURATION");
  const durationProperty = durationProperties[0] ?? null;
  if (kind === "VEVENT" && end !== null && durationProperty !== null) {
    throw malformed("a VEVENT has both DTEND and DURATION");
  }
  if (kind === "VTODO" && end !== null && durationProperty !== null) {
    throw malformed("a VTODO has both DUE and DURATION");
  }

  const recurrenceProperty = propertyOf(jcal, "recurrence-id");
  const recurrenceId =
    recurrenceProperty === null ? null : parseTimeProperty(recurrenceProperty, "RECURRENCE-ID");
  const range = parameterOf(recurrenceProperty, "range")?.toUpperCase() ?? null;
  if (range !== null && range !== "THISANDFUTURE") throw malformed("RECURRENCE-ID has an unsupported RANGE");

  const rruleProperties = propertiesOf(jcal, "rrule");
  if (rruleProperties.length > 1) throw malformed("a component has more than one RRULE");
  const rdate = parseTimeList(jcal, "rdate", start, caps, "RDATE");
  const exdate = parseTimeList(jcal, "exdate", start, caps, "EXDATE");
  let rrule: RecurrenceRule | null = null;
  if (rruleProperties[0] !== undefined) {
    if (start === null) throw malformed("an RRULE needs a DTSTART");
    if (kind === "VEVENT") rrule = parseRule(rruleProperties[0], start);
  }

  const duration = computeDuration(kind, start, end, durationProperty);
  const status = textOfComponent(jcal, "status");
  const priority = integerOfComponent(jcal, "priority");
  const percentComplete = integerOfComponent(jcal, "percent-complete");
  const completedProperty = propertyOf(jcal, "completed");
  const completed =
    completedProperty === null ? null : parseTimeProperty(completedProperty, "COMPLETED");
  const alarmComponents = jcal[2].filter((child) => child[0].toUpperCase() === "VALARM");

  return {
    kind,
    index,
    uid,
    summary: textOfComponent(jcal, "summary"),
    description: textOfComponent(jcal, "description"),
    location: textOfComponent(jcal, "location"),
    status: status === null ? null : status.toUpperCase(),
    priority,
    percentComplete,
    completed,
    start,
    due,
    end,
    allDay: start?.dateOnly ?? due?.dateOnly ?? false,
    durationMs: duration?.ms ?? null,
    durationDays: duration?.days ?? null,
    rrule,
    rruleText: rrule?.text ?? null,
    rdate,
    exdate,
    recurrenceId,
    rangeThisAndFuture: range === "THISANDFUTURE",
    organizer: propertyOf(jcal, "organizer") !== null,
    attendee: propertyOf(jcal, "attendee") !== null,
    alarms: alarmComponents.length,
    jcal,
  };
}

function parseTimeList(
  component: JCalComponent,
  name: string,
  start: IcalTime | null,
  caps: IcalCaps,
  label: string,
): IcalTime[] {
  const list = propertiesOf(component, name);
  if (list.length === 0) return [];
  const entries = list.flatMap((property) => {
    if (property[2] === "period") throw tooComplex(`${label} PERIOD values are not supported`);
    if (property.length < 4) throw malformed(`${label} has no values`);
    return property.slice(3).map((value) => {
      if (typeof value !== "string") throw malformed(`${label} has a non-text value`);
      if (property[2] !== "date" && property[2] !== "date-time") {
        throw malformed(`${label} is not a DATE or DATE-TIME list`);
      }
      return parseTimeValue(value, property[1], property[2], label);
    });
  });
  if (entries.length > caps.maxRdateExdate) {
    throw tooComplex(`${label} has more than ${caps.maxRdateExdate} values`);
  }
  if (start !== null) {
    for (const entry of entries) {
      if (entry.dateOnly !== start.dateOnly) {
        throw malformed(`${label} values do not match DTSTART's value type`);
      }
    }
  }
  return entries;
}

function computeDuration(
  kind: ComponentKind,
  start: IcalTime | null,
  end: IcalTime | null,
  durationProperty: JCalProperty | null,
): { ms: number | null; days: number | null } | null {
  if (durationProperty !== null) {
    if (start === null) throw malformed("a DURATION needs a DTSTART");
    const parsed = parseDurationProperty(durationProperty, "DURATION");
    if (start.dateOnly) {
      if (parsed.seconds % 86_400 !== 0) throw malformed("an all-day duration is not whole days");
      return { ms: null, days: parsed.seconds / 86_400 };
    }
    return { ms: parsed.seconds * 1000, days: null };
  }
  if (start !== null && end !== null) {
    if (start.dateOnly !== end.dateOnly) throw malformed("DTSTART and the end value use different value types");
    if (start.dateOnly) {
      const days = daysBetween(dateOf(start.wall), dateOf(end.wall));
      if (days < 0) throw malformed("an event ends before it starts");
      return { ms: null, days };
    }
    if (start.utc !== null && end.utc !== null) {
      const ms = end.utc - start.utc;
      if (ms < 0) throw malformed("an event ends before it starts");
      return { ms, days: null };
    }
    if ((start.utc === null) !== (end.utc === null)) {
      throw malformed("DTSTART and DTEND mix absolute and floating values");
    }
    const ms = wallAsUtcMs(end.wall) - wallAsUtcMs(start.wall);
    if (ms < 0) throw malformed("an event ends before it starts");
    return { ms, days: null };
  }
  if (start === null) return null;
  if (kind === "VEVENT") {
    return start.dateOnly ? { ms: null, days: 1 } : { ms: 0, days: null };
  }
  return start.dateOnly ? { ms: null, days: 0 } : { ms: 0, days: null };
}

// --- Expansion -------------------------------------------------------------

export interface RecurrenceBudget {
  remaining: number;
}

export function createRecurrenceBudget(limit: number): RecurrenceBudget {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("the recurrence budget is not a count");
  return { remaining: limit };
}

export interface ExpandOptions extends Partial<IcalCaps> {
  /** Inclusive start of the query window, as epoch milliseconds. */
  from: number;
  /** Exclusive end of the query window, as epoch milliseconds. */
  to: number;
  /** Zone used to place floating and all-day values in the window. */
  timeZone?: string;
  /** Shared across resources in one request. */
  budget?: RecurrenceBudget;
}

export interface ExpandedOccurrence {
  component: ParsedComponent;
  /** The instance's identity: its nominal start, or the override's RECURRENCE-ID. */
  recurrenceId: IcalTime;
  start: IcalTime;
  end: IcalTime;
  override: boolean;
  allDay: boolean;
  floating: boolean;
  timeZoneUnresolved: boolean;
}

export type ExpansionTruncation = "recurrence_budget" | "occurrence_cap";

export interface ExpansionResult {
  occurrences: ExpandedOccurrence[];
  truncated: boolean;
  /** What stopped the expansion, or null when it is complete. */
  truncatedReason: ExpansionTruncation | null;
  unsupportedRange: boolean;
}

/**
 * The effective end of a component: DTEND/DUE, or DTSTART plus the parsed
 * duration. Null when the component has no DTSTART (a VTODO may omit it).
 */
export function componentEnd(component: ParsedComponent): IcalTime | null {
  if (component.start === null) return null;
  return endOf(component.start, component);
}

export function expandResource(parsed: ParsedResource, options: ExpandOptions): ExpansionResult {
  if (!Number.isFinite(options.from) || !Number.isFinite(options.to) || options.from >= options.to) {
    throw invalid("the expansion window is empty");
  }
  const caps = resolveCaps(options);
  const zone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const budget = options.budget ?? createRecurrenceBudget(caps.maxRecurrenceCandidatesPerRequest);
  const fromWall = wallClockInZone(zone, options.from);
  const toWall = wallClockInZone(zone, options.to);

  const overrides = new Map<string, ParsedComponent>();
  for (const override of parsed.overrides) {
    const recurrenceId = override.recurrenceId!;
    const key = timeKey(recurrenceId);
    if (overrides.has(key)) throw malformed("two overrides share one RECURRENCE-ID");
    overrides.set(key, override);
  }

  const exdateKeys = new Set(parsed.master.exdate.map((entry) => timeKey(entry)));
  const seen = new Set<string>();
  const occurrences: ExpandedOccurrence[] = [];
  let truncatedReason: ExpansionTruncation | null =
    budget.remaining <= 0 ? "recurrence_budget" : null;

  const add = (
    component: ParsedComponent,
    start: IcalTime,
    recurrenceId: IcalTime,
    override: boolean,
  ): void => {
    const end = endOf(start, component);
    if (!overlaps(start, end, options.from, options.to, zone, fromWall, toWall)) return;
    const key = timeKey(recurrenceId);
    if (seen.has(key)) return;
    seen.add(key);
    occurrences.push({
      component,
      recurrenceId,
      start,
      end,
      override,
      allDay: start.dateOnly,
      floating: !start.dateOnly && start.utc === null && !start.unresolved,
      timeZoneUnresolved: start.unresolved,
    });
  };

  const master = parsed.master;
  if (master.start !== null) {
    if (master.rrule !== null) {
      const generated = generateRule(master, master.rrule, caps, budget, options, zone);
      if (generated.truncated) truncatedReason ??= "recurrence_budget";
      for (const candidate of generated.starts) {
        const key = timeKey(candidate);
        if (exdateKeys.has(key)) continue;
        if (overrides.has(key)) continue;
        add(master, candidate, candidate, false);
      }
    } else {
      const key = timeKey(master.start);
      if (!exdateKeys.has(key) && !overrides.has(key)) {
        add(master, master.start, master.start, false);
      }
    }

    for (const rdate of master.rdate) {
      const key = timeKey(rdate);
      if (exdateKeys.has(key)) continue;
      if (overrides.has(key)) continue;
      add(master, rdate, rdate, false);
    }
  }

  for (const override of parsed.overrides) {
    const start = override.start!;
    add(override, start, override.recurrenceId!, true);
  }

  occurrences.sort((a, b) => sortKey(a.start) - sortKey(b.start));
  if (occurrences.length > caps.maxOccurrencesPerResource) {
    occurrences.length = caps.maxOccurrencesPerResource;
    truncatedReason ??= "occurrence_cap";
  }
  return {
    occurrences,
    truncated: truncatedReason !== null,
    truncatedReason,
    unsupportedRange: parsed.unsupportedRange,
  };
}

function resolveCaps(options: Partial<IcalCaps>): IcalCaps {
  return {
    maxRdateExdate: options.maxRdateExdate ?? DEFAULT_CAPS.maxRdateExdate,
    maxRecurrenceCandidatesPerRule:
      options.maxRecurrenceCandidatesPerRule ?? DEFAULT_CAPS.maxRecurrenceCandidatesPerRule,
    maxRecurrenceCandidatesPerRequest:
      options.maxRecurrenceCandidatesPerRequest ?? DEFAULT_CAPS.maxRecurrenceCandidatesPerRequest,
    maxOccurrencesPerResource: options.maxOccurrencesPerResource ?? DEFAULT_CAPS.maxOccurrencesPerResource,
  };
}

interface GeneratedStarts {
  starts: IcalTime[];
  truncated: boolean;
}

function generateRule(
  component: ParsedComponent,
  rule: RecurrenceRule,
  caps: IcalCaps,
  budget: RecurrenceBudget,
  options: ExpandOptions,
  zone: string,
): GeneratedStarts {
  const start = component.start!;
  const startDate = dateOf(start.wall);
  const durationMs = component.durationMs ?? 0;
  const durationDays = component.durationDays ?? 0;
  const lookbackDays = Math.min(366, Math.ceil(durationMs / DAY_MS) + durationDays + 2);
  const windowStart = addDays(dateOf(wallClockInZone(zone, options.from)), -lookbackDays);
  const windowEnd = addDays(dateOf(wallClockInZone(zone, options.to)), 1);
  if (compareDates(startDate, windowEnd) > 0 && rule.count === null) {
    return { starts: [], truncated: false };
  }

  let index = rule.count === null ? Math.max(0, roughIndex(rule, startDate, windowStart) - 1) : 0;
  let emitted = 0;
  let scannedByRule = 0;
  let truncated = budget.remaining <= 0;
  const starts: IcalTime[] = [];

  for (let iteration = 0; iteration < 1_000_000; iteration += 1) {
    const anchor = periodAnchor(rule, startDate, index);
    if (compareDates(anchor, windowEnd) > 0) break;
    const candidates = candidatesForPeriod(rule, anchor, startDate);
    scannedByRule += candidates.scanned;
    if (scannedByRule > caps.maxRecurrenceCandidatesPerRule) {
      throw tooComplex(
        `the recurrence rule needs more than ${caps.maxRecurrenceCandidatesPerRule} candidate steps`,
      );
    }
    if (budget.remaining <= 0) {
      truncated = true;
      break;
    }
    budget.remaining = Math.max(0, budget.remaining - candidates.scanned);

    let stop = false;
    for (const date of candidates.dates) {
      if (compareDates(date, startDate) < 0) continue;
      if (rule.count !== null && emitted >= rule.count) {
        stop = true;
        break;
      }
      const wall: WallClock =
        start.dateOnly
          ? { ...date, hour: 0, minute: 0, second: 0 }
          : { ...date, hour: start.wall.hour, minute: start.wall.minute, second: start.wall.second };
      const candidate = materializeWall(wall, start);
      if (rule.until !== null) {
        const past = rule.until.dateOnly
          ? compareDates(date, dateOf(rule.until.wall)) > 0
          : candidate.utc !== null && candidate.utc > rule.until.utc!;
        if (past) {
          stop = true;
          break;
        }
      }
      emitted += 1;
      starts.push(candidate);
      if (rule.count !== null && emitted >= rule.count) {
        stop = true;
        break;
      }
    }
    if (stop) break;
    index += 1;
  }

  return { starts, truncated };
}

function roughIndex(rule: RecurrenceRule, startDate: DateParts, windowStart: DateParts): number {
  if (rule.freq === "DAILY") {
    return Math.floor(daysBetween(startDate, windowStart) / rule.interval);
  }
  if (rule.freq === "WEEKLY") {
    const startWeek = startOfWeek(startDate, rule.weekStart);
    const targetWeek = startOfWeek(windowStart, rule.weekStart);
    return Math.floor(daysBetween(startWeek, targetWeek) / (7 * rule.interval));
  }
  if (rule.freq === "MONTHLY") {
    return Math.floor(
      ((windowStart.year - startDate.year) * 12 + windowStart.month - startDate.month) / rule.interval,
    );
  }
  return Math.floor((windowStart.year - startDate.year) / rule.interval);
}

function periodAnchor(rule: RecurrenceRule, startDate: DateParts, index: number): DateParts {
  if (rule.freq === "DAILY") return addDays(startDate, index * rule.interval);
  if (rule.freq === "WEEKLY") {
    return addDays(startOfWeek(startDate, rule.weekStart), index * rule.interval * 7);
  }
  if (rule.freq === "MONTHLY") {
    const total = startDate.year * 12 + (startDate.month - 1) + index * rule.interval;
    return { year: Math.floor(total / 12), month: (total % 12) + 1, day: 1 };
  }
  return { year: startDate.year + index * rule.interval, month: 1, day: 1 };
}

function startOfWeek(date: DateParts, weekStart: number): DateParts {
  return addDays(date, -((weekday(date) - weekStart + 7) % 7));
}

interface PeriodCandidates {
  dates: DateParts[];
  scanned: number;
}

function candidatesForPeriod(
  rule: RecurrenceRule,
  anchor: DateParts,
  startDate: DateParts,
): PeriodCandidates {
  if (rule.freq === "DAILY") {
    return { dates: matchesDaily(rule, anchor) ? [anchor] : [], scanned: 1 };
  }
  if (rule.freq === "WEEKLY") return weeklyCandidates(rule, anchor, startDate);
  if (rule.freq === "MONTHLY") return monthlyCandidates(rule, anchor.year, anchor.month, startDate);
  return yearlyCandidates(rule, anchor.year, startDate);
}

function matchesDaily(rule: RecurrenceRule, date: DateParts): boolean {
  if (rule.byMonth.length > 0 && !rule.byMonth.includes(date.month)) return false;
  if (rule.byMonthDay.length > 0) {
    const matching = rule.byMonthDay.some((day) => resolveMonthDay(date.year, date.month, day) === date.day);
    if (!matching) return false;
  }
  if (rule.byDay.length > 0) {
    const day = weekday(date);
    if (!rule.byDay.some((spec) => spec.weekday === day)) return false;
  }
  return true;
}

function weeklyCandidates(
  rule: RecurrenceRule,
  weekStart: DateParts,
  startDate: DateParts,
): PeriodCandidates {
  const days =
    rule.byDay.length > 0
      ? [...new Set(rule.byDay.map((spec) => spec.weekday))]
      : [weekday(startDate)];
  const dates: DateParts[] = [];
  for (const target of days) {
    // `weekStart` is the first day of the week under WKST; the target weekday
    // is not the loop offset unless the week happens to start on Sunday.
    const offset = (target - rule.weekStart + 7) % 7;
    const date = addDays(weekStart, offset);
    if (rule.byMonth.length > 0 && !rule.byMonth.includes(date.month)) continue;
    dates.push(date);
  }
  dates.sort(compareDates);
  return { dates, scanned: 7 };
}

function monthlyCandidates(
  rule: RecurrenceRule,
  year: number,
  month: number,
  startDate: DateParts,
): PeriodCandidates {
  if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) {
    return { dates: [], scanned: 1 };
  }
  const dim = daysInMonth(year, month);
  const scanned = rule.byDay.some((spec) => spec.ordinal === null)
    ? dim
    : Math.max(1, rule.byMonthDay.length + rule.byDay.length);

  const byMonthDay = rule.byMonthDay.length > 0 ? new Set<number>() : null;
  if (byMonthDay !== null) {
    for (const day of rule.byMonthDay) {
      const resolved = resolveMonthDay(year, month, day);
      if (resolved !== null) byMonthDay.add(resolved);
    }
  }
  const byDay = rule.byDay.length > 0 ? new Set<number>() : null;
  if (byDay !== null) {
    const days = rule.byDay;
    for (const spec of days) {
      if (spec.ordinal !== null) {
        const resolved = nthWeekdayOfMonth(year, month, spec.weekday, spec.ordinal);
        if (resolved !== null) byDay.add(resolved);
      } else {
        for (let day = 1; day <= dim; day += 1) {
          if (weekday({ year, month, day }) === spec.weekday) byDay.add(day);
        }
      }
    }
  }

  let days: Set<number>;
  if (byMonthDay !== null && byDay !== null) {
    days = new Set([...byMonthDay].filter((day) => byDay.has(day)));
  } else if (byMonthDay !== null) {
    days = byMonthDay;
  } else if (byDay !== null) {
    days = byDay;
  } else {
    days = startDate.day <= dim ? new Set([startDate.day]) : new Set();
  }

  return {
    dates: [...days].sort((a, b) => a - b).map((day) => ({ year, month, day })),
    scanned,
  };
}

function yearlyCandidates(
  rule: RecurrenceRule,
  year: number,
  startDate: DateParts,
): PeriodCandidates {
  const ordinalOnly =
    rule.byMonth.length === 0 &&
    rule.byMonthDay.length === 0 &&
    rule.byDay.length > 0 &&
    rule.byDay.every((spec) => spec.ordinal !== null);
  if (ordinalOnly) {
    const dates: DateParts[] = [];
    for (const spec of rule.byDay) {
      const resolved = nthWeekdayOfYear(year, spec.weekday, spec.ordinal!);
      if (resolved !== null) dates.push(resolved);
    }
    return { dates: dedupeDates(dates), scanned: 1 };
  }

  const plainByDay = rule.byDay.filter((spec) => spec.ordinal === null);
  if (rule.byMonth.length === 0 && rule.byMonthDay.length === 0 && plainByDay.length > 0) {
    const dates: DateParts[] = [];
    const total = daysBetween({ year, month: 1, day: 1 }, { year: year + 1, month: 1, day: 1 });
    const weekdays = new Set(plainByDay.map((spec) => spec.weekday));
    for (let offset = 0; offset < total; offset += 1) {
      const date = addDays({ year, month: 1, day: 1 }, offset);
      if (weekdays.has(weekday(date))) dates.push(date);
    }
    const ordinals = rule.byDay.filter((spec) => spec.ordinal !== null);
    for (const spec of ordinals) {
      const resolved = nthWeekdayOfYear(year, spec.weekday, spec.ordinal!);
      if (resolved !== null) dates.push(resolved);
    }
    return { dates: dedupeDates(dates), scanned: total };
  }

  const months =
    rule.byMonth.length > 0
      ? rule.byMonth
      : rule.byMonthDay.length > 0 || rule.byDay.length > 0
        ? Array.from({ length: 12 }, (_, month) => month + 1)
        : [startDate.month];
  const dates: DateParts[] = [];
  let scanned = 0;
  for (const month of months) {
    const monthly = monthlyCandidates(rule, year, month, startDate);
    dates.push(...monthly.dates);
    scanned += monthly.scanned;
  }
  return { dates: dedupeDates(dates), scanned: Math.max(1, scanned) };
}

function dedupeDates(dates: DateParts[]): DateParts[] {
  const seen = new Set<string>();
  const unique: DateParts[] = [];
  for (const date of dates) {
    const key = `${date.year}-${date.month}-${date.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(date);
  }
  return unique.sort(compareDates);
}

function resolveMonthDay(year: number, month: number, day: number): number | null {
  const dim = daysInMonth(year, month);
  if (day > 0) return day <= dim ? day : null;
  const resolved = dim + day + 1;
  return resolved >= 1 ? resolved : null;
}

function nthWeekdayOfMonth(
  year: number,
  month: number,
  targetWeekday: number,
  ordinal: number,
): number | null {
  const dim = daysInMonth(year, month);
  if (ordinal > 0) {
    const firstWeekday = weekday({ year, month, day: 1 });
    const day = 1 + ((targetWeekday - firstWeekday + 7) % 7) + (ordinal - 1) * 7;
    return day <= dim ? day : null;
  }
  const lastWeekday = weekday({ year, month, day: dim });
  const day = dim - ((lastWeekday - targetWeekday + 7) % 7) + (ordinal + 1) * 7;
  return day >= 1 ? day : null;
}

function nthWeekdayOfYear(year: number, targetWeekday: number, ordinal: number): DateParts | null {
  const total = daysBetween({ year, month: 1, day: 1 }, { year: year + 1, month: 1, day: 1 });
  const janFirst = weekday({ year, month: 1, day: 1 });
  if (ordinal > 0) {
    const offset = (targetWeekday - janFirst + 7) % 7 + (ordinal - 1) * 7;
    return offset < total ? addDays({ year, month: 1, day: 1 }, offset) : null;
  }
  const decLast = weekday(addDays({ year, month: 12, day: 31 }, 0));
  const offset = total - 1 - ((decLast - targetWeekday + 7) % 7) + (ordinal + 1) * 7;
  return offset >= 0 ? addDays({ year, month: 1, day: 1 }, offset) : null;
}

function materializeWall(wall: WallClock, template: IcalTime): IcalTime {
  if (template.dateOnly) {
    return {
      dateOnly: true,
      wall: { ...wall, hour: 0, minute: 0, second: 0 },
      timeZone: null,
      utc: null,
      unresolved: false,
      raw: isoDate(dateOf(wall)),
    };
  }
  if (template.timeZone !== null) {
    if (template.unresolved) {
      return { dateOnly: false, wall, timeZone: template.timeZone, utc: null, unresolved: true, raw: isoWall(wall) };
    }
    return {
      dateOnly: false,
      wall,
      timeZone: template.timeZone,
      utc: wallClockToUtc(template.timeZone, wall),
      unresolved: false,
      raw: isoWall(wall),
    };
  }
  if (template.utc !== null) {
    return {
      dateOnly: false,
      wall,
      timeZone: null,
      utc: wallAsUtcMs(wall),
      unresolved: false,
      raw: `${isoWall(wall)}Z`,
    };
  }
  return { dateOnly: false, wall, timeZone: null, utc: null, unresolved: false, raw: isoWall(wall) };
}

function endOf(start: IcalTime, component: ParsedComponent): IcalTime {
  if (start.dateOnly) {
    const days = component.durationDays ?? (component.kind === "VEVENT" ? 1 : 0);
    const endDate = addDays(dateOf(start.wall), days);
    return {
      dateOnly: true,
      wall: { ...endDate, hour: 0, minute: 0, second: 0 },
      timeZone: null,
      utc: null,
      unresolved: false,
      raw: isoDate(endDate),
    };
  }
  const ms = component.durationMs ?? 0;
  if (start.utc !== null) {
    const utc = start.utc + ms;
    if (start.timeZone !== null) {
      return {
        dateOnly: false,
        wall: wallClockInZone(start.timeZone, utc),
        timeZone: start.timeZone,
        utc,
        unresolved: false,
        raw: isoWall(wallClockInZone(start.timeZone, utc)),
      };
    }
    const wall = wallFromUtcMs(utc);
    return { dateOnly: false, wall, timeZone: null, utc, unresolved: false, raw: `${isoWall(wall)}Z` };
  }
  const wall = wallFromUtcMs(wallAsUtcMs(start.wall) + ms);
  return {
    dateOnly: false,
    wall,
    timeZone: start.timeZone,
    utc: null,
    unresolved: start.unresolved,
    raw: isoWall(wall),
  };
}

function overlaps(
  start: IcalTime,
  end: IcalTime,
  from: number,
  to: number,
  zone: string,
  fromWall: WallClock,
  toWall: WallClock,
): boolean {
  if (start.dateOnly) {
    const startMs = wallClockToUtc(zone, start.wall);
    const endMs = wallClockToUtc(zone, end.wall);
    if (endMs === startMs) return startMs >= from && startMs < to;
    return startMs < to && endMs > from;
  }
  if (start.utc !== null && end.utc !== null) {
    if (end.utc === start.utc) return start.utc >= from && start.utc < to;
    return start.utc < to && end.utc > from;
  }
  const startMs = wallAsUtcMs(start.wall);
  const endMs = wallAsUtcMs(end.wall);
  const fromMs = wallAsUtcMs(fromWall);
  const toMs = wallAsUtcMs(toWall);
  if (endMs === startMs) return startMs >= fromMs && startMs < toMs;
  return startMs < toMs && endMs > fromMs;
}

function sortKey(time: IcalTime): number {
  if (time.dateOnly) return wallAsUtcMs({ ...time.wall, hour: 0, minute: 0, second: 0 });
  return time.utc ?? wallAsUtcMs(time.wall);
}

// --- Mutation --------------------------------------------------------------

export interface ComponentEditor {
  readonly name: string;
  text(name: string): string | null;
  integer(name: string): number | null;
  has(name: string): boolean;
  setText(name: string, value: string): void;
  setInteger(name: string, value: number): void;
  setDate(name: string, value: string): void;
  setDateTimeUtc(name: string, value: string): void;
  setDuration(name: string, value: string): void;
  remove(name: string): void;
}

export interface MutateOptions {
  /** Refuse a resource carrying RRULE/RDATE/RECURRENCE-ID (default). */
  allowRecurring?: boolean;
  /** Refuse a resource carrying ORGANIZER/ATTENDEE (default). */
  allowScheduling?: boolean;
}

export function mutateResource(
  ics: string,
  uid: string,
  mutate: (editor: ComponentEditor) => void,
  options: MutateOptions = {},
): string {
  const parsed = parseResource(ics);
  if (parsed.uid !== uid) throw invalid("the resource UID does not match");
  if (parsed.recurring && options.allowRecurring !== true) {
    throw invalid("recurring resources are read-only");
  }
  if (parsed.scheduling && options.allowScheduling !== true) {
    throw invalid("scheduled resources are read-only");
  }

  const master = parsed.master;
  const originalUid = cloneProperty(propertyOf(master.jcal, "uid"));
  const originalDtstamp = cloneProperty(propertyOf(master.jcal, "dtstamp"));
  const editor = new Editor(master.jcal);
  mutate(editor);

  if (originalUid === null) throw malformed("the master has no UID property");
  setProperty(master.jcal, originalUid);
  if (originalDtstamp !== null) setProperty(master.jcal, originalDtstamp);

  let output: string;
  try {
    output = ICAL.stringify(parsed.jcal);
  } catch (error) {
    throw malformed(`the updated iCalendar data could not be serialized: ${messageOf(error)}`);
  }
  const reparsed = parseResource(output);
  if (reparsed.uid !== uid) throw malformed("the mutation did not preserve the UID");
  if (reparsed.components.length !== parsed.components.length) {
    throw malformed("the mutation changed the number of components");
  }
  return output;
}

class Editor implements ComponentEditor {
  readonly name: string;
  private readonly component: JCalComponent;

  constructor(component: JCalComponent) {
    this.component = component;
    this.name = component[0].toUpperCase();
  }

  text(name: string): string | null {
    return textOfComponent(this.component, normalizePropertyName(name));
  }

  integer(name: string): number | null {
    return integerOfComponent(this.component, normalizePropertyName(name));
  }

  has(name: string): boolean {
    return propertyOf(this.component, normalizePropertyName(name)) !== null;
  }

  setText(name: string, value: string): void {
    setProperty(this.component, [normalizePropertyName(name), {}, "text", value]);
  }

  setInteger(name: string, value: number): void {
    if (!Number.isSafeInteger(value)) throw invalid("an integer property was given a non-integer");
    setProperty(this.component, [normalizePropertyName(name), {}, "integer", value]);
  }

  setDate(name: string, value: string): void {
    if (!DATE_RE.test(value)) throw invalid("a DATE property was given a malformed date");
    assertWall(parseDateValue(value, name), name);
    setProperty(this.component, [normalizePropertyName(name), {}, "date", value]);
  }

  setDateTimeUtc(name: string, value: string): void {
    const match = DATE_TIME_RE.exec(value);
    if (!match || match[7] !== "Z") throw invalid("a DATE-TIME property needs a UTC value");
    assertWall(
      {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
        hour: Number(match[4]),
        minute: Number(match[5]),
        second: Number(match[6]),
      },
      name,
    );
    setProperty(this.component, [normalizePropertyName(name), {}, "date-time", value]);
  }

  setDuration(name: string, value: string): void {
    if (!DURATION_RE.test(value)) throw invalid("a DURATION property was given a malformed value");
    setProperty(this.component, [normalizePropertyName(name), {}, "duration", value]);
  }

  remove(name: string): void {
    const normalized = normalizePropertyName(name);
    this.component[1] = this.component[1].filter((property) => property[0] !== normalized);
  }
}

function normalizePropertyName(name: string): string {
  const normalized = name.trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(normalized)) throw invalid("a property name is malformed");
  return normalized;
}

function setProperty(component: JCalComponent, property: JCalProperty): void {
  const index = component[1].findIndex((entry) => entry[0] === property[0]);
  if (index >= 0) component[1][index] = property;
  else component[1].push(property);
}

function cloneProperty(property: JCalProperty | null): JCalProperty | null {
  return property === null ? null : (JSON.parse(JSON.stringify(property)) as JCalProperty);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
