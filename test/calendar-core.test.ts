import { beforeEach, describe, expect, it } from "vitest";
import { clearCalDavDiscoveryCache } from "../src/caldav";
import { discoverCalendars, listCalendars, resolveCalendar } from "../src/calendar-core";
import { ApiError } from "../src/core";
import type { Env } from "../src/types";

const DSID = "123456789";
const HOME = `https://p42-caldav.icloud.com/${DSID}/calendars/`;

const ROOT = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop><D:current-user-principal><D:href>/${DSID}/principal/</D:href></D:current-user-principal></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

const PRINCIPAL = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/${DSID}/principal/</D:href>
    <D:propstat>
      <D:prop><C:calendar-home-set><D:href>${HOME}</D:href></C:calendar-home-set></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

function collection(
  href: string,
  name: string | null,
  components: string[],
  privileges: string[] | null,
  color?: string,
): string {
  const display = name === null ? "" : `<D:displayname>${name}</D:displayname>`;
  const comps = components.map((component) => `<C:comp name="${component}"/>`).join("");
  const privilegeSet =
    privileges === null
      ? ""
      : `<D:current-user-privilege-set>${privileges
          .map((privilege) => `<D:privilege><D:${privilege}/></D:privilege>`)
          .join("")}</D:current-user-privilege-set>`;
  return `<D:response>
  <D:href>${href}</D:href>
  <D:propstat>
    <D:prop>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      ${display}
      <C:supported-calendar-component-set>${comps}</C:supported-calendar-component-set>
      ${privilegeSet}
      ${color === undefined ? "" : `<A:calendar-color>${color}</A:calendar-color>`}
    </D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`;
}

function collectionsXml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">
${body}
</D:multistatus>`;
}

const HOME_ENTRY = `<D:response>
  <D:href>/${DSID}/calendars/</D:href>
  <D:propstat>
    <D:prop><D:resourcetype><D:collection/></D:resourcetype><D:displayname>Diego Giorgini</D:displayname></D:prop>
    <D:status>HTTP/1.1 200 OK</D:status>
  </D:propstat>
