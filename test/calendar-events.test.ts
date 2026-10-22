import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CalDavError, clearCalDavDiscoveryCache } from "../src/caldav";
import { getEvent, listEvents, type EventDetail, type EventListResult } from "../src/calendar-events";
import { handleRest } from "../src/rest";
import type { Env } from "../src/types";

const DSID = "123456789";
const HOME = `https://p42-caldav.icloud.com/${DSID}/calendars/`;
const NOW = Date.UTC(2026, 9, 21, 12); // 2026-10-21 14:00 in Europe/Rome (CEST)

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
  <D:response><D:href>/${DSID}/calendars/cal-casa/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Casa SP</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    <D:current-user-privilege-set><D:privilege><D:read/></D:privilege></D:current-user-privilege-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
  <D:response><D:href>/${DSID}/calendars/list-reminders/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Reminders</D:displayname>
    <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
    <D:current-user-privilege-set><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    API_TOKEN: "token",
    ICLOUD_USER: "owner@example.com",
    ICLOUD_APP_PASSWORD: "app-pass",
    ALLOWED_CALENDARS: "*",
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

function vevent(...lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

function event(uid: string, ...lines: string[]): string {
  return vevent(`UID:${uid}`, "DTSTAMP:20260101T000000Z", ...lines);
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
  input: Parameters<typeof listEvents>[1],
): Promise<EventListResult> {
  return listEvents(env, input, { now: NOW });
}

async function detail(
  env: Env,
  input: Parameters<typeof getEvent>[1],
): Promise<EventDetail> {
  return getEvent(env, input, { now: NOW });
}

function errorCode(error: unknown): string {
  expect(error).toBeInstanceOf(Error);
  return (error as { code?: string }).code ?? "";
}

beforeEach(() => {
  clearCalDavDiscoveryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listEvents", () => {
  it("parses a window, expands, sorts and filters overlapping occurrences", async () => {
    stubFetch({
      query: multistatus("cal-lavoro", [
        {
          id: "evt-a",
          ics: calendar(
            event(
              "evt-a",
              "DTSTART;TZID=Europe/Rome:20261021T100000",
              "DTEND;TZID=Europe/Rome:20261021T110000",
              "SUMMARY:Dentist",
              "LOCATION:Via Roma",
            ),
          ),
        },
        {
          id: "evt-b",
          ics: calendar(
            event("evt-b", "DTSTART:20261022T080000Z", "DTEND:20261022T090000Z", "SUMMARY:Standup"),
          ),
        },
        {
          id: "evt-c",
          ics: calendar(
            event(
              "evt-c",
              "DTSTART;VALUE=DATE:20261022",
              "DTEND;VALUE=DATE:20261023",
              "SUMMARY:Holiday",
            ),
          ),
        },
        {
          id: "evt-out",
          ics: calendar(
            event("evt-out", "DTSTART:20261025T080000Z", "DTEND:20261025T090000Z", "SUMMARY:Outside"),
          ),
        },
      ]),
    });

    const result = await list(makeEnv(), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
    });

    expect(result.calendar).toBe("Lavoro");
    expect(result.from).toBe("2026-10-21T00:00:00+02:00");
    expect(result.to).toBe("2026-10-24T00:00:00+02:00");
    expect(result.total).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.events.map((entry) => entry.resourceId)).toEqual(["evt-a", "evt-c", "evt-b"]);

    expect(result.events[0]).toMatchObject({
      collectionId: "cal-lavoro",
      resourceId: "evt-a",
      uid: "evt-a",
      recurrenceId: null,
      summary: "Dentist",
      location: "Via Roma",
      start: "2026-10-21T10:00:00+02:00",
      end: "2026-10-21T11:00:00+02:00",
      startWall: "2026-10-21T10:00:00",
      endWall: "2026-10-21T11:00:00",
      timeZone: "Europe/Rome",
      allDay: false,
      timeZoneUnresolved: false,
      isOverride: false,
      readOnlyReason: null,
    });
    expect(result.events[1]).toMatchObject({
      resourceId: "evt-c",
      summary: "Holiday",
      start: "2026-10-22",
      end: "2026-10-23",
      startWall: "2026-10-22T00:00:00",
      endWall: "2026-10-23T00:00:00",
      timeZone: null,
      allDay: true,
    });
    expect(result.events[2]).toMatchObject({
      resourceId: "evt-b",
      start: "2026-10-22T08:00:00Z",
      timeZone: null,
      allDay: false,
    });
    expect(result.events.every((entry) => !Object.hasOwn(entry, "etag"))).toBe(true);
  });

  it("uses overlap semantics: end-exclusive, all-day exclusive, zero-duration point", async () => {
    stubFetch({
      query: multistatus("cal-lavoro", [
        {
          id: "ends-at-from",
          ics: calendar(
            event("ends-at-from", "DTSTART:20261021T090000Z", "DTEND:20261021T100000Z"),
          ),
        },
        {
          id: "spans-from",
          ics: calendar(
            event("spans-from", "DTSTART:20261021T090000Z", "DTEND:20261021T103000Z"),
          ),
        },
        {
          id: "starts-at-to",
          ics: calendar(
            event("starts-at-to", "DTSTART:20261021T120000Z", "DTEND:20261021T130000Z"),
          ),
        },
        {
          id: "point-at-from",
          ics: calendar(event("point-at-from", "DTSTART:20261021T100000Z")),
        },
        {
          id: "point-at-to",
          ics: calendar(event("point-at-to", "DTSTART:20261021T120000Z")),
        },
        {
          id: "all-day-today",
          ics: calendar(event("all-day-today", "DTSTART;VALUE=DATE:20261021")),
        },
        {
          id: "all-day-yesterday",
          ics: calendar(event("all-day-yesterday", "DTSTART;VALUE=DATE:20261020")),
        },
      ]),
    });

    const result = await list(makeEnv(), {
      calendar: "Lavoro",
      from: "2026-10-21T10:00:00Z",
      to: "2026-10-21T12:00:00Z",
    });

    expect(result.events.map((entry) => entry.resourceId)).toEqual([
      "all-day-today",
      "spans-from",
      "point-at-from",
    ]);
  });

  it("excludes floating and unresolved-TZID times from range results", async () => {
    stubFetch({
      query: multistatus("cal-lavoro", [
        {
          id: "floating",
          ics: calendar(
            event("floating", "DTSTART:20261022T100000", "DTEND:20261022T110000", "SUMMARY:Float"),
          ),
        },
        {
          id: "nowhere",
          ics: calendar(
            event(
              "nowhere",
              "DTSTART;TZID=Europe/Nowhere:20261022T110000",
              "DTEND;TZID=Europe/Nowhere:20261022T120000",
              "SUMMARY:Nowhere",
            ),
          ),
        },
        {
          id: "timed",
          ics: calendar(
            event("timed", "DTSTART:20261022T080000Z", "DTEND:20261022T090000Z", "SUMMARY:Timed"),
          ),
        },
      ]),
    });

    const result = await list(makeEnv(), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
    });
    expect(result.events.map((entry) => entry.resourceId)).toEqual(["timed"]);
    expect(result.total).toBe(1);
  });

  it("defaults to a seven-day window from today and sends a UTC time-range", async () => {
    const calls = stubFetch({ query: multistatus("cal-lavoro", []) });
    const result = await list(makeEnv(), { calendar: "Lavoro" });

    expect(result.from).toBe("2026-10-21T00:00:00+02:00");
    expect(result.to).toBe("2026-10-28T00:00:00+01:00");
    const body = reportBody(calls);
    expect(body).toContain('start="20261020T220000Z"');
    expect(body).toContain('end="20261027T230000Z"');
    expect(body).toContain('name="VEVENT"');
  });

  it("refuses a range wider than MAX_CALENDAR_DAYS before any network call", async () => {
    const calls = stubFetch();
    try {
      await list(makeEnv(), { calendar: "Lavoro", from: "2026-01-01", to: "2026-04-02" });
      throw new Error("expected range_too_wide");
    } catch (error) {
      expect(errorCode(error)).toBe("range_too_wide");
      expect((error as { status: number }).status).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });

  it("accepts a range of exactly MAX_CALENDAR_DAYS", async () => {
    stubFetch({ query: multistatus("cal-lavoro", []) });
    const result = await list(makeEnv(), {
      calendar: "Lavoro",
      from: "2026-01-01",
      to: "2026-04-01",
    });
    expect(result.events).toEqual([]);
  });

  it("rejects a backwards or empty range", async () => {
    stubFetch();
    try {
      await list(makeEnv(), {
        calendar: "Lavoro",
        from: "2026-10-21T12:00:00Z",
        to: "2026-10-21T12:00:00Z",
      });
      throw new Error("expected invalid_range");
    } catch (error) {
      expect(errorCode(error)).toBe("invalid_range");
    }
  });

  it("stops with too_many_resources before parsing the resources", async () => {
    const resources = Array.from({ length: 3 }, (_, index) => ({
      id: `evt-${index}`,
      ics: index === 2 ? "not an iCalendar" : calendar(event(`evt-${index}`)),
    }));
    stubFetch({ query: multistatus("cal-lavoro", resources) });

    try {
      await list(makeEnv({ MAX_RESOURCES_PER_QUERY: "2" }), {
        calendar: "Lavoro",
        from: "2026-10-21",
        to: "2026-10-24",
      });
      throw new Error("expected too_many_resources");
    } catch (error) {
      expect(errorCode(error)).toBe("too_many_resources");
      expect((error as { status: number }).status).toBe(422);
    }
  });

  it("refuses one resource over MAX_RESOURCE_BYTES without parsing it", async () => {
    const big = "x".repeat(2000);
    stubFetch({
      query: multistatus("cal-lavoro", [
        {
          id: "evt-big",
          ics: calendar(
            event(
              "evt-big",
              "DTSTART:20261022T080000Z",
              "DTEND:20261022T090000Z",
              `DESCRIPTION:${big}`,
            ),
          ),
        },
      ]),
    });

    try {
      await list(makeEnv({ MAX_RESOURCE_BYTES: "1024" }), {
        calendar: "Lavoro",
        from: "2026-10-21",
        to: "2026-10-24",
      });
      throw new Error("expected resource_too_large");
    } catch (error) {
      expect(errorCode(error)).toBe("resource_too_large");
      expect((error as { status: number }).status).toBe(422);
    }
  });

  it("filters case-insensitively over summary and location only", async () => {
    stubFetch({
      query: multistatus("cal-lavoro", [
        {
          id: "dentist",
          ics: calendar(
            event(
              "dentist",
              "DTSTART:20261022T080000Z",
              "DTEND:20261022T090000Z",
              "SUMMARY:Dentist",
              "LOCATION:Via Roma",
            ),
          ),
        },
        {
          id: "market",
          ics: calendar(
            event(
              "market",
              "DTSTART:20261022T100000Z",
              "DTEND:20261022T110000Z",
              "SUMMARY:Groceries",
              "LOCATION:Market",
              "DESCRIPTION:Roma is not the location",
            ),
          ),
        },
      ]),
    });

    const env = makeEnv();
    const roma = await list(env, {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
      text: "ROMA",
    });
    expect(roma.events.map((entry) => entry.resourceId)).toEqual(["dentist"]);

    const dent = await list(env, {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
      text: "dent",
    });
    expect(dent.events.map((entry) => entry.resourceId)).toEqual(["dentist"]);

    const descriptionOnly = await list(env, {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
      text: "is not the location",
    });
    expect(descriptionOnly.events).toEqual([]);
  });

  it("caps at limit, reports the pre-cap total, and clamps to MAX_EVENT_RESULTS", async () => {
    const resources = Array.from({ length: 3 }, (_, index) => ({
      id: `evt-${index}`,
      ics: calendar(
        event(
          `evt-${index}`,
          `DTSTART:2026102${1 + index}T080000Z`,
          `DTEND:2026102${1 + index}T090000Z`,
        ),
      ),
    }));
    stubFetch({ query: multistatus("cal-lavoro", resources) });

    const limited = await list(makeEnv(), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
      limit: 2,
    });
    expect(limited.events).toHaveLength(2);
    expect(limited.total).toBe(3);
    expect(limited.truncated).toBe(true);
    expect(limited.truncatedReason).toBe("limit");

    const clamped = await list(makeEnv({ MAX_EVENT_RESULTS: "1" }), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
      limit: 5,
    });
    expect(clamped.events).toHaveLength(1);
    expect(clamped.total).toBe(3);
    expect(clamped.truncated).toBe(true);
    expect(clamped.truncatedReason).toBe("limit");

    try {
      await list(makeEnv(), { calendar: "Lavoro", limit: 0 });
      throw new Error("expected invalid_request");
    } catch (error) {
      expect(errorCode(error)).toBe("invalid_request");
    }
  });

  it("expands a recurring resource and keeps occurrence identity", async () => {
    stubFetch({
      query: multistatus("cal-lavoro", [
        {
          id: "evt-r",
          ics: calendar(
            event(
              "evt-r",
              "DTSTART;TZID=Europe/Rome:20261021T090000",
              "DTEND;TZID=Europe/Rome:20261021T100000",
              "RRULE:FREQ=DAILY;COUNT=3",
              "EXDATE;TZID=Europe/Rome:20261023T090000",
              "RDATE;TZID=Europe/Rome:20261024T090000",
              "SUMMARY:Daily",
            ),
            vevent(
              "UID:evt-r",
              "DTSTAMP:20260101T000000Z",
              "RECURRENCE-ID;TZID=Europe/Rome:20261022T090000",
              "DTSTART;TZID=Europe/Rome:20261022T140000",
              "DTEND;TZID=Europe/Rome:20261022T150000",
              "SUMMARY:Moved",
            ),
          ),
        },
      ]),
    });

    const result = await list(makeEnv(), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-25",
    });

    expect(result.events).toHaveLength(3);
    expect(result.events.map((entry) => entry.summary)).toEqual(["Daily", "Moved", "Daily"]);
    expect(result.events.map((entry) => entry.recurrenceId)).toEqual([
      "2026-10-21T09:00:00+02:00",
      "2026-10-22T09:00:00+02:00",
      "2026-10-24T09:00:00+02:00",
    ]);
    expect(result.events.map((entry) => entry.isOverride)).toEqual([false, true, false]);
    expect(result.events.every((entry) => entry.uid === "evt-r")).toBe(true);
    expect(result.events.every((entry) => entry.resourceId === "evt-r")).toBe(true);
    expect(result.events.every((entry) => entry.collectionId === "cal-lavoro")).toBe(true);
    expect(result.events.every((entry) => entry.readOnlyReason === "recurring")).toBe(true);
  });

  it("omits cancelled events and cancelled overrides from the list", async () => {
    stubFetch({
      query: multistatus("cal-lavoro", [
        {
          id: "evt-cancelled",
          ics: calendar(
            event(
              "evt-cancelled",
              "DTSTART:20261021T080000Z",
              "DTEND:20261021T090000Z",
              "STATUS:CANCELLED",
              "SUMMARY:Cancelled",
            ),
          ),
        },
        {
          id: "evt-series",
          ics: calendar(
            event(
              "evt-series",
              "DTSTART:20261021T090000Z",
              "DTEND:20261021T100000Z",
              "RRULE:FREQ=WEEKLY;COUNT=3",
              "SUMMARY:Series",
            ),
            vevent(
              "UID:evt-series",
              "DTSTAMP:20260101T000000Z",
              "RECURRENCE-ID:20261028T090000Z",
              "DTSTART:20261028T090000Z",
              "DTEND:20261028T100000Z",
              "STATUS:CANCELLED",
              "SUMMARY:Cancelled this week",
            ),
          ),
        },
      ]),
    });

    const result = await list(makeEnv(), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-11-10",
    });

    expect(result.events.map((entry) => entry.summary)).toEqual(["Series", "Series"]);
    expect(result.events.map((entry) => entry.recurrenceId)).toEqual([
      "2026-10-21T09:00:00Z",
      "2026-11-04T09:00:00Z",
    ]);
    expect(result.total).toBe(2);
  });

  it("marks a scheduling resource as read-only", async () => {
    stubFetch({
      query: multistatus("cal-lavoro", [
        {
          id: "evt-s",
          ics: calendar(
            event(
              "evt-s",
              "DTSTART:20261022T100000Z",
              "DTEND:20261022T110000Z",
              "ORGANIZER:mailto:owner@example.com",
              "ATTENDEE:mailto:guest@example.com",
            ),
          ),
        },
      ]),
    });

    const result = await list(makeEnv(), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
    });
    expect(result.events[0]!.readOnlyReason).toBe("scheduling");
    expect(result.events[0]!.recurrenceId).toBeNull();
  });

  it("reports recurrence-budget truncation and occurrence-cap truncation", async () => {
    const daily = multistatus("cal-lavoro", [
      {
        id: "evt-d",
        ics: calendar(
          event(
            "evt-d",
            "DTSTART:20261021T080000Z",
            "DTEND:20261021T090000Z",
            "RRULE:FREQ=DAILY",
          ),
        ),
      },
    ]);
    stubFetch({ query: daily });
    const budget = await list(makeEnv({ MAX_RECURRENCE_CANDIDATES_PER_REQUEST: "1" }), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
    });
    expect(budget.truncated).toBe(true);
    expect(budget.truncatedReason).toBe("recurrence_budget");

    clearCalDavDiscoveryCache();
    stubFetch({ query: daily });
    const cap = await list(makeEnv({ MAX_OCCURRENCES_PER_RESOURCE: "1" }), {
      calendar: "Lavoro",
      from: "2026-10-21",
      to: "2026-10-24",
    });
    expect(cap.events).toHaveLength(1);
    expect(cap.truncated).toBe(true);
    expect(cap.truncatedReason).toBe("occurrence_cap");
  });

  it("fails closed on a malformed resource rather than returning a partial list", async () => {
    stubFetch({
      query: multistatus("cal-lavoro", [
        { id: "evt-bad", ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR" },
      ]),
    });
    try {
      await list(makeEnv(), { calendar: "Lavoro", from: "2026-10-21", to: "2026-10-24" });
      throw new Error("expected malformed");
    } catch (error) {
      expect(error).toBeInstanceOf(CalDavError);
      expect(errorCode(error)).toBe("malformed");
    }
  });

  it("rejects an href outside the selected collection", async () => {
    stubFetch({
      query: multistatus("cal-casa", [
        {
          id: "evt-x",
          ics: calendar(event("evt-x", "DTSTART:20261022T080000Z")),
        },
      ]),
    });
    try {
      await list(makeEnv(), { calendar: "Lavoro", from: "2026-10-21", to: "2026-10-24" });
      throw new Error("expected malformed");
    } catch (error) {
      expect(errorCode(error)).toBe("malformed");
    }
  });

  it("fails closed when calendars are disabled, before any network call", async () => {
    const calls = stubFetch();
    try {
      await list(makeEnv({ ALLOWED_CALENDARS: "" }), {
        calendar: "Lavoro",
        from: "2026-10-21",
        to: "2026-10-24",
      });
      throw new Error("expected not_supported");
    } catch (error) {
      expect(errorCode(error)).toBe("not_supported");
      expect((error as { status: number }).status).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });
});

