import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCalDavDiscoveryCache } from "../src/caldav";
import {
  completeReminder,
  createReminder,
  updateReminder,
  type CompleteReminderInput,
  type CreateReminderInput,
  type ReminderWriteOptions,
  type ReminderWriteResult,
  type UpdateReminderInput,
} from "../src/calendar-reminder-write";
import { handleRest } from "../src/rest";
import type { Env } from "../src/types";

const DSID = "123456789";
const HOME = `https://p42-caldav.icloud.com/${DSID}/calendars/`;
const NOW = Date.UTC(2026, 9, 21, 12, 0, 0);

const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response><D:href>/</D:href><D:propstat>
    <D:prop><D:current-user-principal><D:href>/${DSID}/principal/</D:href></D:current-user-principal></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat></D:response>
</D:multistatus>`;

const PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/${DSID}/principal/</D:href><D:propstat>
    <D:prop><C:calendar-home-set><D:href>${HOME}</D:href></C:calendar-home-set></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat></D:response>
</D:multistatus>`;

const COLLECTIONS = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response><D:href>/${DSID}/calendars/list-reminders/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Reminders</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    <D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/${DSID}/calendars/list-casa/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Casa SP</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    <D:current-user-privilege-set><D:privilege><D:read/></D:privilege></D:current-user-privilege-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_TOKEN: "token",
    ICLOUD_USER: "owner@example.com",
    ICLOUD_APP_PASSWORD: "app-pass",
    ALLOWED_CALENDARS: "*",
    ALLOWED_REMINDER_LISTS: "*",
    REMINDERS_WRITE: "1",
    CALENDAR_WRITE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
    ...overrides,
  } as unknown as Env;
}

function calendar(...components: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//icloud-mail-proxy test//EN",
    ...components,
    "END:VCALENDAR",
  ].join("\r\n");
}

function vtodo(...lines: string[]): string {
  return ["BEGIN:VTODO", ...lines, "END:VTODO"].join("\r\n");
}

function reminder(uid: string, ...lines: string[]): string {
  return calendar(vtodo(`UID:${uid}`, "DTSTAMP:20260101T000000Z", ...lines));
}

interface Resource {
  id: string;
  ics: string;
  etag?: string;
  status?: number;
}