</D:response>`;

const COLLECTIONS = collectionsXml(
  [
    HOME_ENTRY,
    collection(`/${DSID}/calendars/cal-lavoro/`, "Lavoro", ["VEVENT"], ["read", "write"], "#91DAC2FF"),
    collection(`/${DSID}/calendars/cal-personale/`, "Personale", ["VEVENT"], ["read"]),
    collection(`/${DSID}/calendars/list-casa/`, "Casa SP⚠️", ["VTODO"], ["read", "write"]),
    collection(`/${DSID}/calendars/list-reminders/`, "Reminders", ["VTODO"], ["write"]),
    collection(`/${DSID}/calendars/inbox/`, null, ["VEVENT"], ["read"]),
    collection(`/${DSID}/calendars/outbox/`, null, ["VEVENT", "VTODO"], ["read"]),
    collection(`/${DSID}/calendars/doppio/`, "Doppio", ["VEVENT", "VTODO"], ["read", "write"]),
    collection(`/${DSID}/calendars/group/nested/`, "Nested", ["VEVENT"], ["read", "write"]),
  ].join("\n"),
);

const AMBIGUOUS = collectionsXml(
  [
    collection(`/${DSID}/calendars/cal-lavoro/`, "Lavoro", ["VEVENT"], ["read", "write"]),
    collection(`/${DSID}/calendars/cal-lavoro-2/`, "Lavoro", ["VEVENT"], ["read", "write"]),
  ].join("\n"),
);

type Step = Response | (() => Response | Promise<Response>);

function scripted(steps: Step[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = steps.shift();
    if (step === undefined) throw new Error(`unexpected request: ${String(input)}`);
    return typeof step === "function" ? step() : step;
  }) as typeof fetch;
  return { impl, calls };
}

function script(collections = COLLECTIONS) {
  return scripted([
    new Response(ROOT, { status: 207 }),
    new Response(PRINCIPAL, { status: 207 }),
    new Response(collections, { status: 207 }),
  ]);
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { API_TOKEN: "token", ICLOUD_USER: "owner@example.com", ICLOUD_APP_PASSWORD: "app-pass", ...overrides } as unknown as Env;
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return (error as ApiError).code;
  }
  throw new Error("expected an ApiError");
}

beforeEach(() => {
  clearCalDavDiscoveryCache();
});

describe("discoverCalendars", () => {
  it("keeps only named VEVENT collections", async () => {
    const { impl } = script();
    const calendars = await discoverCalendars(makeEnv(), { fetchImpl: impl });

    expect(calendars.map((entry) => [entry.name, entry.kind])).toEqual([
      ["Lavoro", "calendar"],
      ["Personale", "calendar"],
    ]);
  });

  it("reports the id, colour and writability of each calendar", async () => {
    const { impl } = script();
    const calendars = await discoverCalendars(makeEnv(), { fetchImpl: impl });
    const byName = new Map(calendars.map((entry) => [entry.name, entry]));

    expect(byName.get("Lavoro")).toMatchObject({
      id: "cal-lavoro",
      kind: "calendar",
      color: "#91DAC2FF",
      readOnly: false,
    });
    expect(byName.get("Personale")).toMatchObject({ color: null, readOnly: true });
  });

  it("refuses a malformed collection document", async () => {
    const { impl } = script("<D:not-a-multistatus/>");
    await expect(discoverCalendars(makeEnv(), { fetchImpl: impl })).rejects.toBeInstanceOf(Error);
  });
});

describe("listCalendars", () => {
  it("returns nothing for a disabled domain without any request", async () => {
    const { impl, calls } = script();
    expect(await listCalendars(makeEnv(), { fetchImpl: impl })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("returns every calendar for *", async () => {
    const { impl } = script();
    const calendars = await listCalendars(makeEnv({ ALLOWED_CALENDARS: "*" }), { fetchImpl: impl });
    expect(calendars.map((entry) => entry.name)).toEqual(["Lavoro", "Personale"]);
  });

  it("filters by allowlisted names and sorts by name", async () => {
    const { impl } = script();
    const calendars = await listCalendars(makeEnv({ ALLOWED_CALENDARS: "Personale,Lavoro" }), {
      fetchImpl: impl,
    });
    expect(calendars.map((entry) => entry.name)).toEqual(["Lavoro", "Personale"]);
  });

  it("fails closed when a calendar allowlist names a reminder list", async () => {
    const { impl } = script();
    expect(
      await codeOf(listCalendars(makeEnv({ ALLOWED_CALENDARS: "Casa SP⚠️" }), { fetchImpl: impl })),
    ).toBe("configured_calendar_missing");
  });

  it("fails closed when an allowlisted name does not exist", async () => {
    const { impl } = script();
    expect(
      await codeOf(listCalendars(makeEnv({ ALLOWED_CALENDARS: "Lavoro,Vecchio" }), { fetchImpl: impl })),
    ).toBe("configured_calendar_missing");
  });

  it("lists every calendar with all=1 even when the domain is disabled", async () => {
    const { impl } = script();
    const calendars = await listCalendars(makeEnv(), { all: true, fetchImpl: impl });
    expect(calendars.map((entry) => entry.name)).toEqual(["Lavoro", "Personale"]);
  });
});

describe("resolveCalendar", () => {
  it("resolves a name when everything is allowed", async () => {
    const { impl } = script();
    const calendar = await resolveCalendar(makeEnv({ ALLOWED_CALENDARS: "*" }), "Lavoro", {
      fetchImpl: impl,
    });
    expect(calendar).toMatchObject({ id: "cal-lavoro", name: "Lavoro", kind: "calendar" });
  });

  it("refuses a name outside the allowlist before discovery", async () => {
    const { impl, calls } = script();
    expect(
      await codeOf(resolveCalendar(makeEnv({ ALLOWED_CALENDARS: "Lavoro" }), "Personale", { fetchImpl: impl })),
    ).toBe("calendar_not_allowed");
    expect(calls).toHaveLength(0);
  });

  it("reports a configured name that disappeared", async () => {
    const { impl } = script();
    expect(
      await codeOf(
        resolveCalendar(makeEnv({ ALLOWED_CALENDARS: "Lavoro,Vecchio" }), "Lavoro", { fetchImpl: impl }),
      ),
    ).toBe("configured_calendar_missing");
  });

  it("reports an unknown name under * as a missing calendar", async () => {
    const { impl } = script();
    expect(
      await codeOf(resolveCalendar(makeEnv({ ALLOWED_CALENDARS: "*" }), "Nope", { fetchImpl: impl })),
    ).toBe("configured_calendar_missing");
  });

  it("refuses an ambiguous name", async () => {
    const { impl } = script(AMBIGUOUS);
    expect(
      await codeOf(resolveCalendar(makeEnv({ ALLOWED_CALENDARS: "*" }), "Lavoro", { fetchImpl: impl })),
    ).toBe("ambiguous_calendar_name");
  });

  it("does not resolve a reminder list as a calendar", async () => {
    const { impl } = script();
    expect(
      await codeOf(resolveCalendar(makeEnv({ ALLOWED_CALENDARS: "*" }), "Casa SP⚠️", { fetchImpl: impl })),
    ).toBe("configured_calendar_missing");
  });
});
