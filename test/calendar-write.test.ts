import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCalDavDiscoveryCache } from "../src/caldav";
import {
  createEvent,
  deleteEvent,
  updateEvent,
  type CalendarWriteOptions,
  type CreateEventInput,
  type DeleteEventInput,
  type EventWriteResult,
  type UpdateEventInput,
} from "../src/calendar-write";
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
    <D:current-user-privilege-set><D:privilege><D:read/></D:privilege><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>
  </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
</D:multistatus>`;

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Rome",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

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

function plainEvent(...lines: string[]): string {
  return calendar(
    vevent("UID:plain", "DTSTAMP:20260101T000000Z", ...lines),
    VTIMEZONE,
  );
}

const PLAIN = plainEvent(
  "DTSTART;TZID=Europe/Rome:20261022T100000",
  "DTEND;TZID=Europe/Rome:20261022T110000",
  "SUMMARY:Original",
  "DESCRIPTION:Keep this",
  "LOCATION:Office",
  "X-APPLE-STRUCTURED-LOCATION;VALUE=URI:geo:41.9,12.5",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:Reminder",
  "TRIGGER:-PT15M",
  "END:VALARM",
);

const DURATION_EVENT = plainEvent(
  "DTSTART;TZID=Europe/Rome:20261022T100000",
  "DURATION:PT1H",
  "SUMMARY:One hour",
);

const ALL_DAY = plainEvent(
  "DTSTART;VALUE=DATE:20261022",
  "DTEND;VALUE=DATE:20261023",
  "SUMMARY:Day off",
);

const FLOATING = plainEvent(
  "DTSTART:20261022T100000",
  "DTEND:20261022T110000",
  "SUMMARY:Floating",
);

const RECURRING = plainEvent(
  "DTSTART;TZID=Europe/Rome:20261022T100000",
  "DTEND;TZID=Europe/Rome:20261022T110000",
  "RRULE:FREQ=WEEKLY;COUNT=2",
  "SUMMARY:Weekly",
);

const SCHEDULED = calendar(
  vevent(
    "UID:scheduled",
    "DTSTAMP:20260101T000000Z",
    "DTSTART:20261022T080000Z",
    "DTEND:20261022T090000Z",
    "ORGANIZER:mailto:owner@example.com",
    "SUMMARY:Meeting",
  ),
);

const VTODO = calendar(
  [
    "BEGIN:VTODO",
    "UID:todo",
    "DTSTAMP:20260101T000000Z",
    "SUMMARY:Task",
    "END:VTODO",
  ].join("\r\n"),
);

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

interface Call {
  method: string;
  url: string;
  body: string;
  headers: Record<string, string>;
}

interface StubOptions {
  multiget?: string;
  put?: (call: Call) => Response | Promise<Response>;
  putThrows?: boolean;
  delete?: (call: Call) => Response | Promise<Response>;
  deleteThrows?: boolean;
}

function headerMap(headers: HeadersInit | undefined): Record<string, string> {
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function stubFetch(options: StubOptions = {}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      const body = init?.body === undefined ? "" : String(init.body);
      const call: Call = { method, url, body, headers: headerMap(init?.headers) };
      calls.push(call);
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
          body.includes("calendar-multiget") ? options.multiget ?? "" : "",
          { status: 207 },
        );
      }
      if (method === "PUT") {
        if (options.putThrows) throw new TypeError("network down");
        if (options.put !== undefined) return options.put(call);
        return new Response("", { status: 201, headers: { etag: '"etag-new"' } });
      }
      if (method === "DELETE") {
        if (options.deleteThrows) throw new TypeError("network down");
        if (options.delete !== undefined) return options.delete(call);
        return new Response(null, { status: 204 });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    }),
  );
  return calls;
}

function putCall(calls: Call[]): Call {
  const call = calls.find((entry) => entry.method === "PUT");
  if (call === undefined) throw new Error("no PUT was sent");
  return call;
}

function deleteCall(calls: Call[]): Call {
  const call = calls.find((entry) => entry.method === "DELETE");
  if (call === undefined) throw new Error("no DELETE was sent");
  return call;
}

function fakeLimiter(success = true) {
  const keys: string[] = [];
  const limit = vi.fn(async ({ key }: { key: string }) => {
    keys.push(key);
    return { success };
  });
  return { limit, keys };
}

function makeEnv(overrides: Record<string, unknown> = {}): Env {
  return {
    API_TOKEN: "token",
    ICLOUD_USER: "owner@example.com",
    ICLOUD_APP_PASSWORD: "app-pass",
    ALLOWED_CALENDARS: "*",
    CALENDAR_WRITE: "1",
    CALENDAR_WRITE_LIMITER: fakeLimiter(),
    ...overrides,
  } as unknown as Env;
}

function create(
  env: Env,
  input: CreateEventInput,
  options: CalendarWriteOptions = {},
): Promise<EventWriteResult> {
  return createEvent(env, input, { now: NOW, principal: "tester", ...options });
}

function update(
  env: Env,
  input: UpdateEventInput,
  options: CalendarWriteOptions = {},
): Promise<EventWriteResult> {
  return updateEvent(env, input, { now: NOW, principal: "tester", ...options });
}

function remove(
  env: Env,
  input: DeleteEventInput,
  options: CalendarWriteOptions = {},
): Promise<unknown> {
  return deleteEvent(env, input, { now: NOW, principal: "tester", ...options });
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

function createInput(overrides: Partial<CreateEventInput> = {}): CreateEventInput {
  return {
    calendar: "Lavoro",
    summary: "Dentist",
    start: "2026-10-22T10:00:00",
    end: "2026-10-22T11:00:00",
    ...overrides,
  };
}

beforeEach(() => {
  clearCalDavDiscoveryCache();
  // The write core audits every attempt; keep the test output quiet unless a
  // specific test captures the lines.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createEvent", () => {
  it("creates a timed event as UTC, escapes text and defaults to Europe/Rome", async () => {
    const calls = stubFetch();
    const logs = captureLogs();

    const result = await create(makeEnv(), {
      ...createInput(),
      summary: "  Dentist; check, teeth  ",
      location: "Via Roma, 1; floor 2",
      description: "Line one\nLine two \\ backslash",
    });

    expect(result.collectionId).toBe("cal-lavoro");
    expect(result.calendar).toBe("Lavoro");
    expect(result.resourceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.uid).toBe(result.resourceId);
    expect(result.etag).toBe('"etag-new"');
    expect(result.summary).toBe("Dentist; check, teeth");
    expect(result.start).toBe("2026-10-22T10:00:00+02:00");
    expect(result.end).toBe("2026-10-22T11:00:00+02:00");
    expect(result.timeZone).toBe("Europe/Rome");
    expect(result.allDay).toBe(false);

    const put = putCall(calls);
    expect(put.url).toBe(
      `https://p42-caldav.icloud.com/${DSID}/calendars/cal-lavoro/${result.resourceId}.ics`,
    );
    expect(put.headers["If-None-Match"]).toBe("*");
    expect(put.headers["Content-Type"]).toBe("text/calendar; charset=utf-8");
    expect(put.body).toContain(`UID:${result.resourceId}`);
    expect(put.body).toContain("DTSTAMP:20261021T120000Z");
    expect(put.body).toContain("DTSTART:20261022T080000Z");
    expect(put.body).toContain("DTEND:20261022T090000Z");
    expect(put.body).toContain("SUMMARY:Dentist\\; check\\, teeth");
    expect(put.body).toContain("LOCATION:Via Roma\\, 1\\; floor 2");
    expect(put.body).toContain("DESCRIPTION:Line one\\nLine two \\\\ backslash");
    expect(put.body).not.toContain("TZID");
    expect(put.body).not.toContain("RRULE");
    expect(put.body).not.toContain("ATTENDEE");
    expect(put.body).not.toContain("ORGANIZER");
    expect(put.body).not.toContain("VALARM");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"action":"create_event"');
    expect(logs[0]).toContain('"principal":"tester"');
    expect(logs[0]).toContain('"outcome":"ok"');
    expect(logs[0]).not.toContain("Dentist");
  });

  it("converts a non-default timeZone to UTC", async () => {
    const calls = stubFetch();
    const result = await create(makeEnv(), {
      ...createInput(),
      timeZone: "America/New_York",
    });
    expect(result.start).toBe("2026-10-22T10:00:00-04:00");
    expect(putCall(calls).body).toContain("DTSTART:20261022T140000Z");
  });

  it("creates an all-day event with DATE values and a caller id", async () => {
    const calls = stubFetch();
    const result = await create(makeEnv(), {
      calendar: "Lavoro",
      id: "evt-abc",
      summary: "Holiday",
      start: "2026-10-22",
      end: "2026-10-23",
    });

    expect(result.resourceId).toBe("evt-abc");
    expect(result.uid).toBe("evt-abc");
    expect(result.start).toBe("2026-10-22");
    expect(result.end).toBe("2026-10-23");
    expect(result.timeZone).toBeNull();
    expect(result.allDay).toBe(true);

    const put = putCall(calls);
    expect(put.url).toContain("/cal-lavoro/evt-abc.ics");
    expect(put.body).toContain("DTSTART;VALUE=DATE:20261022");
    expect(put.body).toContain("DTEND;VALUE=DATE:20261023");
    expect(put.body).not.toContain("TZID");
  });

  it("folds long lines at 75 octets and keeps multi-byte text intact", async () => {
    const calls = stubFetch();
    const description = "x".repeat(300);
    await create(makeEnv(), {
      ...createInput(),
      summary: "Café ☕ review",
      description,
    });

    const body = putCall(calls).body;
    expect(body).toContain("\r\n ");
    for (const line of body.split("\r\n")) {
      expect(new TextEncoder().encode(line).byteLength).toBeLessThanOrEqual(75);
    }
    const unfolded = body.replace(/\r\n[ \t]/g, "");
    expect(unfolded).toContain(`DESCRIPTION:${description}`);
    expect(unfolded).toContain("SUMMARY:Café ☕ review");
  });

  it("rejects an event id that is not a single safe path segment", async () => {
    const calls = stubFetch();
    for (const id of ["../escape", "a/b", "..", ".", "with space", "x".repeat(129)]) {
      await expect(
        create(makeEnv(), createInput({ id })),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    }
    expect(calls).toHaveLength(0);
  });

  it("returns already_exists on a 412 and never logs the summary", async () => {
    stubFetch({ put: () => new Response("", { status: 412 }) });
    const logs = captureLogs();

    await expect(
      create(makeEnv(), createInput({ id: "duplicate", summary: "Secret title" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "already_exists");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"action":"create_event"');
    expect(logs[0]).toContain('"resource":"duplicate"');
    expect(logs[0]).toContain('"outcome":"already_exists"');
    expect(logs[0]).not.toContain("Secret title");
  });

  it("returns a null etag when iCloud omits it", async () => {
    stubFetch({ put: () => new Response("", { status: 201 }) });
    const result = await create(makeEnv(), createInput());
    expect(result.etag).toBeNull();
  });

  it("refuses a read-only collection without a PUT", async () => {
    const calls = stubFetch();
    const logs = captureLogs();
    await expect(
      create(makeEnv(), createInput({ calendar: "Casa SP" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "read_only_collection");
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(logs).toEqual([]);
  });

  it("refuses while writes are disabled, without touching the network", async () => {
    const calls = stubFetch();
    await expect(
      create(makeEnv({ CALENDAR_WRITE: "0" }), createInput()),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    expect(calls).toHaveLength(0);

    await expect(
      create(makeEnv({ ALLOWED_CALENDARS: "" }), createInput()),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    expect(calls).toHaveLength(0);
  });

  it("rejects contradictory forms and bad ranges before the network", async () => {
    const calls = stubFetch();
    const env = makeEnv();

    await expect(
      create(env, createInput({ allDay: true, start: "2026-10-22T10:00:00", end: "2026-10-22T11:00:00" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      create(env, createInput({ start: "2026-10-22", end: "2026-10-22T11:00:00" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      create(env, createInput({ allDay: false, start: "2026-10-22", end: "2026-10-23" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      create(env, createInput({ start: "2026-10-22T11:00:00", end: "2026-10-22T10:00:00" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_range");
    await expect(
      create(env, createInput({ start: "2026-10-22", end: "2026-10-22" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_range");
    await expect(
      create(env, createInput({ timeZone: "Not/AZone" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      create(env, createInput({ start: "2026-10-22", end: "2026-10-23", timeZone: "Europe/Rome" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      create(env, createInput({ start: "2026-02-30T10:00:00", end: "2026-02-30T11:00:00" })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");

    expect(calls).toHaveLength(0);
  });

  it("rejects an empty or overlong summary and oversized text", async () => {
    const calls = stubFetch();
    const env = makeEnv();

    await expect(
      create(env, createInput({ summary: "   " })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      create(env, createInput({ summary: "x".repeat(201) })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      create(env, createInput({ description: "x".repeat(8193) })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      create(env, createInput({ location: "x".repeat(8193) })),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");

    expect(calls).toHaveLength(0);
  });

  it("fails closed without a limiter and refuses a denied bucket", async () => {
    const calls = stubFetch();

    await expect(
      create(makeEnv({ CALENDAR_WRITE_LIMITER: undefined }), createInput()),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "configuration_error");
    expect(calls).toHaveLength(0);

    const denied = fakeLimiter(false);
    await expect(
      create(
        makeEnv({ CALENDAR_WRITE_LIMITER: denied }),
        createInput(),
        { rateLimitKey: "203.0.113.7" },
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "rate_limited");
    expect(calls).toHaveLength(0);
    expect(denied.keys).toEqual(["203.0.113.7"]);
  });

  it("passes the rate-limit key on a successful write", async () => {
    stubFetch();
    const limiter = fakeLimiter();
    await create(makeEnv({ CALENDAR_WRITE_LIMITER: limiter }), createInput(), {
      rateLimitKey: "203.0.113.8",
    });
    expect(limiter.keys).toEqual(["203.0.113.8"]);
  });

  it("reports mutation_state_unknown when the PUT connection drops", async () => {
    stubFetch({ putThrows: true });
    const logs = captureLogs();
    await expect(
      create(makeEnv(), createInput({ id: "maybe-created" })),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("mutation_state_unknown");
      expect((error as Error).message).toContain("maybe-created");
      expect((error as Error).message).toContain("get_event");
      return true;
    });
    expect(logs[0]).toContain('"outcome":"mutation_state_unknown"');
  });
});

describe("updateEvent", () => {
  it("changes only the summary and preserves alarms, VTIMEZONE and Apple properties", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "plain", ics: PLAIN, etag: '"etag-plain"' }]),
    });
    const logs = captureLogs();

    const result = await update(makeEnv(), {
      calendar: "Lavoro",
      id: "plain",
      etag: '"etag-plain"',
      summary: "Renamed",
    });

    expect(result.resourceId).toBe("plain");
    expect(result.uid).toBe("plain");
    expect(result.etag).toBe('"etag-new"');
    expect(result.summary).toBe("Renamed");
    expect(result.start).toBe("2026-10-22T10:00:00+02:00");
    expect(result.end).toBe("2026-10-22T11:00:00+02:00");
    expect(result.timeZone).toBe("Europe/Rome");
    expect(result.allDay).toBe(false);

    const put = putCall(calls);
    expect(put.headers["If-Match"]).toBe('"etag-plain"');
    expect(put.headers["If-None-Match"]).toBeUndefined();
    expect(put.body).toContain("UID:plain");
    expect(put.body).toContain("DTSTAMP:20260101T000000Z");
    expect(put.body).toContain("SUMMARY:Renamed");
    expect(put.body).toContain("DESCRIPTION:Keep this");
    expect(put.body).toContain("LOCATION:Office");
    expect(put.body).toContain("X-APPLE-STRUCTURED-LOCATION");
    expect(put.body).toContain("BEGIN:VALARM");
    expect(put.body).toContain("BEGIN:VTIMEZONE");
    expect(put.body).toContain("DTSTART;TZID=Europe/Rome:20261022T100000");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"action":"update_event"');
    expect(logs[0]).toContain('"outcome":"ok"');
    expect(logs[0]).not.toContain("Renamed");
  });

  it("replaces a DURATION with DTSTART/DTEND when times change", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "duration", ics: DURATION_EVENT, etag: '"etag-duration"' },
      ]),
    });

    const result = await update(makeEnv(), {
      calendar: "Lavoro",
      id: "duration",
      etag: '"etag-duration"',
      start: "2026-10-23T09:00:00",
      end: "2026-10-23T10:30:00",
    });

    expect(result.start).toBe("2026-10-23T09:00:00+02:00");
    expect(result.end).toBe("2026-10-23T10:30:00+02:00");
    const body = putCall(calls).body;
    expect(body).toContain("DTSTART:20261023T070000Z");
    expect(body).toContain("DTEND:20261023T083000Z");
    expect(body).not.toContain("DURATION");
  });

  it("keeps a DURATION when only the summary changes", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "duration", ics: DURATION_EVENT, etag: '"etag-duration"' },
      ]),
    });

    const result = await update(makeEnv(), {
      calendar: "Lavoro",
      id: "duration",
      etag: '"etag-duration"',
      summary: "Renamed hour",
    });

    expect(result.summary).toBe("Renamed hour");
    expect(result.end).toBe("2026-10-22T11:00:00+02:00");
    const body = putCall(calls).body;
    expect(body).toContain("SUMMARY:Renamed hour");
    expect(body).toContain("DURATION:PT1H");
    expect(body).not.toContain("DTEND");
  });

  it("changes an all-day event to a timed one and back by form", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "allday", ics: ALL_DAY, etag: '"etag-allday"' },
      ]),
    });

    const timed = await update(makeEnv(), {
      calendar: "Lavoro",
      id: "allday",
      etag: '"etag-allday"',
      start: "2026-10-23T09:00:00",
      end: "2026-10-23T10:00:00",
      timeZone: "Europe/Rome",
    });
    expect(timed.allDay).toBe(false);
    expect(timed.timeZone).toBe("Europe/Rome");
    const body = putCall(calls).body;
    expect(body).toContain("DTSTART:20261023T070000Z");
    expect(body).toContain("DTEND:20261023T080000Z");
    expect(body).not.toContain("DTSTART;VALUE=DATE");

    clearCalDavDiscoveryCache();
    const backCalls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-plain"' },
      ]),
    });
    const allDay = await update(makeEnv(), {
      calendar: "Lavoro",
      id: "plain",
      etag: '"etag-plain"',
      start: "2026-10-23",
      end: "2026-10-24",
    });
    expect(allDay.allDay).toBe(true);
    expect(allDay.timeZone).toBeNull();
    expect(allDay.start).toBe("2026-10-23");
    const backBody = putCall(backCalls).body;
    expect(backBody).toContain("DTSTART;VALUE=DATE:20261023");
    expect(backBody).toContain("DTEND;VALUE=DATE:20261024");
    expect(backBody).not.toContain("DURATION");
  });

  it("clears location and description with null and leaves the alarm alone", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "plain", ics: PLAIN, etag: '"etag-plain"' }]),
    });

    await update(makeEnv(), {
      calendar: "Lavoro",
      id: "plain",
      etag: '"etag-plain"',
      location: null,
      description: null,
    });

    const body = putCall(calls).body;
    expect(body).not.toContain("LOCATION:Office");
    expect(body).not.toContain("Keep this");
    expect(body).toContain("BEGIN:VALARM");
    expect(body).toContain("DESCRIPTION:Reminder");
  });

  it("preserves a floating event when only the summary changes", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "floating", ics: FLOATING, etag: '"etag-floating"' },
      ]),
    });
    const result = await update(makeEnv(), {
      calendar: "Lavoro",
      id: "floating",
      etag: '"etag-floating"',
      summary: "Still floating",
    });
    expect(result.start).toBeNull();
    expect(result.end).toBeNull();
    expect(result.timeZone).toBeNull();
    expect(putCall(calls).body).toContain("DTSTART:20261022T100000");
  });

  it("rejects a stale ETag before the PUT and logs the conflict", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-newer"' },
      ]),
    });
    const logs = captureLogs();

    await expect(
      update(makeEnv(), {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-old"',
        summary: "X",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("conflict");
      expect((error as Error).message).toContain("call get_event again");
      return true;
    });
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
    expect(logs[0]).toContain('"outcome":"conflict"');
  });

  it("rejects weak, wildcard, list and malformed ETags without the network", async () => {
    const calls = stubFetch();
    for (const etag of ['W/"etag"', "*", '"a", "b"', '"with space"', "etag", '"unterminated']) {
      await expect(
        update(makeEnv(), { calendar: "Lavoro", id: "plain", etag, summary: "X" }),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_etag");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses recurring and scheduling resources", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "recurring", ics: RECURRING, etag: '"etag-recurring"' },
      ]),
    });
    await expect(
      update(makeEnv(), {
        calendar: "Lavoro",
        id: "recurring",
        etag: '"etag-recurring"',
        summary: "X",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "recurring_not_supported");

    clearCalDavDiscoveryCache();
    stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "scheduled", ics: SCHEDULED, etag: '"etag-scheduled"' },
      ]),
    });
    await expect(
      update(makeEnv(), {
        calendar: "Lavoro",
        id: "scheduled",
        etag: '"etag-scheduled"',
        summary: "X",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "scheduling_not_supported");
  });

  it("turns a 412 from the PUT into conflict and logs it", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "plain", ics: PLAIN, etag: '"etag-plain"' }]),
      put: () => new Response("", { status: 412 }),
    });
    const logs = captureLogs();
    await expect(
      update(makeEnv(), {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-plain"',
        summary: "X",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "conflict");
    expect(calls.some((call) => call.method === "PUT")).toBe(true);
    expect(logs[0]).toContain('"outcome":"conflict"');
  });

  it("refuses a read-only collection and a missing event", async () => {
    const calls = stubFetch();
    await expect(
      update(makeEnv(), {
        calendar: "Casa SP",
        id: "plain",
        etag: '"etag-plain"',
        summary: "X",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "read_only_collection");
    expect(calls.some((call) => call.method === "REPORT" || call.method === "PUT")).toBe(false);

    clearCalDavDiscoveryCache();
    const missingCalls = stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "missing", ics: "", status: 404 }]),
    });
    await expect(
      update(makeEnv(), {
        calendar: "Lavoro",
        id: "missing",
        etag: '"etag-missing"',
        summary: "X",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_found");
    expect(missingCalls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("rejects an empty patch, partial times and malformed times without the network", async () => {
    const calls = stubFetch();
    const env = makeEnv();
    await expect(
      update(env, { calendar: "Lavoro", id: "plain", etag: '"etag-plain"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      update(env, {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-plain"',
        start: "2026-10-22T10:00:00",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      update(env, {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-plain"',
        timeZone: "Europe/Rome",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    await expect(
      update(env, {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-plain"',
        start: "2026-10-22T10:00:00Z",
        end: "2026-10-22T11:00:00Z",
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_request");
    expect(calls).toHaveLength(0);
  });

  it("reports mutation_state_unknown on a dropped update PUT", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "plain", ics: PLAIN, etag: '"etag-plain"' }]),
      putThrows: true,
    });
    const logs = captureLogs();
    await expect(
      update(makeEnv(), {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-plain"',
        summary: "X",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("mutation_state_unknown");
      expect((error as Error).message).toContain("plain");
      expect((error as Error).message).toContain("get_event");
      return true;
    });
    expect(logs[0]).toContain('"outcome":"mutation_state_unknown"');
  });
});

describe("deleteEvent", () => {
  it("deletes one event with If-Match and audits metadata only", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-plain"' },
      ]),
    });
    const logs = captureLogs();

    const result = (await remove(makeEnv(), {
      calendar: "Lavoro",
      id: "plain",
      etag: '"etag-plain"',
    })) as Awaited<ReturnType<typeof deleteEvent>>;

    expect(result).toMatchObject({
      ok: true,
      calendar: "Lavoro",
      collectionId: "cal-lavoro",
      resourceId: "plain",
      uid: "plain",
      summary: "Original",
    });

    const call = deleteCall(calls);
    expect(call.url).toBe(
      `https://p42-caldav.icloud.com/${DSID}/calendars/cal-lavoro/plain.ics`,
    );
    expect(call.headers["If-Match"]).toBe('"etag-plain"');
    expect(call.body).toBe("");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('"action":"delete_event"');
    expect(logs[0]).toContain('"principal":"tester"');
    expect(logs[0]).toContain('"outcome":"ok"');
    expect(logs[0]).not.toContain("Original");
    expect(logs[0]).not.toContain("Keep this");
  });

  it("rejects a stale ETag before the DELETE and logs the conflict", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-newer"' },
      ]),
    });
    const logs = captureLogs();

    await expect(
      remove(makeEnv(), { calendar: "Lavoro", id: "plain", etag: '"etag-old"' }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("conflict");
      expect((error as Error).message).toContain("call get_event again");
      return true;
    });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    expect(logs[0]).toContain('"outcome":"conflict"');
  });

  it("rejects weak, wildcard, list and malformed ETags without the network", async () => {
    const calls = stubFetch();
    for (const etag of ['W/"etag"', "*", '"a", "b"', '"with space"', "etag", '"unterminated']) {
      await expect(
        remove(makeEnv(), { calendar: "Lavoro", id: "plain", etag }),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "invalid_etag");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses recurring, scheduling and non-event resources", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "recurring", ics: RECURRING, etag: '"etag-recurring"' },
      ]),
    });
    await expect(
      remove(makeEnv(), {
        calendar: "Lavoro",
        id: "recurring",
        etag: '"etag-recurring"',
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "recurring_not_supported");

    clearCalDavDiscoveryCache();
    stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "scheduled", ics: SCHEDULED, etag: '"etag-scheduled"' },
      ]),
    });
    await expect(
      remove(makeEnv(), {
        calendar: "Lavoro",
        id: "scheduled",
        etag: '"etag-scheduled"',
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "scheduling_not_supported");

    clearCalDavDiscoveryCache();
    const todoCalls = stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "todo", ics: VTODO, etag: '"etag-todo"' }]),
    });
    await expect(
      remove(makeEnv(), { calendar: "Lavoro", id: "todo", etag: '"etag-todo"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_an_event");
    expect(todoCalls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses a read-only collection and a missing event", async () => {
    const calls = stubFetch();
    await expect(
      remove(makeEnv(), {
        calendar: "Casa SP",
        id: "plain",
        etag: '"etag-plain"',
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "read_only_collection");
    expect(calls.some((call) => call.method === "REPORT" || call.method === "DELETE")).toBe(false);

    clearCalDavDiscoveryCache();
    const missingCalls = stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "missing", ics: "", status: 404 }]),
    });
    await expect(
      remove(makeEnv(), {
        calendar: "Lavoro",
        id: "missing",
        etag: '"etag-missing"',
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_found");
    expect(missingCalls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses while writes are disabled, without touching the network", async () => {
    const calls = stubFetch();
    await expect(
      remove(makeEnv({ CALENDAR_WRITE: "0" }), {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-plain"',
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    await expect(
      remove(makeEnv({ ALLOWED_CALENDARS: "" }), {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-plain"',
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "not_supported");
    expect(calls).toHaveLength(0);
  });

  it("fails closed without a limiter and refuses a denied bucket", async () => {
    const calls = stubFetch();
    await expect(
      remove(makeEnv({ CALENDAR_WRITE_LIMITER: undefined }), {
        calendar: "Lavoro",
        id: "plain",
        etag: '"etag-plain"',
      }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "configuration_error");
    expect(calls).toHaveLength(0);

    const denied = fakeLimiter(false);
    await expect(
      remove(
        makeEnv({ CALENDAR_WRITE_LIMITER: denied }),
        { calendar: "Lavoro", id: "plain", etag: '"etag-plain"' },
        { rateLimitKey: "203.0.113.9" },
      ),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "rate_limited");
    expect(calls).toHaveLength(0);
    expect(denied.keys).toEqual(["203.0.113.9"]);
  });

  it("maps a DELETE precondition failure to conflict", async () => {
    const calls = stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-plain"' },
      ]),
      delete: () => new Response("", { status: 412 }),
    });
    const logs = captureLogs();
    await expect(
      remove(makeEnv(), { calendar: "Lavoro", id: "plain", etag: '"etag-plain"' }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "conflict");
    expect(calls.some((call) => call.method === "DELETE")).toBe(true);
    expect(logs[0]).toContain('"outcome":"conflict"');
  });

  it("reports mutation_state_unknown when the DELETE connection drops", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-plain"' },
      ]),
      deleteThrows: true,
    });
    const logs = captureLogs();
    await expect(
      remove(makeEnv(), { calendar: "Lavoro", id: "plain", etag: '"etag-plain"' }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("mutation_state_unknown");
      expect((error as Error).message).toContain("plain");
      expect((error as Error).message).toContain("get_event");
      return true;
    });
    expect(logs[0]).toContain('"outcome":"mutation_state_unknown"');
  });

  it("does not report a 202 DELETE as success", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-plain"' },
      ]),
      delete: () => new Response("", { status: 202 }),
    });
    const logs = captureLogs();
    await expect(
      remove(makeEnv(), { calendar: "Lavoro", id: "plain", etag: '"etag-plain"' }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(errorCode(error)).toBe("mutation_state_unknown");
      expect((error as Error).message).toContain("get_event");
      return true;
    });
    expect(logs[0]).toContain('"outcome":"mutation_state_unknown"');
  });
});