function multistatus(collectionId: string, resources: Resource[]): string {
  const responses = resources
    .map((resource) => {
      const href = `/${DSID}/calendars/${collectionId}/${resource.id}.ics`;
      if (resource.status !== undefined) {
        return (
          `<D:response><D:href>${href}</D:href>` +
          `<D:status>HTTP/1.1 ${resource.status} ${resource.status === 404 ? "Not Found" : "Error"}</D:status>` +
          `</D:response>`
        );
      }
      return (
        `<D:response><D:href>${href}</D:href><D:propstat><D:prop>` +
        (resource.etag === undefined ? "" : `<D:getetag>${resource.etag}</D:getetag>`) +
        `<C:calendar-data>${resource.ics}</C:calendar-data>` +
        `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${responses}</D:multistatus>`
  );
}

interface PutResponse {
  status?: number;
  etag?: string | null;
  /** Simulate a transport failure after the request was dispatched. */
  drop?: boolean;
}

interface StubOptions {
  multiget?: string;
  query?: string;
  put?: PutResponse;
}

interface StubCall {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

function stubFetch(options: StubOptions = {}): StubCall[] {
  const calls: StubCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = init?.body === undefined ? "" : String(init.body);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
      calls.push({ method, url, body, headers });

      if (method === "PROPFIND" && url === "https://caldav.icloud.com/") {
        return new Response(ROOT, { status: 207 });
      }
      if (method === "PROPFIND" && url === `https://caldav.icloud.com/${DSID}/principal/`) {
        return new Response(PRINCIPAL, { status: 207 });
      }
      if (method === "PROPFIND" && url === HOME) {
        return new Response(COLLECTIONS, { status: 207 });
      }
      if (method === "REPORT") {
        return new Response(
          body.includes("calendar-multiget") ? options.multiget ?? "" : options.query ?? "",
          { status: 207 },
        );
      }
      if (method === "PUT") {
        if (options.put?.drop === true) throw new TypeError("fetch failed");
        const responseHeaders: Record<string, string> = {};
        if (options.put?.etag !== null) {
          responseHeaders.ETag = options.put?.etag ?? '"put-etag"';
        }
        return new Response(null, { status: options.put?.status ?? 201, headers: responseHeaders });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
  return calls;
}

function putCall(calls: StubCall[]): StubCall {
  const put = calls.find((call) => call.method === "PUT");
  if (put === undefined) throw new Error("no PUT was sent");
  return put;
}

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(Error);
  return (error as { code?: string }).code ?? "";
}

function captureLogs(): string[] {
  const lines: string[] = [];
  vi.mocked(console.log).mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

function auditLine(lines: string[], action: string): Record<string, unknown> {
  const line = lines.find((entry) => entry.includes(`"action":"${action}"`));
  expect(line).toBeDefined();
  expect(line!.startsWith("calendar_write ")).toBe(true);
  return JSON.parse(line!.slice("calendar_write ".length)) as Record<string, unknown>;
}

async function create(
  env: Env,
  input: CreateReminderInput,
  options: ReminderWriteOptions = {},
): Promise<ReminderWriteResult> {
  return createReminder(env, input, options);
}

async function update(
  env: Env,
  input: UpdateReminderInput,
  options: ReminderWriteOptions = {},
): Promise<ReminderWriteResult> {
  return updateReminder(env, input, options);
}

async function complete(
  env: Env,
  input: CompleteReminderInput,
  options: ReminderWriteOptions = {},
): Promise<ReminderWriteResult> {
  return completeReminder(env, input, options);
}

const OPEN = reminder(
  "full",
  "DTSTART;TZID=Europe/Rome:20261023T090000",
  "DUE;TZID=Europe/Rome:20261024T090000",
  "SUMMARY:Old title",
  "DESCRIPTION:Old notes",
  "PRIORITY:5",
  "STATUS:NEEDS-ACTION",
  "X-APPLE-ORDER:42",
);

const COMPLETED = reminder(
  "done",
  "DUE;VALUE=DATE:20261022",
  "SUMMARY:Done already",
  "STATUS:COMPLETED",
  "COMPLETED:20261020T120000Z",
  "PERCENT-COMPLETE:100",
);

const RECURRING = reminder(
  "weekly",
  "DUE;TZID=Europe/Rome:20261026T090000",
  "DTSTART;TZID=Europe/Rome:20261026T090000",
  "RRULE:FREQ=WEEKLY;COUNT=2",
  "SUMMARY:Weekly task",
  "STATUS:NEEDS-ACTION",
);

const SCHEDULED = reminder(
  "assigned",
  "DUE;VALUE=DATE:20261027",
  "SUMMARY:Delegated",
  "STATUS:NEEDS-ACTION",
  "ORGANIZER:mailto:owner@example.com",
);

const DATE_START = reminder(
  "full",
  "DTSTART;VALUE=DATE:20261023",
  "SUMMARY:Date start",
  "STATUS:NEEDS-ACTION",
);

const ALARMED = reminder(
  "full",
  "DTSTART;TZID=Europe/Rome:20261023T090000",
  "DUE;TZID=Europe/Rome:20261024T090000",
  "SUMMARY:Alarm task",
  "STATUS:NEEDS-ACTION",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Reminder",
  "END:VALARM",
);

const FLOATING_START = reminder(
  "full",
  "DTSTART:20261023T090000",
  "DUE:20261024T090000",
  "SUMMARY:Floating start",
  "STATUS:NEEDS-ACTION",
);

const DURATION_TODO = reminder(
  "duration",
  "DTSTART:20261023T070000Z",
  "DURATION:PT1H",
  "SUMMARY:Duration task",
  "STATUS:NEEDS-ACTION",
);

beforeEach(() => {
  clearCalDavDiscoveryCache();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createReminder", () => {
  it("creates a timed reminder as UTC, defaults to Europe/Rome and audits without text", async () => {
    const calls = stubFetch();
    const logs = captureLogs();
    const env = makeEnv();
    const limiter = vi.mocked(env.CALENDAR_WRITE_LIMITER);

    const result = await create(
      env,
      {
        reminderList: "Reminders",
        id: "new-one",
        summary: "Call plumber",
        notes: "Ask about the boiler",
        due: "2026-10-22T10:00:00",
        priority: 1,
      },
      { principal: "tester", now: NOW, rateLimitKey: "203.0.113.9" },
    );

    expect(result.reminderList).toBe("Reminders");
    expect(result.collectionId).toBe("list-reminders");
    expect(result.resourceId).toBe("new-one");
    expect(result.uid).toBe("new-one");
    expect(result.etag).toBe('"put-etag"');
    expect(result.summary).toBe("Call plumber");
    expect(result.due).toBe("2026-10-22T08:00:00Z");
    expect(result.dueWall).toBe("2026-10-22T08:00:00");
    expect(result.dueAllDay).toBe(false);
    expect(result.dueTimeZone).toBeNull();
    expect(result.priority).toBe(1);
    expect(result.priorityLabel).toBe("high");
    expect(result.status).toBe("NEEDS-ACTION");
    expect(result.completed).toBeNull();
    expect(result.percentComplete).toBeNull();
    expect(result.isCompleted).toBe(false);
    expect(result.readOnlyReason).toBeNull();
    expect(result.untrustedCalendarContent).toEqual({
      summary: "Call plumber",
      description: "Ask about the boiler",
    });

    const put = putCall(calls);
    expect(put.url).toBe(`${HOME}list-reminders/new-one.ics`);
    expect(put.headers["if-none-match"]).toBe("*");
    expect(put.headers["content-type"]).toBe("text/calendar; charset=utf-8");
    expect(put.body).toContain("BEGIN:VTODO");
    expect(put.body).toContain("UID:new-one");
    expect(put.body).toContain("DTSTAMP:20261021T120000Z");
    expect(put.body).toContain("SUMMARY:Call plumber");
    expect(put.body).toContain("DESCRIPTION:Ask about the boiler");
    expect(put.body).toContain("DUE:20261022T080000Z");
    expect(put.body).toContain("PRIORITY:1");
    expect(put.body).toContain("STATUS:NEEDS-ACTION");
    expect(put.body).not.toContain("TZID");
    expect(put.body).not.toContain("RRULE");
    expect(put.body).not.toContain("VALARM");

    expect(limiter.limit).toHaveBeenCalledWith({ key: "203.0.113.9" });
    const audit = auditLine(logs, "create_reminder");
    expect(audit).toEqual({
      principal: "tester",
      action: "create_reminder",
      calendar: "list-reminders",
      resource: "new-one",
      outcome: "ok",
    });
    expect(JSON.stringify(audit)).not.toContain("Call plumber");
    expect(JSON.stringify(audit)).not.toContain("boiler");
  });

  it("creates an all-day reminder with DATE values and no priority or notes", async () => {
    const calls = stubFetch();

    const result = await create(
      makeEnv(),
      { reminderList: "Reminders", id: "all-day", summary: "Renew passport", due: "2026-10-23" },
      { now: NOW },
    );

    expect(result.due).toBe("2026-10-23");
    expect(result.dueWall).toBe("2026-10-23T00:00:00");
    expect(result.dueAllDay).toBe(true);
    expect(result.dueTimeZone).toBeNull();
    expect(result.priority).toBeNull();
    expect(result.priorityLabel).toBe("none");
    expect(result.untrustedCalendarContent.description).toBeNull();

    const body = putCall(calls).body;
    expect(body).toContain("DUE;VALUE=DATE:20261023");
    expect(body).not.toContain("DUE:");
    expect(body).not.toContain("DESCRIPTION");
    expect(body).not.toContain("PRIORITY");
  });

  it("creates an undated reminder with a generated UUID", async () => {
    const calls = stubFetch();

    const result = await create(makeEnv(), { reminderList: "Reminders", summary: "Buy milk" });

    expect(result.resourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.uid).toBe(result.resourceId);
    expect(result.due).toBeNull();
    expect(result.priority).toBeNull();
    const body = putCall(calls).body;
    expect(body).toContain(`UID:${result.resourceId}`);
    expect(body).not.toContain("DUE");
    expect(body).not.toContain("PRIORITY");
  });

  it("converts a non-default timeZone to UTC", async () => {
    const calls = stubFetch();

    const result = await create(
      makeEnv(),
      {
        reminderList: "Reminders",
        id: "ny",
        summary: "New York call",
        due: "2026-10-22T10:00:00",
        timeZone: "America/New_York",
      },
      { now: NOW },
    );

    expect(result.due).toBe("2026-10-22T14:00:00Z");
    expect(putCall(calls).body).toContain("DUE:20261022T140000Z");
  });

  it("accepts a caller id and reports already_exists on a 412 without leaking text", async () => {
    stubFetch({ put: { status: 412 } });
    const logs = captureLogs();

    await expect(
      create(makeEnv(), {
        reminderList: "Reminders",
        id: "duplicate",
        summary: "Secret title",
        notes: "Secret notes",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "already_exists");

    expect(auditLine(logs, "create_reminder")).toMatchObject({
      resource: "duplicate",
      outcome: "already_exists",
    });
    expect(logs.join("\n")).not.toContain("Secret");
  });

  it("rejects contradictory forms and bad values before the network", async () => {
    const calls = stubFetch();
    const env = makeEnv();
    const cases: Array<Partial<CreateReminderInput>> = [
      { due: "2026-10-22", timeZone: "Europe/Rome" },
      { due: "2026-10-22T10:00:00Z" },
      { timeZone: "Europe/Rome" },
      { due: "not-a-date" },
      { due: "2026-02-30T10:00:00" },
      { due: "2026-10-22T24:00:00" },
      { priority: 10 },
      { priority: -1 },
      { priority: 1.5 },
      { summary: "   " },
      { summary: "x".repeat(201) },
      { notes: "x".repeat(8193) },
      { id: "../escape" },
      { id: "a/b" },
      { id: ".." },
      { id: "." },
    ];

    for (const overrides of cases) {
      await expect(
        create(env, { reminderList: "Reminders", summary: "Valid", ...overrides }),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a read-only reminder list without a PUT", async () => {
    const calls = stubFetch();

    await expect(
      create(makeEnv(), { reminderList: "Casa SP", id: "x", summary: "Nope" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "read_only_collection");

    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("refuses while reminder writes or the domain are disabled, without touching the network", async () => {
    const calls = stubFetch();

    await expect(
      create(makeEnv({ REMINDERS_WRITE: "0" }), { reminderList: "Reminders", summary: "Nope" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    await expect(
      create(makeEnv({ ALLOWED_REMINDER_LISTS: "" }), { reminderList: "Reminders", summary: "Nope" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    expect(calls).toHaveLength(0);
  });

  it("fails closed without a limiter and refuses a denied bucket", async () => {
    const calls = stubFetch();
    const missing = makeEnv();
    delete (missing as unknown as { CALENDAR_WRITE_LIMITER?: unknown }).CALENDAR_WRITE_LIMITER;

    await expect(
      create(missing, { reminderList: "Reminders", summary: "Nope" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "configuration_error");

    await expect(
      create(
        makeEnv({
          CALENDAR_WRITE_LIMITER: { limit: vi.fn(async () => ({ success: false })) },
        }),
        { reminderList: "Reminders", summary: "Nope" },
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "rate_limited");
    expect(calls).toHaveLength(0);
  });

  it("reports mutation_state_unknown when the PUT connection drops", async () => {
    stubFetch({ put: { drop: true } });
    const logs = captureLogs();

    await expect(
      create(makeEnv(), { reminderList: "Reminders", id: "maybe", summary: "Maybe" }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("mutation_state_unknown");
      expect((error as Error).message).toContain("get_reminder");
      expect((error as Error).message).toContain('"maybe"');
      return true;
    });

    expect(auditLine(logs, "create_reminder").outcome).toBe("mutation_state_unknown");
  });
});

describe("updateReminder", () => {
  function stubbed(ics = OPEN, etag = '"old-etag"', put: PutResponse = {}): StubCall[] {
    return stubFetch({
      multiget: multistatus("list-reminders", [{ id: "full", ics, etag }]),
      put,
    });
  }

  it("changes only the fields passed and preserves DTSTART and Apple properties", async () => {
    const calls = stubbed();
    const logs = captureLogs();

    const result = await update(
      makeEnv(),
      {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        summary: "New title",
        notes: "New notes",
        due: "2026-10-25T10:00:00",
        priority: 1,
      },
      { principal: "tester", now: NOW },
    );

    expect(result.summary).toBe("New title");
    expect(result.untrustedCalendarContent.description).toBe("New notes");
    expect(result.due).toBe("2026-10-25T09:00:00Z");
    expect(result.dueAllDay).toBe(false);
    expect(result.priority).toBe(1);
    expect(result.priorityLabel).toBe("high");
    expect(result.status).toBe("NEEDS-ACTION");
    expect(result.etag).toBe('"put-etag"');

    const put = putCall(calls);
    expect(put.headers["if-match"]).toBe('"old-etag"');
    expect(put.body).toContain("SUMMARY:New title");
    expect(put.body).toContain("DESCRIPTION:New notes");
    expect(put.body).toContain("DUE:20261025T090000Z");
    expect(put.body).toContain("PRIORITY:1");
    expect(put.body).toContain("DTSTART;TZID=Europe/Rome:20261023T090000");
    expect(put.body).toContain("X-APPLE-ORDER:42");
    expect(put.body).not.toContain("DURATION");
    expect(auditLine(logs, "update_reminder")).toMatchObject({
      action: "update_reminder",
      calendar: "list-reminders",
      resource: "full",
      outcome: "ok",
    });
  });

  it("preserves an existing VALARM", async () => {
    const calls = stubbed(ALARMED);

    const result = await update(makeEnv(), {
      reminderList: "Reminders",
      id: "full",
      etag: '"old-etag"',
      summary: "Alarm task renamed",
    });

    expect(result.summary).toBe("Alarm task renamed");
    const body = putCall(calls).body;
    expect(body).toContain("SUMMARY:Alarm task renamed");
    expect(body).toContain("BEGIN:VALARM");
    expect(body).toContain("ACTION:DISPLAY");
    expect(body).toContain("TRIGGER:-PT15M");
    expect(body).toContain("END:VALARM");
  });

  it("removes notes, due and priority with null and preserves the rest", async () => {
    const calls = stubbed();

    const result = await update(makeEnv(), {
      reminderList: "Reminders",
      id: "full",
      etag: '"old-etag"',
      notes: null,
      due: null,
      priority: null,
    });

    expect(result.untrustedCalendarContent.description).toBeNull();
    expect(result.due).toBeNull();
    expect(result.priority).toBeNull();
    expect(result.priorityLabel).toBe("none");

    const body = putCall(calls).body;
    expect(body).not.toContain("DESCRIPTION");
    expect(body).not.toContain("DUE");
    expect(body).not.toContain("DURATION");
    expect(body).not.toContain("PRIORITY");
    expect(body).toContain("SUMMARY:Old title");
    expect(body).toContain("DTSTART;TZID=Europe/Rome:20261023T090000");
  });

  it("replaces a DURATION with DUE when the due changes", async () => {
    const calls = stubbed(DURATION_TODO);

    const result = await update(makeEnv(), {
      reminderList: "Reminders",
      id: "full",
      etag: '"old-etag"',
      due: "2026-10-24T09:00:00",
    });

    expect(result.due).toBe("2026-10-24T07:00:00Z");
    const body = putCall(calls).body;
    expect(body).toContain("DUE:20261024T070000Z");
    expect(body).not.toContain("DURATION");
    expect(body).toContain("DTSTART:20261023T070000Z");
  });

  it("un-completes with completed false and removes COMPLETED and PERCENT-COMPLETE", async () => {
    const calls = stubbed(COMPLETED);

    const result = await update(makeEnv(), {
      reminderList: "Reminders",
      id: "full",
      etag: '"old-etag"',
      completed: false,
    });

    expect(result.status).toBe("NEEDS-ACTION");
    expect(result.completed).toBeNull();
    expect(result.percentComplete).toBeNull();
    expect(result.isCompleted).toBe(false);

    const body = putCall(calls).body;
    expect(body).toContain("STATUS:NEEDS-ACTION");
    expect(body).not.toContain("COMPLETED:");
    expect(body).not.toContain("PERCENT-COMPLETE");
    expect(body).toContain("SUMMARY:Done already");
  });

  it("completes with completed true and the configured UTC now", async () => {
    const calls = stubbed();

    const result = await update(
      makeEnv(),
      {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        completed: true,
      },
      { now: NOW },
    );

    expect(result.status).toBe("COMPLETED");
    expect(result.completed).toBe("2026-10-21T12:00:00Z");
    expect(result.percentComplete).toBe(100);
    expect(result.isCompleted).toBe(true);

    const body = putCall(calls).body;
    expect(body).toContain("STATUS:COMPLETED");
    expect(body).toContain("COMPLETED:20261021T120000Z");
    expect(body).toContain("PERCENT-COMPLETE:100");
  });

  it("requires exactly one strong ETag and never PUTs on a weak or stale tag", async () => {
    const calls = stubFetch();
    const env = makeEnv();
    const base = { reminderList: "Reminders", id: "full", summary: "New" };

    for (const etag of ['W/"weak"', "*", '"a", "b"', "", '"unterminated']) {
      await expect(
        update(env, { ...base, etag }),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_etag");
    }
    expect(calls).toHaveLength(0);

    clearCalDavDiscoveryCache();
    const staleCalls = stubbed(OPEN, '"old-etag"');
    await expect(
      update(env, { ...base, etag: '"stale"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "conflict");
    expect(staleCalls.some((call) => call.method === "PUT")).toBe(false);

    const logs = captureLogs();
    await expect(
      update(env, { ...base, etag: '"stale"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "conflict");
    expect(auditLine(logs, "update_reminder").outcome).toBe("conflict");
  });

  it("refuses recurring and scheduling reminders without a PUT", async () => {
    const recurringCalls = stubbed(RECURRING);
    await expect(
      update(makeEnv(), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        summary: "New",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "recurring_not_supported");
    expect(recurringCalls.some((call) => call.method === "PUT")).toBe(false);

    clearCalDavDiscoveryCache();
    const scheduledCalls = stubbed(SCHEDULED);
    await expect(
      update(makeEnv(), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        summary: "New",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "scheduling_not_supported");
    expect(scheduledCalls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("refuses a read-only collection and an empty patch", async () => {
    const calls = stubFetch();

    await expect(
      update(makeEnv(), {
        reminderList: "Casa SP",
        id: "full",
        etag: '"old-etag"',
        summary: "New",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "read_only_collection");

    await expect(
      update(makeEnv(), { reminderList: "Reminders", id: "full", etag: '"old-etag"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("refuses a due whose value type or absolute form contradicts DTSTART", async () => {
    const dateCalls = stubbed(DATE_START);
    await expect(
      update(makeEnv(), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        due: "2026-10-24T09:00:00",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    expect(dateCalls.some((call) => call.method === "PUT")).toBe(false);

    clearCalDavDiscoveryCache();
    const floatingCalls = stubbed(FLOATING_START);
    await expect(
      update(makeEnv(), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        due: "2026-10-25T09:00:00",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    expect(floatingCalls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("rejects timeZone without a timed due", async () => {
    const calls = stubFetch();
    const env = makeEnv();

    await expect(
      update(env, {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        summary: "New",
        timeZone: "Europe/Rome",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");

    await expect(
      update(env, {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        due: "2026-10-24",
        timeZone: "Europe/Rome",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("maps a dropped PUT to mutation_state_unknown and a 409 to conflict", async () => {
    stubbed(OPEN, '"old-etag"', { drop: true });
    await expect(
      update(makeEnv(), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        summary: "New",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("mutation_state_unknown");
      expect((error as Error).message).toContain("get_reminder");
      return true;
    });

    clearCalDavDiscoveryCache();
    stubbed(OPEN, '"old-etag"', { status: 409 });
    await expect(
      update(makeEnv(), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        summary: "New",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "conflict");
  });

  it("reports a missing resource and a mismatched kind", async () => {
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "full", ics: "", status: 404 }]),
    });
    await expect(
      update(makeEnv(), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        summary: "New",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_found");

    clearCalDavDiscoveryCache();
    const event = calendar(
      [
        "BEGIN:VEVENT",
        "UID:full",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20261022T080000Z",
        "SUMMARY:Event",
        "END:VEVENT",
      ].join("\r\n"),
    );
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "full", ics: event, etag: '"old-etag"' }]),
    });
    await expect(
      update(makeEnv(), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
        summary: "New",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "malformed");
  });
});

describe("completeReminder", () => {
  function stubbed(ics = OPEN, put: PutResponse = {}): StubCall[] {
    return stubFetch({
      multiget: multistatus("list-reminders", [{ id: "full", ics, etag: '"old-etag"' }]),
      put,
    });
  }

  it("sets STATUS, COMPLETED and PERCENT-COMPLETE and keeps the text", async () => {
    const calls = stubbed();
    const logs = captureLogs();

    const result = await complete(
      makeEnv(),
      { reminderList: "Reminders", id: "full", etag: '"old-etag"' },
      { principal: "tester", now: NOW },
    );

    expect(result.status).toBe("COMPLETED");
    expect(result.completed).toBe("2026-10-21T12:00:00Z");
    expect(result.percentComplete).toBe(100);
    expect(result.isCompleted).toBe(true);
    expect(result.summary).toBe("Old title");
    expect(result.untrustedCalendarContent.description).toBe("Old notes");
    expect(result.etag).toBe('"put-etag"');

    const put = putCall(calls);
    expect(put.headers["if-match"]).toBe('"old-etag"');
    expect(put.body).toContain("STATUS:COMPLETED");
    expect(put.body).toContain("COMPLETED:20261021T120000Z");
    expect(put.body).toContain("PERCENT-COMPLETE:100");
    expect(put.body).toContain("SUMMARY:Old title");
    expect(auditLine(logs, "complete_reminder").outcome).toBe("ok");
  });

  it("updates an already completed reminder to the new completion time", async () => {
    const calls = stubbed(COMPLETED);

    const result = await complete(
      makeEnv(),
      { reminderList: "Reminders", id: "full", etag: '"old-etag"' },
      { now: Date.UTC(2026, 9, 22, 8, 30, 0) },
    );

    expect(result.completed).toBe("2026-10-22T08:30:00Z");
    expect(putCall(calls).body).toContain("COMPLETED:20261022T083000Z");
  });

  it("refuses a stale ETag, a recurring reminder and a read-only list", async () => {
    const staleCalls = stubbed();
    await expect(
      complete(makeEnv(), { reminderList: "Reminders", id: "full", etag: '"stale"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "conflict");
    expect(staleCalls.some((call) => call.method === "PUT")).toBe(false);

    clearCalDavDiscoveryCache();
    const recurringCalls = stubbed(RECURRING);
    await expect(
      complete(makeEnv(), { reminderList: "Reminders", id: "full", etag: '"old-etag"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "recurring_not_supported");
    expect(recurringCalls.some((call) => call.method === "PUT")).toBe(false);

    clearCalDavDiscoveryCache();
    const readOnlyCalls = stubFetch();
    await expect(
      complete(makeEnv(), { reminderList: "Casa SP", id: "full", etag: '"old-etag"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "read_only_collection");
    expect(readOnlyCalls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("refuses a weak ETag and a disabled write flag without network", async () => {
    const calls = stubFetch();
    await expect(
      complete(makeEnv(), { reminderList: "Reminders", id: "full", etag: 'W/"weak"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_etag");
    await expect(
      complete(makeEnv({ REMINDERS_WRITE: "0" }), {
        reminderList: "Reminders",
        id: "full",
        etag: '"old-etag"',
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    expect(calls).toHaveLength(0);
  });

  it("fails closed without a limiter and reports a dropped PUT", async () => {
    const missing = makeEnv();
    delete (missing as unknown as { CALENDAR_WRITE_LIMITER?: unknown }).CALENDAR_WRITE_LIMITER;
    stubFetch();
    await expect(
      complete(missing, { reminderList: "Reminders", id: "full", etag: '"old-etag"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "configuration_error");

    clearCalDavDiscoveryCache();
    stubbed(OPEN, { drop: true });
    await expect(
      complete(makeEnv(), { reminderList: "Reminders", id: "full", etag: '"old-etag"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "mutation_state_unknown");
  });
});

describe("REST reminder write routes", () => {
  async function rest(
    method: string,
    path: string,
    body: unknown,
    env = makeEnv(),
  ): Promise<{ status: number; body: any }> {
    const response = await handleRest(
      new Request(`https://mail.example.com${path}`, {
        method,
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.10" },
        body: JSON.stringify(body),
      }),
      env,
    );
    return { status: response.status, body: await response.json() };
  }

  it("creates with 201, updates with 200 and completes with 200", async () => {
    stubFetch();
    const created = await rest("POST", "/v1/reminder-lists/Reminders/reminders", {
      id: "rest-new",
      summary: "Rest create",
      due: "2026-10-23T10:00:00",
      priority: 5,
    });
    expect(created.status).toBe(201);
    expect(created.body.resourceId).toBe("rest-new");
    expect(created.body.due).toBe("2026-10-23T08:00:00Z");
    expect(created.body.etag).toBe('"put-etag"');

    clearCalDavDiscoveryCache();
    stubFetch({
      multiget: multistatus("list-reminders", [
        { id: "rest-new", ics: OPEN, etag: '"rest-old"' },
      ]),
    });
    const updated = await rest("PUT", "/v1/reminder-lists/Reminders/reminders/rest-new", {
      etag: '"rest-old"',
      summary: "Rest update",
      completed: false,
    });
    expect(updated.status).toBe(200);
    expect(updated.body.summary).toBe("Rest update");

    clearCalDavDiscoveryCache();
    stubFetch({
      multiget: multistatus("list-reminders", [
        { id: "rest-new", ics: OPEN, etag: '"rest-old"' },
      ]),
    });
    const completed = await rest(
      "POST",
      "/v1/reminder-lists/Reminders/reminders/rest-new/complete",
      { etag: '"rest-old"' },
    );
    expect(completed.status).toBe(200);
    expect(completed.body.status).toBe("COMPLETED");
    expect(completed.body.percentComplete).toBe(100);
  });

  it("rejects unknown body keys with unsupported_field", async () => {
    const calls = stubFetch();

    const created = await rest("POST", "/v1/reminder-lists/Reminders/reminders", {
      summary: "Nope",
      rrule: "FREQ=DAILY",
    });
    expect(created.status).toBe(400);
    expect(created.body.error.code).toBe("unsupported_field");

    const updated = await rest("PUT", "/v1/reminder-lists/Reminders/reminders/full", {
      etag: '"old"',
      organizer: "mailto:x@example.com",
    });
    expect(updated.status).toBe(400);
    expect(updated.body.error.code).toBe("unsupported_field");

    const completed = await rest(
      "POST",
      "/v1/reminder-lists/Reminders/reminders/full/complete",
      { etag: '"old"', summary: "Nope" },
    );
    expect(completed.status).toBe(400);
    expect(completed.body.error.code).toBe("unsupported_field");
    expect(calls).toHaveLength(0);
  });

  it("answers not_supported while reminder writes are disabled, without the network", async () => {
    const calls = stubFetch();
    const env = makeEnv({ REMINDERS_WRITE: "0" });

    for (const [method, path, body] of [
      ["POST", "/v1/reminder-lists/Reminders/reminders", { summary: "Nope" }],
      ["PUT", "/v1/reminder-lists/Reminders/reminders/full", { etag: '"old"', summary: "Nope" }],
      ["POST", "/v1/reminder-lists/Reminders/reminders/full/complete", { etag: '"old"' }],
    ] as const) {
      const response = await rest(method, path, body, env);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe("not_supported");
    }
    expect(calls).toHaveLength(0);
  });

  it("validates the body strictly and decodes the list name", async () => {
    const calls = stubFetch();

    const badPriority = await rest("POST", "/v1/reminder-lists/Reminders/reminders", {
      summary: "Nope",
      priority: 10,
    });
    expect(badPriority.status).toBe(400);
    expect(badPriority.body.error.code).toBe("invalid_request");

    const badCompleted = await rest("PUT", "/v1/reminder-lists/Reminders/reminders/full", {
      etag: '"old"',
      completed: "yes",
    });
    expect(badCompleted.status).toBe(400);
    expect(badCompleted.body.error.code).toBe("invalid_request");

    const missingEtag = await rest(
      "POST",
      "/v1/reminder-lists/Reminders/reminders/full/complete",
      {},
    );
    expect(missingEtag.status).toBe(400);
    expect(missingEtag.body.error.code).toBe("invalid_request");

    const readOnly = await rest("POST", "/v1/reminder-lists/Casa%20SP/reminders", {
      summary: "Nope",
    });
    expect(readOnly.status).toBe(403);
    expect(readOnly.body.error.code).toBe("read_only_collection");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
