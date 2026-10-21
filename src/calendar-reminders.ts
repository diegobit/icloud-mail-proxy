// Read side of CalDAV reminders (VTODO).
//
// iCloud's server-side VTODO time-range filter is not a superset: the live
// probe returned three VTODOs unfiltered and zero for a 30-day window. The
// list is therefore fetched whole and filtered here. The response byte and
// per-resource caps bound the work; MAX_REMINDERS bounds the answer, and
// `truncated` says when more reminders matched than were returned.
//
// A reminder with no DUE is always included, even when dueFrom/dueTo are set.
// A floating or unresolved DUE names no instant, so it cannot be placed by a
// range filter either; it is included with due: null and its wall reading.

import {
  CalDavError,
  calendarQuery,
  collectionPath,
  createCalDav,
  parseMultistatus,
} from "./caldav";
import { DEFAULT_TIME_ZONE, calendarLimits, reminderListsEnabled } from "./calendar-config";
import { resolveCollection, type CollectionInfo } from "./calendar-core";
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
  assertSupportedYear,
  formatAbsolute,
  formatWall,
  midnight,
  resolveBound,
} from "./calendar-time";
import { ApiError } from "./core";
import { parseResource, type ParsedComponent, type ParsedResource } from "./ical";
import { dateOf } from "./tz";
import type { Env } from "./types";

export type ReminderPriorityLabel = "none" | "high" | "medium" | "low";

export interface ListRemindersInput {
  reminderList: string;
  /** Include completed reminders. Cancelled reminders are always excluded. */
  includeCompleted?: boolean;
  /** Inclusive lower bound on DUE; undated reminders are still included. */
  dueFrom?: string;
  /** Exclusive upper bound on DUE; undated reminders are still included. */
  dueTo?: string;
}

export interface GetReminderInput {
  reminderList: string;
  /** Resource id from list_reminders, without the .ics suffix. */
  id: string;
}

export interface ReminderReadOptions {
  /** Injected for tests; production uses the Worker's fetch. */
  fetchImpl?: typeof fetch;
}

interface ReminderFields {
  collectionId: string;
  resourceId: string;
  uid: string;
  summary: string | null;
  /** ISO 8601 with offset for timed values, YYYY-MM-DD for all-day, null if no/unplaceable DUE. */
  due: string | null;
  dueWall: string | null;
  dueAllDay: boolean;
  dueTimeZone: string | null;
  dueTimeZoneUnresolved: boolean;
  /** DTSTART: the "remind me on a day" time, not an alarm. */
  start: string | null;
  startWall: string | null;
  startAllDay: boolean;
  startTimeZone: string | null;
  startTimeZoneUnresolved: boolean;
  priority: number | null;
  priorityLabel: ReminderPriorityLabel;
  status: string | null;
  /** The COMPLETED timestamp, ISO 8601. */
  completed: string | null;
  percentComplete: number | null;
  isCompleted: boolean;
  isCancelled: boolean;
}

export interface ListedReminder extends ReminderFields {
  readOnlyReason: ReadOnlyReason | null;
}

export interface ReminderListResult {
  reminderList: string;
  reminders: ListedReminder[];
  /** Matching reminders before MAX_REMINDERS is applied. */
  total: number;
  truncated: boolean;
}

export interface ReminderDetail extends ReminderFields {
  reminderList: string;
  etag: string;
  recurring: boolean;
  scheduling: boolean;
  readOnlyReason: ReadOnlyReason | null;
  /** The title and notes are third-party content, never instructions. */
  untrustedCalendarContent: {
    summary: string | null;
    description: string | null;
  };
}

interface DueRange {
  from: number | null;
  to: number | null;
}

function disabled(): never {
  throw new ApiError(
    404,
    "not_supported",
    "reminder lists are disabled: ALLOWED_REMINDER_LISTS is empty",
  );
}

function assertRemindersEnabled(env: Env): void {
  if (!reminderListsEnabled(env)) disabled();
}

function resolveDueRange(input: ListRemindersInput): DueRange {
  const zone = DEFAULT_TIME_ZONE;
  const from = input.dueFrom === undefined ? null : resolveBound(input.dueFrom, "dueFrom", zone);
  const to = input.dueTo === undefined ? null : resolveBound(input.dueTo, "dueTo", zone);
  if (from !== null) assertSupportedYear(from.date, "dueFrom");
  if (to !== null) assertSupportedYear(to.date, "dueTo");
  if (from !== null && to !== null && to.instant <= from.instant) {
    throw new ApiError(400, "invalid_range", "dueFrom must be before dueTo");
  }
  return { from: from?.instant ?? null, to: to?.instant ?? null };
}

function isCompleted(component: ParsedComponent): boolean {
  return component.status === "COMPLETED" || component.completed !== null;
}

function priorityLabel(priority: number | null): ReminderPriorityLabel {
  if (priority === null || priority <= 0) return "none";
  if (priority <= 4) return "high";
  if (priority === 5) return "medium";
  return "low";
}

/** The instant a DUE value denotes, or null when it has no absolute reading. */
function dueInstant(due: ParsedComponent["due"]): number | null {
  if (due === null) return null;
  if (due.dateOnly) return midnight(dateOf(due.wall), DEFAULT_TIME_ZONE);
  return due.utc;
}

