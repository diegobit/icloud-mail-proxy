import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalDavError, clearCalDavDiscoveryCache } from "../src/caldav";
import {
  getReminder,
  listReminders,
  type ReminderDetail,
  type ReminderListResult,
} from "../src/calendar-reminders";
import { handleRest } from "../src/rest";
import type { Env } from "../src/types";

const DSID = "123456789";
const HOME = `https://p42-caldav.icloud.com/${DSID}/calendars/`;

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
  <D:response><D:href>/${DSID}/calendars/cal-lavoro/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Lavoro</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    <D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
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

interface StubOptions {
  query?: string;
  multiget?: string;
  /** Called with each REPORT body; useful for asserting the request. */
  onReport?: (body: string) => void;
}

function stubFetch(options: StubOptions = {}): Array<{ method: string; url: string; body: string }> {
  const calls: Array<{ method: string; url: string; body: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = init?.body === undefined ? "" : String(init.body);
      calls.push({ method, url, body });
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
        options.onReport?.(body);
        return new Response(
          body.includes("calendar-multiget") ? options.multiget ?? "" : options.query ?? "",
          { status: 207 },
        );
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
  return calls;
}

function reportBody(calls: Array<{ method: string; url: string; body: string }>): string {
  const report = calls.find((call) => call.method === "REPORT");
  if (report === undefined) throw new Error("no REPORT was sent");
  return report.body;
}

async function list(
  env: Env,
  input: Parameters<typeof listReminders>[1],
): Promise<ReminderListResult> {
  return listReminders(env, input);
}

async function detail(
  env: Env,
  input: Parameters<typeof getReminder>[1],
): Promise<ReminderDetail> {
  return getReminder(env, input);
}

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(Error);
  return (error as { code?: string }).code ?? "";
}

const BASIC = [
  {
    id: "a-timed",
    ics: reminder(
      "a-timed",
      "DUE;TZID=Europe/Rome:20261022T090000",
      "SUMMARY:Call plumber",
      "PRIORITY:1",
      "STATUS:NEEDS-ACTION",
      "DESCRIPTION:Ask about the boiler",
    ),
  },
  {
    id: "b-date",
    ics: reminder(
      "b-date",
      "DUE;VALUE=DATE:20261023",
      "SUMMARY:Renew passport",
      "PRIORITY:5",
      "STATUS:IN-PROCESS",
      "PERCENT-COMPLETE:50",
    ),
  },
  {
    id: "c-undated",
    ics: reminder("c-undated", "SUMMARY:Buy milk", "PRIORITY:9", "STATUS:NEEDS-ACTION"),
  },
  {
    id: "d-completed",
    ics: reminder(
      "d-completed",
      "DUE;VALUE=DATE:20261021",
      "SUMMARY:Done",
      "STATUS:COMPLETED",
      "COMPLETED:20261020T120000Z",
      "PERCENT-COMPLETE:100",
    ),
  },
  {
    id: "e-cancelled",
    ics: reminder(
      "e-cancelled",
      "DUE;VALUE=DATE:20261022",
      "SUMMARY:Cancelled",
      "STATUS:CANCELLED",
    ),
  },
];