describe("REST event writes", () => {
  async function rest(
    method: string,
    path: string,
    body?: unknown,
    env = makeEnv(),
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: any }> {
    const request = new Request(`https://mail.example.com${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body:
        body === undefined
          ? undefined
          : typeof body === "string"
            ? body
            : JSON.stringify(body),
    });
    const response = await handleRest(request, env);
    return { status: response.status, body: await response.json() };
  }

  it("creates through POST, returns 201 and passes the IP to the limiter", async () => {
    const calls = stubFetch();
    const limiter = fakeLimiter();
    const env = makeEnv({ CALENDAR_WRITE_LIMITER: limiter });

    const response = await rest(
      "POST",
      "/v1/calendars/Lavoro/events",
      {
        id: "rest-create",
        summary: "Rest event",
        start: "2026-10-22T10:00:00",
        end: "2026-10-22T11:00:00",
      },
      env,
      { "CF-Connecting-IP": "198.51.100.9" },
    );

    expect(response.status).toBe(201);
    expect(response.body.resourceId).toBe("rest-create");
    expect(response.body.etag).toBe('"etag-new"');
    expect(putCall(calls).headers["If-None-Match"]).toBe("*");
    expect(limiter.keys).toEqual(["198.51.100.9"]);
  });

  it("updates through PUT and returns 200", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [{ id: "plain", ics: PLAIN, etag: '"etag-plain"' }]),
    });
    const response = await rest("PUT", "/v1/calendars/Lavoro/events/plain", {
      etag: '"etag-plain"',
      summary: "Rest rename",
    });
    expect(response.status).toBe(200);
    expect(response.body.summary).toBe("Rest rename");
    expect(response.body.start).toBe("2026-10-22T10:00:00+02:00");
  });

  it("answers not_supported for both routes while writes are disabled", async () => {
    const calls = stubFetch();
    const env = makeEnv({ CALENDAR_WRITE: "0" });
    const created = await rest(
      "POST",
      "/v1/calendars/Lavoro/events",
      { summary: "X", start: "2026-10-22T10:00:00", end: "2026-10-22T11:00:00" },
      env,
    );
    expect(created.status).toBe(404);
    expect(created.body.error.code).toBe("not_supported");

    const updated = await rest(
      "PUT",
      "/v1/calendars/Lavoro/events/plain",
      { etag: '"etag-plain"', summary: "X" },
      env,
    );
    expect(updated.status).toBe(404);
    expect(updated.body.error.code).toBe("not_supported");
    expect(calls).toHaveLength(0);
  });

  it("maps unknown fields to unsupported_field and bad bodies to invalid_request", async () => {
    const calls = stubFetch();
    const forbidden = await rest("POST", "/v1/calendars/Lavoro/events", {
      summary: "X",
      start: "2026-10-22T10:00:00",
      end: "2026-10-22T11:00:00",
      rrule: "FREQ=DAILY",
    });
    expect(forbidden.status).toBe(400);
    expect(forbidden.body.error.code).toBe("unsupported_field");
    expect(forbidden.body.error.message).toContain("rrule");

    const missing = await rest("POST", "/v1/calendars/Lavoro/events", {
      start: "2026-10-22T10:00:00",
      end: "2026-10-22T11:00:00",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_request");

    const malformed = await rest("POST", "/v1/calendars/Lavoro/events", "{bad");
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("invalid_json");
    expect(calls).toHaveLength(0);
  });

  it("maps already_exists and conflict to 409", async () => {
    stubFetch({ put: () => new Response("", { status: 412 }) });
    const duplicate = await rest("POST", "/v1/calendars/Lavoro/events", {
      id: "dup",
      summary: "X",
      start: "2026-10-22T10:00:00",
      end: "2026-10-22T11:00:00",
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("already_exists");

    clearCalDavDiscoveryCache();
    stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-newer"' },
      ]),
    });
    const stale = await rest("PUT", "/v1/calendars/Lavoro/events/plain", {
      etag: '"etag-old"',
      summary: "X",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("conflict");
  });

  it("deletes through DELETE with If-Match", async () => {
    stubFetch({
      multiget: multistatus("cal-lavoro", [
        { id: "plain", ics: PLAIN, etag: '"etag-plain"' },
      ]),
    });
    const response = await rest(
      "DELETE",
      "/v1/calendars/Lavoro/events/plain",
      undefined,
      makeEnv(),
      { "If-Match": '"etag-plain"' },
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      calendar: "Lavoro",
      resourceId: "plain",
      uid: "plain",
    });
  });

  it("requires If-Match and answers not_supported while writes are disabled", async () => {
    const calls = stubFetch();
    const missing = await rest("DELETE", "/v1/calendars/Lavoro/events/plain");
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_etag");

    const disabled = await rest(
      "DELETE",
      "/v1/calendars/Lavoro/events/plain",
      undefined,
      makeEnv({ CALENDAR_WRITE: "0" }),
      { "If-Match": '"etag-plain"' },
    );
    expect(disabled.status).toBe(404);
    expect(disabled.body.error.code).toBe("not_supported");
    expect(calls).toHaveLength(0);
  });
});