describe("getEvent", () => {
  const recurring = calendar(
    event(
      "evt-r",
      "DTSTART;TZID=Europe/Rome:20261021T090000",
      "DTEND;TZID=Europe/Rome:20261021T100000",
      "RRULE:FREQ=WEEKLY;COUNT=3",
      "SUMMARY:Weekly sync",
      "DESCRIPTION:Line one\\nLine two",
      "LOCATION:Office",
    ),
  );

  it("reads one resource with its ETag and next occurrences", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-r", ics: recurring, etag: '"etag-1"' }]),
    });

    const result = await detail(makeEnv(), { calendar: "Lavoro", id: "evt-r" });

    expect(result).toMatchObject({
      calendar: "Lavoro",
      collectionId: "cal-lavoro",
      resourceId: "evt-r",
      uid: "evt-r",
      etag: '"etag-1"',
      recurring: true,
      scheduling: false,
      readOnlyReason: "recurring",
      recurrenceRule: "FREQ=WEEKLY;COUNT=3",
      allDay: false,
      start: "2026-10-21T09:00:00+02:00",
      end: "2026-10-21T10:00:00+02:00",
      startWall: "2026-10-21T09:00:00",
      endWall: "2026-10-21T10:00:00",
      timeZone: "Europe/Rome",
      timeZoneUnresolved: false,
      from: "2026-10-21T00:00:00+02:00",
      to: "2027-01-18T23:00:00+01:00",
      truncated: false,
      unsupportedRange: false,
    });
    expect(result.untrustedCalendarContent).toEqual({
      summary: "Weekly sync",
      description: "Line one\nLine two",
      location: "Office",
    });
    expect(result.occurrences.map((entry) => entry.recurrenceId)).toEqual([
      "2026-10-21T09:00:00+02:00",
      "2026-10-28T09:00:00+01:00",
      "2026-11-04T09:00:00+01:00",
    ]);
    expect(result.occurrences.every((entry) => entry.isOverride === false)).toBe(true);

    const body = reportBody(calls);
    expect(body).toContain("calendar-multiget");
    expect(body).toContain(`<D:href>/${DSID}/calendars/cal-lavoro/evt-r.ics</D:href>`);
  });

  it("keeps cancelled occurrences and their status in the detail view", async () => {
    const cancelled = calendar(
      event(
        "evt-c",
        "DTSTART:20261021T090000Z",
        "DTEND:20261021T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=3",
        "STATUS:CONFIRMED",
        "SUMMARY:Series",
      ),
      vevent(
        "UID:evt-c",
        "DTSTAMP:20260101T000000Z",
        "RECURRENCE-ID:20261028T090000Z",
        "DTSTART:20261028T090000Z",
        "DTEND:20261028T100000Z",
        "STATUS:CANCELLED",
        "SUMMARY:Cancelled this week",
      ),
    );
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-c", ics: cancelled, etag: '"etag-c"' }]),
    });

    const result = await detail(makeEnv(), { calendar: "Lavoro", id: "evt-c" });
    expect(result.status).toBe("CONFIRMED");
    expect(result.occurrences.map((entry) => entry.status)).toEqual([
      "CONFIRMED",
      "CANCELLED",
      "CONFIRMED",
    ]);
  });

  it("returns 404 when the multiget answers with a 404 response", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-r", ics: "", status: 404 }]),
    });
    try {
      await detail(makeEnv(), { calendar: "Lavoro", id: "evt-r" });
      throw new Error("expected not_found");
    } catch (error) {
      expect(error).toBeInstanceOf(CalDavError);
      expect(errorCode(error)).toBe("not_found");
      expect((error as CalDavError).status).toBe(404);
    }
  });

  it("returns 404 when the multistatus is empty", async () => {
    stubFetch({ multiget: multistatus("cal-lavoro", []) });
    try {
      await detail(makeEnv(), { calendar: "Lavoro", id: "evt-r" });
      throw new Error("expected not_found");
    } catch (error) {
      expect(errorCode(error)).toBe("not_found");
    }
  });

  it("fails closed without an ETag", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-r", ics: recurring }]),
    });
    try {
      await detail(makeEnv(), { calendar: "Lavoro", id: "evt-r" });
      throw new Error("expected malformed");
    } catch (error) {
      expect(errorCode(error)).toBe("malformed");
    }
  });

  it("rejects an invalid id before any network call", async () => {
    const calls = stubFetch();
    try {
      await detail(makeEnv(), { calendar: "Lavoro", id: "../other" });
      throw new Error("expected invalid_request");
    } catch (error) {
      expect(errorCode(error)).toBe("invalid_request");
    }
    expect(calls).toHaveLength(0);
  });

  it("fails closed when calendars are disabled, before any network call", async () => {
    const calls = stubFetch();
    try {
      await detail(makeEnv({ ALLOWED_CALENDARS: "" }), { calendar: "Lavoro", id: "evt-r" });
      throw new Error("expected not_supported");
    } catch (error) {
      expect(errorCode(error)).toBe("not_supported");
    }
    expect(calls).toHaveLength(0);
  });

  it("rejects an unrelated href in the multiget response", async () => {
    stubFetch({
      multiget: multistatus("cal-casa", [{ id: "evt-r", ics: recurring, etag: '"etag-1"' }]),
    });
    try {
      await detail(makeEnv(), { calendar: "Lavoro", id: "evt-r" });
      throw new Error("expected malformed");
    } catch (error) {
      expect(errorCode(error)).toBe("malformed");
    }
  });

  it("rejects a VTODO resource", async () => {
    const todo = calendar(
      [
        "BEGIN:VTODO",
        "UID:todo-1",
        "DTSTAMP:20260101T000000Z",
        "DUE:20261023T100000Z",
        "SUMMARY:Buy milk",
        "END:VTODO",
      ].join("\r\n"),
    );
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "todo-1", ics: todo, etag: '"etag-1"' }]),
    });
    try {
      await detail(makeEnv(), { calendar: "Lavoro", id: "todo-1" });
      throw new Error("expected malformed");
    } catch (error) {
      expect(errorCode(error)).toBe("malformed");
    }
  });

  it("marks a scheduling-only event as scheduling", async () => {
    const scheduled = calendar(
      event(
        "evt-s",
        "DTSTART:20261022T100000Z",
        "DTEND:20261022T110000Z",
        "ORGANIZER:mailto:owner@example.com",
        "ATTENDEE:mailto:guest@example.com",
      ),
    );
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-s", ics: scheduled, etag: '"etag-s"' }]),
    });
    const result = await detail(makeEnv(), { calendar: "Lavoro", id: "evt-s" });
    expect(result.recurring).toBe(false);
    expect(result.scheduling).toBe(true);
    expect(result.readOnlyReason).toBe("scheduling");
    expect(result.recurrenceRule).toBeNull();
  });

  it("returns a floating event with no absolute start and no window occurrences", async () => {
    const floating = calendar(
      event("evt-f", "DTSTART:20261021T100000", "DTEND:20261021T110000", "SUMMARY:Float"),
    );
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-f", ics: floating, etag: '"etag-f"' }]),
    });
    const result = await detail(makeEnv(), { calendar: "Lavoro", id: "evt-f" });
    expect(result.start).toBeNull();
    expect(result.end).toBeNull();
    expect(result.startWall).toBe("2026-10-21T10:00:00");
    expect(result.timeZone).toBeNull();
    expect(result.timeZoneUnresolved).toBe(false);
    expect(result.occurrences).toEqual([]);
  });

  it("returns an unresolved-TZID event with the zone named and no occurrences", async () => {
    const nowhere = calendar(
      event(
        "evt-n",
        "DTSTART;TZID=Europe/Nowhere:20261021T100000",
        "DTEND;TZID=Europe/Nowhere:20261021T110000",
      ),
    );
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-n", ics: nowhere, etag: '"etag-n"' }]),
    });
    const result = await detail(makeEnv(), { calendar: "Lavoro", id: "evt-n" });
    expect(result.start).toBeNull();
    expect(result.timeZone).toBe("Europe/Nowhere");
    expect(result.timeZoneUnresolved).toBe(true);
    expect(result.occurrences).toEqual([]);
  });

  it("reports an unsupported RANGE without hiding the resource", async () => {
    const ranged = calendar(
      event(
        "evt-range",
        "DTSTART:20261021T090000Z",
        "DTEND:20261021T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=3",
      ),
      vevent(
        "UID:evt-range",
        "DTSTAMP:20260101T000000Z",
        "RECURRENCE-ID;RANGE=THISANDFUTURE:20261028T090000Z",
        "DTSTART:20261028T110000Z",
        "DTEND:20261028T120000Z",
      ),
    );
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-range", ics: ranged, etag: '"etag-r"' }]),
    });
    const result = await detail(makeEnv(), { calendar: "Lavoro", id: "evt-range" });
    expect(result.unsupportedRange).toBe(true);
    expect(result.readOnlyReason).toBe("recurring");
  });
});

