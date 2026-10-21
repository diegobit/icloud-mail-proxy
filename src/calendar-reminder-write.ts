// Write side of CalDAV reminders (VTODO): create, partial update and complete.
//
// The contract mirrors the event write core:
// - structured fields only; a create accepts title, notes, due and priority;
// - a timed due is a wall clock read in `timeZone` (default Europe/Rome) and
//   stored as UTC; a date-only due is stored as DATE;
// - an update requires the strong ETag from get_reminder, re-reads the
//   resource, refuses recurring/scheduling resources, then uses If-Match;
// - completion is a read-modify-write with STATUS:COMPLETED,
//   COMPLETED:<now UTC> and PERCENT-COMPLETE:100;
// - reopening sets STATUS:NEEDS-ACTION and removes COMPLETED and
//   PERCENT-COMPLETE, so a reopened reminder never reads as 100% done;
// - every attempted write is audited without the title or notes.

import { CalDavError, createCalDav, resourcePath } from "./caldav";
import {
  DEFAULT_TIME_ZONE,
  calendarLimits,
  reminderListsEnabled,
  reminderWritesEnabled,
  type CalendarLimits,
} from "./calendar-config";
import { resolveCollection, type CollectionInfo } from "./calendar-core";
import {
  assertStrongEtag,
  byteLength,
  icalCaps,
  isResourceId,
  readOnlyReasonOf,
  readResource,
} from "./calendar-resource";
import { reminderFieldsOf, type ReminderDetail } from "./calendar-reminders";
import {
  assertZone,
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
  mutateResource,
  parseResource,
  type ComponentEditor,
  type IcalTime,
  type ParsedResource,
} from "./ical";
import { dateOf, isoDate, isoInZone, wallClockToUtc, type DateParts } from "./tz";
import type { Env } from "./types";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const WALL_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

export type ReminderWriteOptions = WriteOptions;

export interface CreateReminderInput {
  reminderList: string;
  /** Optional caller-supplied resource id; the same id makes a retry idempotent. */
  id?: string;
  summary: string;
  notes?: string | null;
  /** Wall clock YYYY-MM-DDTHH:MM:SS, or YYYY-MM-DD for an all-day due date. */
  due?: string | null;
  /** IANA zone for a timed due; defaults to Europe/Rome. */
  timeZone?: string;
  /** 0 (none) to 9 (lowest); null also means none. */
  priority?: number | null;
}

export interface UpdateReminderInput {
  reminderList: string;
  id: string;
  /** The strong ETag returned by get_reminder. */
  etag: string;
  summary?: string;
  notes?: string | null;
  due?: string | null;
  timeZone?: string;
  priority?: number | null;
  /** true completes the reminder; false reopens it and clears completion fields. */
  completed?: boolean;
}

export interface CompleteReminderInput {
  reminderList: string;
  id: string;
  /** The strong ETag returned by get_reminder. */
  etag: string;
}

export interface ReminderWriteResult extends Omit<ReminderDetail, "etag"> {
  /** The PUT response ETag, or null when iCloud omitted it. */
  etag: string | null;
}

interface ResolvedReminderDue {
  allDay: boolean;
  date: DateParts | null;
  instant: number | null;
  iso: string;
}

/**
 * Resolve a due value to DATE or an instant. Like the event core, the caller
 * cannot inject an offset or a TZID: a wall clock is read in `timeZone`, and a
 * date-only value must not carry a zone.
 */
function resolveReminderDue(due: string, timeZone: string | undefined): ResolvedReminderDue {
  if (DATE_ONLY.test(due)) {
    if (timeZone !== undefined) {
      throw new ApiError(
        400,
        "invalid_request",
        "timeZone does not apply to an all-day due date",
      );
    }
    const date = parseDateOnly(due, "due");
    return { allDay: true, date, instant: null, iso: isoDate(date) };
  }
  if (!WALL_DATE_TIME.test(due)) {
    throw new ApiError(
      400,
      "invalid_request",
      "due must be YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS (a wall clock, without a zone)",
    );
  }
  const zone = assertZone(timeZone ?? DEFAULT_TIME_ZONE);
  const wall = parseWallDateTime(due, "due");
  const instant = wallClockToUtc(zone, wall);
  return { allDay: false, date: null, instant, iso: isoInZone(instant, zone) };
}

/** 0 and null both mean "no PRIORITY property"; 1-9 are written verbatim. */
function normalizePriority(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;
  if (!Number.isSafeInteger(value) || value < 0 || value > 9) {
    throw new ApiError(
      400,
      "invalid_request",
      "priority must be an integer from 0 (none) to 9 (lowest)",
    );
  }
  return value === 0 ? null : value;
}