beforeEach(() => {
  clearCalDavDiscoveryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listReminders", () => {
  it("lists open reminders by default, excludes cancelled, and maps fields", async () => {
    stubFetch({ query: multistatus("list-reminders", BASIC) });

    const result = await list(makeEnv(), { reminderList: "Reminders" });

    expect(result.reminderList).toBe("Reminders");
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.reminders.map((entry) => entry.resourceId)).toEqual([
      "a-timed",
      "b-date",
      "c-undated",
    ]);

    const timed = result.reminders[0]!;
    expect(timed.collectionId).toBe("list-reminders");
    expect(timed.uid).toBe("a-timed");
    expect(timed.summary).toBe("Call plumber");
    expect(timed.due).toBe("2026-10-22T09:00:00+02:00");
    expect(timed.dueWall).toBe("2026-10-22T09:00:00");
    expect(timed.dueAllDay).toBe(false);
    expect(timed.dueTimeZone).toBe("Europe/Rome");
    expect(timed.dueTimeZoneUnresolved).toBe(false);
    expect(timed.priority).toBe(1);
    expect(timed.priorityLabel).toBe("high");
    expect(timed.status).toBe("NEEDS-ACTION");
    expect(timed.completed).toBeNull();
    expect(timed.percentComplete).toBeNull();
    expect(timed.isCompleted).toBe(false);
    expect(timed.isCancelled).toBe(false);
    expect(timed.readOnlyReason).toBeNull();

    const dated = result.reminders[1]!;
    expect(dated.due).toBe("2026-10-23");
    expect(dated.dueWall).toBe("2026-10-23T00:00:00");
    expect(dated.dueAllDay).toBe(true);
    expect(dated.dueTimeZone).toBeNull();
    expect(dated.priority).toBe(5);
    expect(dated.priorityLabel).toBe("medium");
    expect(dated.status).toBe("IN-PROCESS");
    expect(dated.percentComplete).toBe(50);
    expect(dated.isCompleted).toBe(false);

    const undated = result.reminders[2]!;
    expect(undated.due).toBeNull();
    expect(undated.dueWall).toBeNull();
    expect(undated.dueAllDay).toBe(false);
    expect(undated.dueTimeZone).toBeNull();
    expect(undated.priority).toBe(9);
    expect(undated.priorityLabel).toBe("low");
  });

  it("adds completed reminders with includeCompleted but never cancelled ones", async () => {
    stubFetch({ query: multistatus("list-reminders", BASIC) });

    const result = await list(makeEnv(), { reminderList: "Reminders", includeCompleted: true });

    expect(result.reminders.map((entry) => entry.resourceId)).toEqual([
      "d-completed",
      "a-timed",
      "b-date",
      "c-undated",
    ]);
    expect(result.reminders[0]!.isCompleted).toBe(true);
    expect(result.reminders[0]!.completed).toBe("2026-10-20T12:00:00Z");
    expect(result.reminders[0]!.percentComplete).toBe(100);
    expect(result.reminders.some((entry) => entry.resourceId === "e-cancelled")).toBe(false);
  });

  it("treats a COMPLETED timestamp as completed even when STATUS is open", async () => {
    const ics = reminder(
      "implicit",
      "SUMMARY:Implicit",
      "STATUS:NEEDS-ACTION",
      "COMPLETED:20261020T120000Z",
    );
    stubFetch({
      query: multistatus("list-reminders", [{ id: "implicit", ics }]),
    });

    const open = await list(makeEnv(), { reminderList: "Reminders" });
    expect(open.reminders).toEqual([]);

    const all = await list(makeEnv(), { reminderList: "Reminders", includeCompleted: true });
    expect(all.reminders).toHaveLength(1);
    expect(all.reminders[0]!.isCompleted).toBe(true);
    expect(all.reminders[0]!.completed).toBe("2026-10-20T12:00:00Z");
  });

  it("filters DUE inclusively from and exclusively to, and keeps undated reminders", async () => {
    stubFetch({ query: multistatus("list-reminders", BASIC) });

    const first = await list(makeEnv(), {
      reminderList: "Reminders",
      dueFrom: "2026-10-22",
      dueTo: "2026-10-23",
    });
    expect(first.reminders.map((entry) => entry.resourceId)).toEqual(["a-timed", "c-undated"]);

    const second = await list(makeEnv(), {
      reminderList: "Reminders",
      dueFrom: "2026-10-23",
      dueTo: "2026-10-24",
    });
    expect(second.reminders.map((entry) => entry.resourceId)).toEqual(["b-date", "c-undated"]);
  });

  it("includes floating and unresolved DUE reminders without placing them on the timeline", async () => {
    const floating = reminder("f-floating", "DUE:20261024T100000", "SUMMARY:Floating due");
    const nowhere = reminder(
      "g-nowhere",
      "DUE;TZID=Europe/Nowhere:20261025T100000",
      "SUMMARY:Nowhere due",
    );
    stubFetch({
      query: multistatus("list-reminders", [
        { id: "a-timed", ics: BASIC[0]!.ics },
        { id: "f-floating", ics: floating },
        { id: "g-nowhere", ics: nowhere },
      ]),
    });

    const result = await list(makeEnv(), {
      reminderList: "Reminders",
      dueFrom: "2026-10-24",
      dueTo: "2026-10-25",
    });

    expect(result.reminders.map((entry) => entry.resourceId)).toEqual(["f-floating", "g-nowhere"]);
    const [floatingEntry, nowhereEntry] = result.reminders;
    expect(floatingEntry!.due).toBeNull();
    expect(floatingEntry!.dueWall).toBe("2026-10-24T10:00:00");
    expect(floatingEntry!.dueTimeZone).toBeNull();
    expect(floatingEntry!.dueTimeZoneUnresolved).toBe(false);
    expect(nowhereEntry!.due).toBeNull();
    expect(nowhereEntry!.dueWall).toBe("2026-10-25T10:00:00");
    expect(nowhereEntry!.dueTimeZone).toBe("Europe/Nowhere");
    expect(nowhereEntry!.dueTimeZoneUnresolved).toBe(true);
  });

  it("sorts by DUE with undated last, independent of resource order", async () => {
    const late = reminder(
      "z-late",
      "DUE;TZID=Europe/Rome:20261025T090000",
      "SUMMARY:Late",
    );
    const early = reminder(
      "a-early",
      "DUE;TZID=Europe/Rome:20261021T090000",
      "SUMMARY:Early",
    );
    stubFetch({
      query: multistatus("list-reminders", [
        { id: "z-late", ics: late },
        { id: "m-undated", ics: reminder("m-undated", "SUMMARY:No due") },
        { id: "a-early", ics: early },
      ]),
    });

    const result = await list(makeEnv(), { reminderList: "Reminders" });
    expect(result.reminders.map((entry) => entry.resourceId)).toEqual([
      "a-early",
      "z-late",
      "m-undated",
    ]);
  });

  it("caps at MAX_REMINDERS after filtering and reports total and truncated", async () => {
    stubFetch({ query: multistatus("list-reminders", BASIC) });

    const capped = await list(makeEnv({ MAX_REMINDERS: "2" }), { reminderList: "Reminders" });
    expect(capped.reminders).toHaveLength(2);
    expect(capped.total).toBe(3);
    expect(capped.truncated).toBe(true);

    const exact = await list(makeEnv({ MAX_REMINDERS: "3" }), { reminderList: "Reminders" });
    expect(exact.reminders).toHaveLength(3);
    expect(exact.total).toBe(3);
    expect(exact.truncated).toBe(false);

    const withCompleted = await list(makeEnv({ MAX_REMINDERS: "3" }), {
      reminderList: "Reminders",
      includeCompleted: true,
    });
    expect(withCompleted.reminders).toHaveLength(3);
    expect(withCompleted.total).toBe(4);
    expect(withCompleted.truncated).toBe(true);
  });

  it("queries VTODO without a time-range and rejects a foreign href", async () => {
    const calls = stubFetch({
      query: multistatus("list-reminders", [{ id: "a-timed", ics: BASIC[0]!.ics }]),
    });
    await list(makeEnv(), { reminderList: "Reminders" });
    const body = reportBody(calls);
    expect(body).toContain('name="VTODO"');
    expect(body).not.toContain("time-range");

    clearCalDavDiscoveryCache();
    stubFetch({
      query: multistatus("list-casa", [{ id: "other", ics: BASIC[0]!.ics }]),
    });
    await expect(list(makeEnv(), { reminderList: "Reminders" })).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "malformed",
    );
  });

  it("rejects an oversized resource and a bad due range", async () => {
    const big = reminder("big", "SUMMARY:Big", `DESCRIPTION:${"x".repeat(2000)}`);
    stubFetch({
      query: multistatus("list-reminders", [{ id: "big", ics: big }]),
    });
    await expect(
      list(makeEnv({ MAX_RESOURCE_BYTES: "1024" }), { reminderList: "Reminders" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "resource_too_large");

    await expect(
      list(makeEnv(), {
        reminderList: "Reminders",
        dueFrom: "2026-10-24",
        dueTo: "2026-10-23",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_range");

    await expect(
      list(makeEnv(), { reminderList: "Reminders", dueFrom: "tomorrow" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
  });

  it("answers not_supported while reminder lists are disabled, without touching the network", async () => {
    const calls = stubFetch();
    await expect(
      list(makeEnv({ ALLOWED_REMINDER_LISTS: "" }), { reminderList: "Reminders" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    expect(calls).toHaveLength(0);
  });
});

describe("getReminder", () => {
  it("returns the full field mapping, the ETag and untrusted notes", async () => {
    const ics = reminder(
      "full",
      "DUE;TZID=Europe/Rome:20261022T090000",
      "DTSTART;TZID=Europe/Rome:20261021T080000",
      "SUMMARY:Call plumber",
      "DESCRIPTION:Ask about the boiler",
      "PRIORITY:1",
      "STATUS:NEEDS-ACTION",
      "PERCENT-COMPLETE:25",
    );
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "full", ics, etag: '"etag-full"' }]),
    });

    const result = await detail(makeEnv(), { reminderList: "Reminders", id: "full" });

    expect(result.reminderList).toBe("Reminders");
    expect(result.collectionId).toBe("list-reminders");
    expect(result.resourceId).toBe("full");
    expect(result.uid).toBe("full");
    expect(result.summary).toBe("Call plumber");
    expect(result.due).toBe("2026-10-22T09:00:00+02:00");
    expect(result.dueWall).toBe("2026-10-22T09:00:00");
    expect(result.dueAllDay).toBe(false);
    expect(result.dueTimeZone).toBe("Europe/Rome");
    expect(result.dueTimeZoneUnresolved).toBe(false);
    expect(result.start).toBe("2026-10-21T08:00:00+02:00");
    expect(result.startWall).toBe("2026-10-21T08:00:00");
    expect(result.startAllDay).toBe(false);
    expect(result.priority).toBe(1);
    expect(result.priorityLabel).toBe("high");
    expect(result.status).toBe("NEEDS-ACTION");
    expect(result.completed).toBeNull();
    expect(result.percentComplete).toBe(25);
    expect(result.isCompleted).toBe(false);
    expect(result.isCancelled).toBe(false);
    expect(result.etag).toBe('"etag-full"');
    expect(result.recurring).toBe(false);
    expect(result.scheduling).toBe(false);
    expect(result.readOnlyReason).toBeNull();
    expect(result.untrustedCalendarContent).toEqual({
      summary: "Call plumber",
      description: "Ask about the boiler",
    });
  });

  it("maps an all-day DUE and a COMPLETED timestamp", async () => {
    const ics = reminder(
      "done",
      "DUE;VALUE=DATE:20261021",
      "SUMMARY:Done",
      "STATUS:COMPLETED",
      "COMPLETED:20261020T120000Z",
      "PERCENT-COMPLETE:100",
    );
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "done", ics, etag: '"etag-done"' }]),
    });

    const result = await detail(makeEnv(), { reminderList: "Reminders", id: "done" });
    expect(result.due).toBe("2026-10-21");
    expect(result.dueWall).toBe("2026-10-21T00:00:00");
    expect(result.dueAllDay).toBe(true);
    expect(result.completed).toBe("2026-10-20T12:00:00Z");
    expect(result.isCompleted).toBe(true);
    expect(result.percentComplete).toBe(100);
  });

  it("marks recurring and scheduling reminders read-only", async () => {
    const recurring = reminder(
      "weekly",
      "DUE;TZID=Europe/Rome:20261026T090000",
      "DTSTART;TZID=Europe/Rome:20261026T090000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
      "SUMMARY:Weekly task",
    );
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "weekly", ics: recurring, etag: '"e1"' }]),
    });
    const weekly = await detail(makeEnv(), { reminderList: "Reminders", id: "weekly" });
    expect(weekly.recurring).toBe(true);
    expect(weekly.readOnlyReason).toBe("recurring");

    clearCalDavDiscoveryCache();
    const scheduled = reminder(
      "scheduled",
      "DUE;VALUE=DATE:20261027",
      "SUMMARY:Delegated",
      "ORGANIZER:mailto:owner@example.com",
    );
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "scheduled", ics: scheduled, etag: '"e2"' }]),
    });
    const assigned = await detail(makeEnv(), { reminderList: "Reminders", id: "scheduled" });
    expect(assigned.scheduling).toBe(true);
    expect(assigned.readOnlyReason).toBe("scheduling");
  });

  it("returns floating and unresolved DUE values with wall readings", async () => {
    const floating = reminder("floating", "DUE:20261024T100000", "SUMMARY:Floating");
    stubFetch({
      multiget: multistatus("list-reminders", [
        { id: "floating", ics: floating, etag: '"e1"' },
      ]),
    });
    const floatResult = await detail(makeEnv(), { reminderList: "Reminders", id: "floating" });
    expect(floatResult.due).toBeNull();
    expect(floatResult.dueWall).toBe("2026-10-24T10:00:00");
    expect(floatResult.dueTimeZone).toBeNull();
    expect(floatResult.dueTimeZoneUnresolved).toBe(false);

    clearCalDavDiscoveryCache();
    const nowhere = reminder(
      "nowhere",
      "DUE;TZID=Europe/Nowhere:20261025T100000",
      "SUMMARY:Nowhere",
    );
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "nowhere", ics: nowhere, etag: '"e2"' }]),
    });
    const nowhereResult = await detail(makeEnv(), { reminderList: "Reminders", id: "nowhere" });
    expect(nowhereResult.due).toBeNull();
    expect(nowhereResult.dueWall).toBe("2026-10-25T10:00:00");
    expect(nowhereResult.dueTimeZone).toBe("Europe/Nowhere");
    expect(nowhereResult.dueTimeZoneUnresolved).toBe(true);
  });

  it("maps a 404, a missing ETag, a foreign href and a non-VTODO resource", async () => {
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "missing", ics: "", status: 404 }]),
    });
    await expect(
      detail(makeEnv(), { reminderList: "Reminders", id: "missing" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_found");

    clearCalDavDiscoveryCache();
    const ics = reminder("no-etag", "SUMMARY:No ETag");
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "no-etag", ics }]),
    });
    await expect(
      detail(makeEnv(), { reminderList: "Reminders", id: "no-etag" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "malformed");

    clearCalDavDiscoveryCache();
    stubFetch({
      multiget: multistatus("list-casa", [{ id: "foreign", ics, etag: '"e"' }]),
    });
    await expect(
      detail(makeEnv(), { reminderList: "Reminders", id: "foreign" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "malformed");

    clearCalDavDiscoveryCache();
    const event = calendar(
      [
        "BEGIN:VEVENT",
        "UID:event",
        "DTSTAMP:20260101T000000Z",
        "DTSTART:20261022T080000Z",
        "END:VEVENT",
      ].join("\r\n"),
    );
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "event", ics: event, etag: '"e"' }]),
    });
    await expect(
      detail(makeEnv(), { reminderList: "Reminders", id: "event" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "malformed");
  });

  it("rejects an invalid id before any network call and refuses a disabled domain", async () => {
    const calls = stubFetch();
    await expect(
      detail(makeEnv(), { reminderList: "Reminders", id: "../x" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    expect(calls).toHaveLength(0);

    await expect(
      detail(makeEnv({ ALLOWED_REMINDER_LISTS: "" }), { reminderList: "Reminders", id: "full" }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    expect(calls).toHaveLength(0);
  });
});

describe("REST reminder routes", () => {
  async function restGet(path: string, env = makeEnv()): Promise<{ status: number; body: any }> {
    const response = await handleRest(new Request(`https://mail.example.com${path}`), env);
    return { status: response.status, body: await response.json() };
  }

  it("serves the list response and decodes the list name", async () => {
    stubFetch({
      query: multistatus("list-casa", [
        { id: "casa-a", ics: reminder("casa-a", "SUMMARY:Casa", "DUE;VALUE=DATE:20261023") },
      ]),
    });
    const { status, body } = await restGet("/v1/reminder-lists/Casa%20SP/reminders");
    expect(status).toBe(200);
    expect(body.reminderList).toBe("Casa SP");
    expect(body.reminders).toHaveLength(1);
    expect(body.reminders[0].resourceId).toBe("casa-a");
  });

  it("passes includeCompleted and due bounds, and rejects a bad boolean", async () => {
    stubFetch({ query: multistatus("list-reminders", BASIC) });

    const all = await restGet("/v1/reminder-lists/Reminders/reminders?includeCompleted=1");
    expect(all.status).toBe(200);
    expect(all.body.reminders.map((entry: any) => entry.resourceId)).toContain("d-completed");

    const bounded = await restGet(
      "/v1/reminder-lists/Reminders/reminders?dueFrom=2026-10-22&dueTo=2026-10-23",
    );
    expect(bounded.body.reminders.map((entry: any) => entry.resourceId)).toEqual([
      "a-timed",
      "c-undated",
    ]);

    const bad = await restGet("/v1/reminder-lists/Reminders/reminders?includeCompleted=maybe");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("invalid_request");
  });

  it("serves the detail response and its ETag", async () => {
    const ics = reminder(
      "full",
      "DUE;VALUE=DATE:20261023",
      "SUMMARY:Full",
      "DESCRIPTION:Notes",
    );
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "full", ics, etag: '"etag-rest"' }]),
    });
    const { status, body } = await restGet("/v1/reminder-lists/Reminders/reminders/full");
    expect(status).toBe(200);
    expect(body.etag).toBe('"etag-rest"');
    expect(body.untrustedCalendarContent.description).toBe("Notes");
  });

  it("answers not_supported while reminder lists are disabled, without touching the network", async () => {
    const calls = stubFetch();
    const env = makeEnv({ ALLOWED_REMINDER_LISTS: "" });
    const listResponse = await restGet("/v1/reminder-lists/Reminders/reminders", env);
    expect(listResponse.status).toBe(404);
    expect(listResponse.body.error.code).toBe("not_supported");

    const detailResponse = await restGet("/v1/reminder-lists/Reminders/reminders/full", env);
    expect(detailResponse.status).toBe(404);
    expect(detailResponse.body.error.code).toBe("not_supported");
    expect(calls).toHaveLength(0);
  });

  it("maps a missing reminder and an invalid id", async () => {
    stubFetch({
      multiget: multistatus("list-reminders", [{ id: "missing", ics: "", status: 404 }]),
    });
    const missing = await restGet("/v1/reminder-lists/Reminders/reminders/missing");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");

    clearCalDavDiscoveryCache();
    stubFetch();
    const invalid = await restGet("/v1/reminder-lists/Reminders/reminders/..%2Fx");
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("invalid_request");
  });
});