describe("REST event routes", () => {
  async function restGet(path: string, env = makeEnv()): Promise<{ status: number; body: any }> {
    const response = await handleRest(new Request(`https://mail.example.com${path}`), env);
    return { status: response.status, body: await response.json() };
  }

  it("serves the same list response over REST and decodes the calendar name", async () => {
    stubFetch({
      query: multistatus("cal-casa", [
        {
          id: "evt-a",
          ics: calendar(
            event("evt-a", "DTSTART:20261022T080000Z", "DTEND:20261022T090000Z", "SUMMARY:Casa"),
          ),
        },
      ]),
    });
    const { status, body } = await restGet(
      "/v1/calendars/Casa%20SP/events?from=2026-10-21&to=2026-10-24",
    );
    expect(status).toBe(200);
    expect(body.calendar).toBe("Casa SP");
    expect(body.events).toHaveLength(1);
    expect(body.events[0].resourceId).toBe("evt-a");
  });

  it("serves the detail response and its ETag over REST", async () => {
    const ics = calendar(
      event(
        "evt-r",
        "DTSTART;TZID=Europe/Rome:20261021T090000",
        "DTEND;TZID=Europe/Rome:20261021T100000",
        "RRULE:FREQ=WEEKLY;COUNT=2",
        "SUMMARY:Weekly",
      ),
    );
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-r", ics, etag: '"etag-rest"' }]),
    });
    const { status, body } = await restGet("/v1/calendars/Lavoro/events/evt-r?from=2026-10-21");
    expect(status).toBe(200);
    expect(body.etag).toBe('"etag-rest"');
    expect(body.occurrences).toHaveLength(2);
  });

  it("answers not_supported while calendars are disabled, without touching the network", async () => {
    const calls = stubFetch();
    const { status, body } = await restGet("/v1/calendars/Lavoro/events", makeEnv({ ALLOWED_CALENDARS: "" }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_supported");
    expect(calls).toHaveLength(0);
  });

  it("rejects a bad limit and an empty bound", async () => {
    stubFetch();
    const badLimit = await restGet("/v1/calendars/Lavoro/events?limit=0");
    expect(badLimit.status).toBe(400);
    expect(badLimit.body.error.code).toBe("invalid_request");

    const emptyFrom = await restGet("/v1/calendars/Lavoro/events?from=");
    expect(emptyFrom.status).toBe(400);
    expect(emptyFrom.body.error.code).toBe("invalid_request");
  });

  it("maps a missing event to 404", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "evt-r", ics: "", status: 404 }]),
    });
    const { status, body } = await restGet("/v1/calendars/Lavoro/events/evt-r");
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});