function assertReminderId(id: string): void {
  if (!isResourceId(id)) {
    throw new ApiError(
      400,
      "invalid_request",
      `invalid reminder id ${JSON.stringify(id)}; use 1-128 letters, digits, dot, underscore or hyphen`,
    );
  }
}

function assertReminderWriteEnabled(env: Env): void {
  if (reminderWritesEnabled(env)) return;
  throw new ApiError(
    404,
    "not_supported",
    reminderListsEnabled(env)
      ? "reminder writes are disabled: set REMINDERS_WRITE to 1"
      : "reminder lists are disabled: ALLOWED_REMINDER_LISTS is empty",
  );
}

/** iCalendar timestamps have second precision; keep validation on that grid. */
function writeInstant(now: number): number {
  return Math.floor(now / 1000) * 1000;
}

function buildReminderIcs(input: {
  uid: string;
  summary: string;
  notes: string | null;
  due: ResolvedReminderDue | null;
  priority: number | null;
  now: number;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//icloud-mail-proxy//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VTODO",
    `UID:${escapeIcalText(input.uid)}`,
    `DTSTAMP:${icsUtc(input.now)}`,
    `SUMMARY:${escapeIcalText(input.summary)}`,
  ];
  if (input.notes !== null) lines.push(`DESCRIPTION:${escapeIcalText(input.notes)}`);
  if (input.due !== null) {
    if (input.due.allDay) lines.push(`DUE;VALUE=DATE:${icsDate(input.due.date!)}`);
    else lines.push(`DUE:${icsUtc(input.due.instant!)}`);
  }
  if (input.priority !== null) lines.push(`PRIORITY:${input.priority}`);
  lines.push("STATUS:NEEDS-ACTION", "END:VTODO", "END:VCALENDAR");
  return serializeIcal(lines);
}

/** Re-parse a freshly built reminder and assert the fields that matter. */
function validateCreatedReminder(
  ics: string,
  limits: CalendarLimits,
  expected: {
    uid: string;
    summary: string;
    notes: string | null;
    due: ResolvedReminderDue | null;
    priority: number | null;
  },
): ParsedResource {
  const parsed = parseResource(ics, icalCaps(limits));
  if (parsed.kind !== "VTODO" || parsed.components.length !== 1) {
    throw new ApiError(500, "internal_error", "the serialized reminder is not exactly one VTODO");
  }
  if (parsed.uid !== expected.uid) {
    throw new ApiError(500, "internal_error", "the serialized reminder changed the UID");
  }
  if (
    parsed.recurring ||
    parsed.scheduling ||
    parsed.master.jcal[1].some(([name]) => FORBIDDEN_WRITE_PROPERTIES.has(name))
  ) {
    throw new ApiError(
      400,
      "unsupported_field",
      "the reminder would carry a recurrence or scheduling property, which v1 never writes",
    );
  }
  if (parsed.master.alarms > 0) {
    throw new ApiError(
      400,
      "unsupported_field",
      "the reminder would carry a VALARM, which is not supported",
    );
  }
  if (parsed.master.summary !== expected.summary) {
    throw new ApiError(500, "internal_error", "the serialized summary did not round-trip");
  }
  if (expected.notes === null) {
    if (parsed.master.description !== null) {
      throw new ApiError(500, "internal_error", "the serialized notes did not round-trip");
    }
  } else if (parsed.master.description !== expected.notes) {
    throw new ApiError(500, "internal_error", "the serialized notes did not round-trip");
  }
  if (expected.due === null) {
    if (parsed.master.due !== null) {
      throw new ApiError(500, "internal_error", "the serialized due did not round-trip");
    }
  } else if (expected.due.allDay) {
    const due = parsed.master.due;
    if (due === null || !due.dateOnly || isoDate(dateOf(due.wall)) !== expected.due.iso) {
      throw new ApiError(500, "internal_error", "the serialized all-day due did not round-trip");
    }
  } else {
    const due = parsed.master.due;
    if (due === null || due.utc !== expected.due.instant) {
      throw new ApiError(500, "internal_error", "the serialized timed due did not round-trip");
    }
  }
  if (expected.priority === null) {
    if (parsed.master.priority !== null) {
      throw new ApiError(500, "internal_error", "the serialized priority did not round-trip");
    }
  } else if (parsed.master.priority !== expected.priority) {
    throw new ApiError(500, "internal_error", "the serialized priority did not round-trip");
  }
  if (parsed.master.status !== "NEEDS-ACTION") {
    throw new ApiError(500, "internal_error", "the created reminder is not NEEDS-ACTION");
  }
  if (parsed.master.completed !== null || parsed.master.percentComplete !== null) {
    throw new ApiError(500, "internal_error", "the created reminder carries completion fields");
  }
  return parsed;
}

