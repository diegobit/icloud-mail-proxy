import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearCalDavDiscoveryCache } from "../src/caldav";
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
  <D:response><D:href>/${DSID}/calendars/cal-personale/</D:href><D:propstat><D:prop>
    <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
    <D:displayname>Personale</D:displayname>
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
    ...overrides,
  } as unknown as Env;
}

function stubFetch(steps: Array<Response | (() => Response)>): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      calls.push(String(input));
      const step = steps.shift();
      if (step === undefined) throw new Error(`unexpected request: ${String(input)}`);
      return typeof step === "function" ? step() : step;
    }),
  );
  return calls;
}

function discoveryThen(collections: Response): Response[] {
  return [new Response(ROOT, { status: 207 }), new Response(PRINCIPAL, { status: 207 }), collections];
}

async function get(path: string, env: Env): Promise<{ status: number; body: any }> {
  const response = await handleRest(new Request(`https://mail.example.com${path}`), env);
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  clearCalDavDiscoveryCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /v1/calendars", () => {
  it("answers not_supported when calendars are disabled, without touching the network", async () => {
    const calls = stubFetch([]);
    const { status, body } = await get("/v1/calendars", makeEnv());
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_supported");
    expect(calls).toHaveLength(0);
  });

  it("answers not_supported for disabled reminder lists", async () => {
    const { status, body } = await get("/v1/reminder-lists", makeEnv({ ALLOWED_CALENDARS: "*" }));
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_supported");
  });

  it("lists only allowlisted calendars when enabled", async () => {
    stubFetch(discoveryThen(new Response(COLLECTIONS, { status: 207 })));
    const { status, body } = await get("/v1/calendars", makeEnv({ ALLOWED_CALENDARS: "Lavoro" }));
    expect(status).toBe(200);
    expect(body.calendars.map((entry: { name: string }) => entry.name)).toEqual(["Lavoro"]);
  });

  it("lists every calendar with all=1 even when disabled", async () => {
    stubFetch(discoveryThen(new Response(COLLECTIONS, { status: 207 })));
    const { status, body } = await get("/v1/calendars?all=1", makeEnv());
    expect(status).toBe(200);
    expect(body.calendars.map((entry: { name: string }) => entry.name)).toEqual([
      "Lavoro",
      "Personale",
    ]);
  });

  it("returns reminder lists under their own key", async () => {
    stubFetch(discoveryThen(new Response(COLLECTIONS, { status: 207 })));
    const { status, body } = await get(
      "/v1/reminder-lists",
      makeEnv({ ALLOWED_CALENDARS: "", ALLOWED_REMINDER_LISTS: "*" }),
    );
    expect(status).toBe(200);
    expect(body.reminderLists.map((entry: { name: string }) => entry.name)).toEqual(["Reminders"]);
  });

  it("maps a rejected credential to upstream_unauthorized", async () => {
    stubFetch([new Response("no", { status: 401 })]);
    const { status, body } = await get("/v1/calendars?all=1", makeEnv());
    expect(status).toBe(502);
    expect(body.error.code).toBe("upstream_unauthorized");
  });
});