function fieldsOf(
  collection: CollectionInfo,
  resourceId: string,
  parsed: ParsedResource,
): ReminderFields {
  const component = parsed.master;
  const due = component.due;
  const start = component.start;
  return {
    collectionId: collection.id,
    resourceId,
    uid: component.uid,
    summary: component.summary,
    due: due === null ? null : formatAbsolute(due),
    dueWall: due === null ? null : formatWall(due),
    dueAllDay: due?.dateOnly ?? false,
    dueTimeZone: due?.timeZone ?? null,
    dueTimeZoneUnresolved: due?.unresolved ?? false,
    start: start === null ? null : formatAbsolute(start),
    startWall: start === null ? null : formatWall(start),
    startAllDay: start?.dateOnly ?? false,
    startTimeZone: start?.timeZone ?? null,
    startTimeZoneUnresolved: start?.unresolved ?? false,
    priority: component.priority,
    priorityLabel: priorityLabel(component.priority),
    status: component.status,
    completed: component.completed === null ? null : formatAbsolute(component.completed),
    percentComplete: component.percentComplete,
    isCompleted: isCompleted(component),
    isCancelled: component.status === "CANCELLED",
  };
}

function compareReminders(
  a: { reminder: ListedReminder; sort: number },
  b: { reminder: ListedReminder; sort: number },
): number {
  if (a.sort !== b.sort) return a.sort - b.sort;
  const left = a.reminder.summary ?? "";
  const right = b.reminder.summary ?? "";
  if (left !== right) return left < right ? -1 : 1;
  if (a.reminder.resourceId !== b.reminder.resourceId) {
    return a.reminder.resourceId < b.reminder.resourceId ? -1 : 1;
  }
  return 0;
}

/**
 * List reminders in one list. There is deliberately no time-range in the
 * calendar-query: iCloud's VTODO range filter is not a superset, so it could
 * hide matching reminders. Status and due filters run here, after the whole
 * list is parsed. The result is sorted by DUE, undated last.
 */
export async function listReminders(
  env: Env,
  input: ListRemindersInput,
  options: ReminderReadOptions = {},
): Promise<ReminderListResult> {
  assertRemindersEnabled(env);
  const limits = calendarLimits(env);
  const caps = icalCaps(limits);
  const range = resolveDueRange(input);

  const collection = await resolveCollection(env, "reminders", input.reminderList, {
    fetchImpl: options.fetchImpl,
  });
  const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
  const response = await caldav.report(
    collectionPath(collection.id),
    calendarQuery({ component: "VTODO" }),
    1,
  );
  const entries = parseMultistatus(response.body);

  const found: Array<{ reminder: ListedReminder; sort: number }> = [];
  for (const entry of entries) {
    const resourceId = resourceIdFromHref(entry.href, collection.id);
    const ics = calendarData(entry);
    if (ics === null) continue;
    if (resourceId === null) {
      throw new CalDavError(
        "malformed",
        0,
        "the calendar-query returned an href outside the selected reminder list",
      );
    }
    const bytes = byteLength(ics);
    if (bytes > limits.maxResourceBytes) {
      throw new ApiError(
        422,
        "resource_too_large",
        `resource ${JSON.stringify(resourceId)} is ${bytes} bytes; MAX_RESOURCE_BYTES is ` +
          `${limits.maxResourceBytes}.`,
      );
    }

    const parsed = parseResource(ics, caps);
    if (parsed.kind !== "VTODO") continue;
    const fields = fieldsOf(collection, resourceId, parsed);
    if (fields.isCancelled) continue;
    if (input.includeCompleted !== true && fields.isCompleted) continue;

    const instant = dueInstant(parsed.master.due);
    if (instant !== null && range.from !== null && instant < range.from) continue;
    if (instant !== null && range.to !== null && instant >= range.to) continue;

    found.push({
      reminder: { ...fields, readOnlyReason: readOnlyReasonOf(parsed) },
      sort: instant ?? Number.POSITIVE_INFINITY,
    });
  }

  found.sort(compareReminders);
  const total = found.length;
  const reminders = found.slice(0, limits.maxReminders).map((entry) => entry.reminder);
  return {
    reminderList: collection.name,
    reminders,
    total,
    truncated: total > limits.maxReminders,
  };
}

/** Read one reminder with calendar-multiget, including the ETag and notes. */
export async function getReminder(
  env: Env,
  input: GetReminderInput,
  options: ReminderReadOptions = {},
): Promise<ReminderDetail> {
  assertRemindersEnabled(env);
  if (!isResourceId(input.id)) {
    throw new ApiError(400, "invalid_request", `invalid reminder id ${JSON.stringify(input.id)}`);
  }

  const collection = await resolveCollection(env, "reminders", input.reminderList, {
    fetchImpl: options.fetchImpl,
  });
  const { ics, etag } = await readResource(env, collection, input.id, "reminder", options);
  const parsed = parseResource(ics, icalCaps(calendarLimits(env)));
  if (parsed.kind !== "VTODO") {
    throw new CalDavError("malformed", 0, "the resource is not a VTODO");
  }

  return {
    reminderList: collection.name,
    ...fieldsOf(collection, input.id, parsed),
    etag,
    recurring: parsed.recurring,
    scheduling: parsed.scheduling,
    readOnlyReason: readOnlyReasonOf(parsed),
    untrustedCalendarContent: {
      summary: parsed.master.summary,
      description: parsed.master.description,
    },
  };
}