/**
 * A VTODO's DTSTART and DUE must share a value type, and mixing a floating
 * DTSTART with an absolute DUE is malformed. v1 never edits DTSTART, so a due
 * change that would contradict it is refused before the PUT rather than
 * producing a resource the next read cannot parse.
 */
function assertDueCompatible(start: IcalTime | null, due: ResolvedReminderDue): void {
  if (start === null) return;
  if (start.dateOnly !== due.allDay) {
    throw new ApiError(
      400,
      "invalid_request",
      "the reminder's DTSTART and the new due use different value types; " +
        "v1 does not change DTSTART, so the due type cannot change",
    );
  }
  if (!due.allDay && start.utc === null) {
    throw new ApiError(
      400,
      "invalid_request",
      "the reminder's DTSTART is floating or has an unresolved zone; " +
        "v1 cannot add an absolute due to it",
    );
  }
}

function applyCompletion(editor: ComponentEditor, completed: boolean, now: number): void {
  if (completed) {
    editor.setText("status", "COMPLETED");
    editor.setDateTimeUtc("completed", isoInZone(now, "UTC"));
    editor.setInteger("percent-complete", 100);
  } else {
    editor.setText("status", "NEEDS-ACTION");
    editor.remove("completed");
    editor.remove("percent-complete");
  }
}

/**
 * Validate a reminder read-modify-write. Existing VALARMs and Apple properties
 * are preserved and not checked; only the fields this call changed are.
 */
function validateUpdatedReminder(
  ics: string,
  limits: CalendarLimits,
  expected: {
    uid: string;
    summary: string | undefined;
    notes: string | null | undefined;
    due: ResolvedReminderDue | null | undefined;
    priority: number | null | undefined;
    completed: boolean | undefined;
    now: number;
  },
): ParsedResource {
  const parsed = parseResource(ics, icalCaps(limits));
  if (parsed.kind !== "VTODO" || parsed.components.length !== 1) {
    throw new ApiError(500, "internal_error", "the updated resource is not exactly one VTODO");
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
  if (expected.notes !== undefined) {
    const actual = parsed.master.description;
    if (expected.notes === null ? actual !== null : actual !== expected.notes) {
      throw new ApiError(500, "internal_error", "the updated notes did not round-trip");
    }
  }
  if (expected.due !== undefined) {
    if (expected.due === null) {
      const hasDuration = parsed.master.jcal[1].some(([name]) => name === "duration");
      if (parsed.master.due !== null || hasDuration) {
        throw new ApiError(500, "internal_error", "the cleared due did not round-trip");
      }
    } else if (expected.due.allDay) {
      const due = parsed.master.due;
      if (due === null || !due.dateOnly || isoDate(dateOf(due.wall)) !== expected.due.iso) {
        throw new ApiError(500, "internal_error", "the updated all-day due did not round-trip");
      }
    } else {
      const due = parsed.master.due;
      if (due === null || due.utc !== expected.due.instant) {
        throw new ApiError(500, "internal_error", "the updated timed due did not round-trip");
      }
    }
  }
  if (expected.priority !== undefined) {
    if (
      expected.priority === null
        ? parsed.master.priority !== null
        : parsed.master.priority !== expected.priority
    ) {
      throw new ApiError(500, "internal_error", "the updated priority did not round-trip");
    }
  }
  if (expected.completed !== undefined) {
    if (expected.completed) {
      if (
        parsed.master.status !== "COMPLETED" ||
        parsed.master.completed === null ||
        parsed.master.completed.utc !== expected.now ||
        parsed.master.percentComplete !== 100
      ) {
        throw new ApiError(500, "internal_error", "the completion fields did not round-trip");
      }
    } else if (
      parsed.master.status !== "NEEDS-ACTION" ||
      parsed.master.completed !== null ||
      parsed.master.percentComplete !== null
    ) {
      throw new ApiError(500, "internal_error", "the reopened fields did not round-trip");
    }
  }
  return parsed;
}

function reminderResult(
  collection: CollectionInfo,
  id: string,
  parsed: ParsedResource,
  etag: string | null,
): ReminderWriteResult {
  return {
    reminderList: collection.name,
    ...reminderFieldsOf(collection, id, parsed),
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

interface LoadedReminder {
  ics: string;
  parsed: ParsedResource;
}

async function readWritableReminder(
  env: Env,
  collection: CollectionInfo,
  id: string,
  etag: string,
  limits: CalendarLimits,
  options: ReminderWriteOptions,
): Promise<LoadedReminder> {
  const current = await readResource(env, collection, id, "reminder", {
    fetchImpl: options.fetchImpl,
  });
  if (current.etag !== etag) {
    throw new ApiError(
      409,
      "conflict",
      "the reminder changed since you read it; call get_reminder again",
    );
  }
  const parsed = parseResource(current.ics, icalCaps(limits));
  if (parsed.kind !== "VTODO") {
    throw new CalDavError("malformed", 0, `resource ${JSON.stringify(id)} is not a VTODO`);
  }
  if (parsed.recurring) {
    throw new ApiError(
      422,
      "recurring_not_supported",
      "this reminder is recurring; v1 only writes one-off reminders, so it was not changed",
    );
  }
  if (parsed.scheduling) {
    throw new ApiError(
      422,
      "scheduling_not_supported",
      "this reminder has an organizer or attendee; v1 does not change scheduling resources",
    );
  }
  return { ics: current.ics, parsed };
}

async function putReminder(
  env: Env,
  collection: CollectionInfo,
  id: string,
  ics: string,
  etag: string | null,
  options: ReminderWriteOptions,
): Promise<{ etag: string | null }> {
  const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
  const { homeUrl } = await caldav.discover();
  const href = new URL(resourcePath(collection.id, id), homeUrl).pathname;
  return caldav.put(href, ics, etag);
}

export async function createReminder(
  env: Env,
  input: CreateReminderInput,
  options: ReminderWriteOptions = {},
): Promise<ReminderWriteResult> {
  assertReminderWriteEnabled(env);
  const limits = calendarLimits(env);
  const summary = normalizeSummary(input.summary);
  const notes = normalizeText(input.notes, "notes") ?? null;
  const priority = normalizePriority(input.priority) ?? null;
  const due =
    input.due === undefined || input.due === null
      ? null
      : resolveReminderDue(input.due, input.timeZone);
  if (due === null && input.timeZone !== undefined) {
    throw new ApiError(400, "invalid_request", "timeZone only applies to a timed due");
  }
  const id = input.id ?? crypto.randomUUID();
  assertReminderId(id);

  const ics = buildReminderIcs({
    uid: id,
    summary,
    notes,
    due,
    priority,
    now: writeInstant(options.now ?? Date.now()),
  });
  const bytes = byteLength(ics);
  if (bytes > limits.maxResourceBytes) {
    throw new ApiError(
      422,
      "resource_too_large",
      `the reminder is ${bytes} bytes; MAX_RESOURCE_BYTES is ${limits.maxResourceBytes}`,
    );
  }
  const parsed = validateCreatedReminder(ics, limits, { uid: id, summary, notes, due, priority });

  return withWriteLimit(env, options.rateLimitKey, async () => {
    const collection = await resolveCollection(env, "reminders", input.reminderList, {
      fetchImpl: options.fetchImpl,
    });
    if (collection.readOnly) throw readOnlyCollectionError(collection, "reminder list");

    return auditWrite(options, "create_reminder", collection.id, id, async () => {
      let response;
      try {
        response = await putReminder(env, collection, id, ics, null, options);
      } catch (error) {
        if (error instanceof CalDavError && error.code === "conflict") {
          throw new ApiError(
            409,
            "already_exists",
            `reminder ${JSON.stringify(id)} already exists; call get_reminder on that id and ` +
              "compare instead of creating a second copy",
          );
        }
        throw reconcileMutationError(error, "create", id, "get_reminder");
      }
      return reminderResult(collection, id, parsed, response.etag);
    });
  });
}

export async function updateReminder(
  env: Env,
  input: UpdateReminderInput,
  options: ReminderWriteOptions = {},
): Promise<ReminderWriteResult> {
  assertReminderWriteEnabled(env);
  const limits = calendarLimits(env);
  assertReminderId(input.id);
  const etag = assertStrongEtag(input.etag);

  const summary = input.summary === undefined ? undefined : normalizeSummary(input.summary);
  const notes = normalizeText(input.notes, "notes");
  const priority = normalizePriority(input.priority);
  const due =
    input.due === undefined
      ? undefined
      : input.due === null
        ? null
        : resolveReminderDue(input.due, input.timeZone);
  if (input.timeZone !== undefined && (input.due === undefined || input.due === null)) {
    throw new ApiError(400, "invalid_request", "timeZone only applies to a timed due");
  }
  if (
    summary === undefined &&
    notes === undefined &&
    due === undefined &&
    priority === undefined &&
    input.completed === undefined
  ) {
    throw new ApiError(400, "invalid_request", "update_reminder needs at least one field to change");
  }
  const now = writeInstant(options.now ?? Date.now());

  return withWriteLimit(env, options.rateLimitKey, async () => {
    const collection = await resolveCollection(env, "reminders", input.reminderList, {
      fetchImpl: options.fetchImpl,
    });
    if (collection.readOnly) throw readOnlyCollectionError(collection, "reminder list");

    return auditWrite(options, "update_reminder", collection.id, input.id, async () => {
      const { ics, parsed } = await readWritableReminder(
        env,
        collection,
        input.id,
        etag,
        limits,
        options,
      );

      if (due !== undefined && due !== null) assertDueCompatible(parsed.master.start, due);

      const output = mutateResource(ics, parsed.uid, (editor) => {
        if (summary !== undefined) editor.setText("summary", summary);
        if (notes !== undefined) {
          if (notes === null) editor.remove("description");
          else editor.setText("description", notes);
        }
        if (due !== undefined) {
          // DUE and DURATION are mutually exclusive in a VTODO.
          editor.remove("duration");
          if (due === null) editor.remove("due");
          else if (due.allDay) editor.setDate("due", isoDate(due.date!));
          else editor.setDateTimeUtc("due", isoInZone(due.instant!, "UTC"));
        }
        if (priority !== undefined) {
          if (priority === null) editor.remove("priority");
          else editor.setInteger("priority", priority);
        }
        if (input.completed !== undefined) applyCompletion(editor, input.completed, now);
      });

      const bytes = byteLength(output);
      if (bytes > limits.maxResourceBytes) {
        throw new ApiError(
          422,
          "resource_too_large",
          `the updated reminder is ${bytes} bytes; MAX_RESOURCE_BYTES is ` +
            `${limits.maxResourceBytes}`,
        );
      }
      const updated = validateUpdatedReminder(output, limits, {
        uid: parsed.uid,
        summary,
        notes,
        due,
        priority,
        completed: input.completed,
        now,
      });

      let response;
      try {
        response = await putReminder(env, collection, input.id, output, etag, options);
      } catch (error) {
        if (error instanceof CalDavError && error.code === "conflict") {
          throw new ApiError(
            409,
            "conflict",
            "the reminder changed since you read it; call get_reminder again",
          );
        }
        throw reconcileMutationError(error, "update", input.id, "get_reminder");
      }
      return reminderResult(collection, input.id, updated, response.etag);
    });
  });
}

export async function completeReminder(
  env: Env,
  input: CompleteReminderInput,
  options: ReminderWriteOptions = {},
): Promise<ReminderWriteResult> {
  assertReminderWriteEnabled(env);
  const limits = calendarLimits(env);
  assertReminderId(input.id);
  const etag = assertStrongEtag(input.etag);
  const now = writeInstant(options.now ?? Date.now());

  return withWriteLimit(env, options.rateLimitKey, async () => {
    const collection = await resolveCollection(env, "reminders", input.reminderList, {
      fetchImpl: options.fetchImpl,
    });
    if (collection.readOnly) throw readOnlyCollectionError(collection, "reminder list");

    return auditWrite(options, "complete_reminder", collection.id, input.id, async () => {
      const { ics, parsed } = await readWritableReminder(
        env,
        collection,
        input.id,
        etag,
        limits,
        options,
      );
      const output = mutateResource(ics, parsed.uid, (editor) => {
        applyCompletion(editor, true, now);
      });

      const bytes = byteLength(output);
      if (bytes > limits.maxResourceBytes) {
        throw new ApiError(
          422,
          "resource_too_large",
          `the completed reminder is ${bytes} bytes; MAX_RESOURCE_BYTES is ` +
            `${limits.maxResourceBytes}`,
        );
      }
      const updated = validateUpdatedReminder(output, limits, {
        uid: parsed.uid,
        summary: undefined,
        notes: undefined,
        due: undefined,
        priority: undefined,
        completed: true,
        now,
      });

      let response;
      try {
        response = await putReminder(env, collection, input.id, output, etag, options);
      } catch (error) {
        if (error instanceof CalDavError && error.code === "conflict") {
          throw new ApiError(
            409,
            "conflict",
            "the reminder changed since you read it; call get_reminder again",
          );
        }
        throw reconcileMutationError(error, "complete", input.id, "get_reminder");
      }
      return reminderResult(collection, input.id, updated, response.etag);
    });
  });
}
