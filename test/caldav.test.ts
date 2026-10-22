import { beforeEach, describe, expect, it } from "vitest";
import {
  CalDavError,
  calendarMultiget,
  calendarQuery,
  clearCalDavDiscoveryCache,
  collectionPath,
  componentNames,
  createCalDav,
  deleteResource,
  displayName,
  parseMultistatus,
  propHref,
  propText,
  propValue,
  propfind,
  putResource,
  resourcetypeKinds,
  resourcePath,
  type CalDavOptions,
} from "../src/caldav";
import type { Env } from "../src/types";

const env = {
  ICLOUD_USER: "owner@example.com",
  ICLOUD_APP_PASSWORD: "app-pass",
} as unknown as Env;

const AUTH = `Basic ${btoa("owner@example.com:app-pass")}`;
const DSID = "123456789";
const HOME = `https://p42-caldav.icloud.com/${DSID}/calendars/`;
const COLLECTION_ID = "3ED435B2-0000-0000-0000-000000000001";
const UID = "A1B2C3D4-0000-0000-0000-000000000002";
const NS =
  'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"';

function rootXml(principalHref: string, status = "HTTP/1.1 200 OK"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop><D:current-user-principal><D:href>${principalHref}</D:href></D:current-user-principal></D:prop>
      <D:status>${status}</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
}

function principalXml(homeHref: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/${DSID}/principal/</D:href>
    <D:propstat>
      <D:prop><C:calendar-home-set><D:href>${homeHref}</D:href></C:calendar-home-set></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;
}

const ROOT_OK = rootXml(`/${DSID}/principal/`);
const PRINCIPAL_OK = principalXml(HOME);

const COLLECTIONS = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus ${NS}>
  <D:response>
    <D:href>/${DSID}/calendars/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:displayname>Diego Giorgini</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/${DSID}/calendars/${COLLECTION_ID}/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Lavoro</D:displayname>
        <CS:getctag>ctag-1</CS:getctag>
        <C:supported-calendar-component-set><C:comp name='VEVENT'/></C:supported-calendar-component-set>
        <A:calendar-color>#91DAC2FF</A:calendar-color>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><C:max-resource-size>262144</C:max-resource-size></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/${DSID}/calendars/3ED435B2-0000-0000-0000-000000000003/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
        <D:displayname>Casa SP⚠️</D:displayname>
        <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/${DSID}/calendars/inbox/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>`;

const MULTIGET = `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/${DSID}/calendars/${COLLECTION_ID}/${UID}.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"mq7p46um"</D:getetag>
        <C:calendar-data>BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:${UID}
SUMMARY:Meet &amp; greet
END:VEVENT
END:VCALENDAR
</C:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/${DSID}/calendars/${COLLECTION_ID}/MISSING.ics</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>
</D:multistatus>`;

const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:x\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

type Step = Response | (() => Response | Promise<Response>);

function xml(body: string, status = 207, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "application/xml; charset=utf-8", ...headers },
  });
}

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

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CalDavError);
    return (error as CalDavError).code;
  }
  throw new Error("expected a CalDavError");
}

/** A CalDav instance whose discovery already happened; `steps` serve the next calls. */
async function ready(steps: Step[], options: CalDavOptions = {}) {
  const script = scripted([xml(ROOT_OK), xml(PRINCIPAL_OK), ...steps]);
  const caldav = createCalDav(env, { fetchImpl: script.impl, ...options });
  await caldav.discover();
  expect(script.calls).toHaveLength(2);
  return { caldav, calls: script.calls };
}

beforeEach(() => {
  clearCalDavDiscoveryCache();
});

describe("request builders", () => {
  it("builds a byte-exact propfind", () => {
    expect(propfind(["D:resourcetype", "D:displayname", "C:supported-calendar-component-set"])).toBe(
      `<D:propfind ${NS}><D:prop><D:resourcetype/><D:displayname/>` +
        "<C:supported-calendar-component-set/></D:prop></D:propfind>",
    );
  });

  it("refuses an empty or injected propfind property", () => {
    expect(() => propfind([])).toThrow(CalDavError);
    expect(() => propfind(["D:displayname/><D:allprop"])).toThrow(CalDavError);
    expect(() => propfind(["displayname"])).toThrow(CalDavError);
  });

  it("builds a calendar-query with and without a time range", () => {
    const range = { start: "20261020T000000Z", end: "20261027T000000Z" };
    expect(calendarQuery({ component: "VEVENT", timeRange: range })).toBe(
      `<C:calendar-query ${NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>` +
        '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
        '<C:time-range start="20261020T000000Z" end="20261027T000000Z"/>' +
        "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>",
    );
    expect(calendarQuery({ component: "VEVENT" })).toBe(
      `<C:calendar-query ${NS}><D:prop><D:getetag/><C:calendar-data/></D:prop>` +
        '<C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT">' +
        "</C:comp-filter></C:comp-filter></C:filter></C:calendar-query>",
    );
  });

  it("refuses a non-UTC or inverted time range", () => {
    expect(() =>
      calendarQuery({ component: "VEVENT", timeRange: { start: "2026-10-20", end: "2026-10-27" } }),
    ).toThrow(CalDavError);
    expect(() =>
      calendarQuery({
        component: "VEVENT",
        timeRange: { start: "20261027T000000Z", end: "20261020T000000Z" },
      }),
    ).toThrow(CalDavError);
  });

  it("builds a multiget and escapes hrefs", () => {
    const body = calendarMultiget(["/a/b.ics", "/a/c&d.ics"]);
    expect(body).toContain("<D:href>/a/b.ics</D:href>");
    expect(body).toContain("<D:href>/a/c&amp;d.ics</D:href>");
    expect(() => calendarMultiget([])).toThrow(CalDavError);
  });

  it("builds PUT requests with the create and update preconditions", () => {
    const create = putResource("/a/x.ics", ICS, null);
    expect(create.init.method).toBe("PUT");
    expect(new Headers(create.init.headers).get("if-none-match")).toBe("*");
    expect(new Headers(create.init.headers).get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(create.init.body).toBe(ICS);

    const update = putResource("/a/x.ics", ICS, '"mq7p46um"');
    expect(new Headers(update.init.headers).get("if-match")).toBe('"mq7p46um"');
    expect(new Headers(update.init.headers).get("if-none-match")).toBeNull();

    expect(() => putResource("/a/x.ics", ICS, "unquoted")).toThrow(CalDavError);
    expect(() => putResource("/a/x.ics", ICS, '"a\r\nb"')).toThrow(CalDavError);
  });

  it("builds a conditional DELETE with a strong ETag", () => {
    const remove = deleteResource("/a/x.ics", '"mq7p46um"');
    expect(remove.init.method).toBe("DELETE");
    expect(new Headers(remove.init.headers).get("if-match")).toBe('"mq7p46um"');
    expect(remove.init.body).toBeUndefined();

    expect(() => deleteResource("/a/x.ics", 'W/"mq7p46um"')).toThrow(CalDavError);
    expect(() => deleteResource("/a/x.ics", "unquoted")).toThrow(CalDavError);
  });

  it("encodes collection and resource ids and refuses unsafe ones", () => {
    expect(collectionPath(COLLECTION_ID)).toBe(`${COLLECTION_ID}/`);
    expect(resourcePath(COLLECTION_ID, UID)).toBe(`${COLLECTION_ID}/${UID}.ics`);
    for (const bad of [".", "..", "a/b", "a%2fb", "a b", "x".repeat(129), ""]) {
      expect(() => resourcePath(COLLECTION_ID, bad)).toThrow(CalDavError);
    }
  });
});

describe("multistatus parsing", () => {
  it("normalises a single response and a list", () => {
    expect(parseMultistatus(rootXml(`/${DSID}/principal/`))).toHaveLength(1);
    expect(parseMultistatus(COLLECTIONS)).toHaveLength(4);
  });

  it("accepts a valid multistatus with zero responses", () => {
    expect(
      parseMultistatus(
        `<?xml version="1.0" encoding="UTF-8"?><D:multistatus xmlns:D="DAV:"></D:multistatus>`,
      ),
    ).toEqual([]);
  });

  it("reads a property href and trims it", () => {
    const [response] = parseMultistatus(rootXml(`  /${DSID}/principal/  `));
    expect(propHref(response, "current-user-principal")).toBe(`/${DSID}/principal/`);
  });

  it("exposes only 2xx properties and ignores a 404 propstat", () => {
    const lavoro = parseMultistatus(COLLECTIONS)[1];
    expect(displayName(lavoro)).toBe("Lavoro");
    expect(propText(lavoro, "getctag")).toBe("ctag-1");
    expect(propText(lavoro, "max-resource-size")).toBeNull();
    expect(propValue(lavoro, "max-resource-size")).toBeUndefined();
  });

  it("reads single-quoted component names", () => {
    const responses = parseMultistatus(COLLECTIONS);
    expect(componentNames(responses[1])).toEqual(["VEVENT"]);
    expect(componentNames(responses[2])).toEqual(["VTODO"]);
  });

  it("separates resourcetype kinds from attributes", () => {
    const responses = parseMultistatus(COLLECTIONS);
    expect(resourcetypeKinds(responses[0])).toEqual(["collection"]);
    expect(resourcetypeKinds(responses[1])).toEqual(["collection", "calendar"]);
    expect(resourcetypeKinds(responses[3])).toEqual(["collection"]);
  });

  it("keeps calendar-data and decodes XML entities", () => {
    const [event] = parseMultistatus(MULTIGET);
    const data = propText(event, "calendar-data");
    expect(data).toContain("BEGIN:VEVENT");
    expect(data).toContain("SUMMARY:Meet & greet");
    expect(propText(event, "getetag")).toBe('"mq7p46um"');
  });

  it("reads a response-level status with no propstat", () => {
    const [, missing] = parseMultistatus(MULTIGET);
    expect(missing.status).toBe(404);
    expect(missing.propstats).toEqual([]);
    expect(propText(missing, "getetag")).toBeNull();
  });

  it("fails closed on a propstat without a status", () => {
    const response = {
      href: "/x",
      status: null,
      propstats: [{ status: null, props: { displayname: "x" } }],
    };
    expect(propText(response, "displayname")).toBeNull();
  });

  it("refuses a non-multistatus document", () => {
    expect(() => parseMultistatus("<D:foo xmlns:D='DAV:'/>")).toThrow(CalDavError);
    expect(() => parseMultistatus("")).toThrow(CalDavError);
  });

  it("refuses DOCTYPE and ENTITY declarations before parsing", () => {
    expect(() => parseMultistatus('<!DOCTYPE x [<!ENTITY y "z">]><D:multistatus/>')).toThrow(CalDavError);
    expect(() => parseMultistatus("<!ENTITY y 'z'>")).toThrow(CalDavError);
  });
});

describe("discovery", () => {
  it("requests the bootstrap root and the exact principal path", async () => {
    const { impl, calls } = scripted([xml(ROOT_OK), xml(PRINCIPAL_OK)]);
    const caldav = createCalDav(env, { fetchImpl: impl });

    await expect(caldav.discover()).resolves.toEqual({
      principalUrl: `https://caldav.icloud.com/${DSID}/principal/`,
      homeUrl: HOME,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("https://caldav.icloud.com/");
    expect(calls[0].init.method).toBe("PROPFIND");
    expect(calls[0].init.redirect).toBe("manual");
    const first = new Headers(calls[0].init.headers);
    expect(first.get("authorization")).toBe(AUTH);
    expect(first.get("depth")).toBe("0");
    expect(first.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(calls[0].init.body).toBe(propfind(["D:current-user-principal"]));

    expect(calls[1].url).toBe(`https://caldav.icloud.com/${DSID}/principal/`);
    expect(calls[1].init.body).toBe(propfind(["C:calendar-home-set"]));
  });

  it("memoises discovery per user", async () => {
    const { impl, calls } = scripted([xml(ROOT_OK), xml(PRINCIPAL_OK)]);
    const caldav = createCalDav(env, { fetchImpl: impl });
    await caldav.discover();
    await caldav.discover();
    expect(calls).toHaveLength(2);
  });

  it("re-discovers when the memo TTL is zero", async () => {
    const { impl, calls } = scripted([xml(ROOT_OK), xml(PRINCIPAL_OK), xml(ROOT_OK), xml(PRINCIPAL_OK)]);
    const caldav = createCalDav(env, { fetchImpl: impl, discoveryTtlMs: 0 });
    await caldav.discover();
    await caldav.discover();
    expect(calls).toHaveLength(4);
  });

  it("accepts an absolute principal URL and a principal path without a trailing slash", async () => {
    const { impl } = scripted([
      xml(rootXml(`https://caldav.icloud.com/${DSID}/principal`)),
      xml(PRINCIPAL_OK),
    ]);
    const caldav = createCalDav(env, { fetchImpl: impl });
    await expect(caldav.discover()).resolves.toMatchObject({
      principalUrl: `https://caldav.icloud.com/${DSID}/principal/`,
    });
  });

  it("refuses a principal on another host without sending credentials there", async () => {
    const { impl, calls } = scripted([xml(rootXml(`https://evil.example/${DSID}/principal/`))]);
    const caldav = createCalDav(env, { fetchImpl: impl });
    expect(await codeOf(caldav.discover())).toBe("malformed");
    expect(calls).toHaveLength(1);
  });

  it("refuses a principal path deeper than the dsid directory", async () => {
    const { impl } = scripted([xml(rootXml(`/${DSID}/principal/extra/`))]);
    const caldav = createCalDav(env, { fetchImpl: impl });
    expect(await codeOf(caldav.discover())).toBe("malformed");
  });

  it.each([
    ["another host", `https://evil.example/${DSID}/calendars/`],
    ["the bootstrap host", `https://caldav.icloud.com/${DSID}/calendars/`],
    ["another account", `https://p42-caldav.icloud.com/999999999/calendars/`],
    ["a nested path", `https://p42-caldav.icloud.com/${DSID}/calendars/extra/`],
    ["plain http", `http://p42-caldav.icloud.com/${DSID}/calendars/`],
    ["a non-443 port", `https://p42-caldav.icloud.com:8443/${DSID}/calendars/`],
    ["userinfo", `https://user:pass@p42-caldav.icloud.com/${DSID}/calendars/`],
    ["an encoded separator", `https://p42-caldav.icloud.com/${DSID}/calendars/%2e%2e/`],
    ["a query", `https://p42-caldav.icloud.com/${DSID}/calendars/?x=1`],
  ])("refuses a home on %s", async (_label, homeHref) => {
    const { impl, calls } = scripted([xml(ROOT_OK), xml(principalXml(homeHref))]);
    const caldav = createCalDav(env, { fetchImpl: impl });
    expect(await codeOf(caldav.discover())).toBe("malformed");
    // The refused home is never requested.
    expect(calls).toHaveLength(2);
  });

  it("reports a malformed principal document", async () => {
    const { impl } = scripted([xml("<D:multistatus xmlns:D='DAV:'><D:response/></D:multistatus>")]);
    const caldav = createCalDav(env, { fetchImpl: impl });
    expect(await codeOf(caldav.discover())).toBe("malformed");
  });

  it("maps a rejected bootstrap credential to unauthorized", async () => {
    const { impl } = scripted([xml("nope", 401)]);
    const caldav = createCalDav(env, { fetchImpl: impl });
    expect(await codeOf(caldav.discover())).toBe("unauthorized");
  });
});

describe("pinned requests", () => {
  it("PROPFINDs a collection on the shard with the credential", async () => {
    const { caldav, calls } = await ready([xml(COLLECTIONS)]);
    const response = await caldav.propfind(
      collectionPath(COLLECTION_ID),
      propfind(["D:resourcetype", "D:displayname"]),
      1,
    );

    expect(response.status).toBe(207);
    expect(calls).toHaveLength(3);
    expect(calls[2].url).toBe(`${HOME}${COLLECTION_ID}/`);
    const headers = new Headers(calls[2].init.headers);
    expect(headers.get("authorization")).toBe(AUTH);
    expect(headers.get("depth")).toBe("1");
    expect(parseMultistatus(response.body)[1].href).toBe(`/${DSID}/calendars/${COLLECTION_ID}/`);
  });

  it("accepts an absolute href on the pinned origin", async () => {
    const { caldav, calls } = await ready([xml(COLLECTIONS)]);
    await caldav.propfind(`${HOME}${COLLECTION_ID}/`, propfind(["D:displayname"]), 0);
    expect(calls[2].url).toBe(`${HOME}${COLLECTION_ID}/`);
  });

  it("refuses another origin without a request", async () => {
    const { caldav, calls } = await ready([]);
    expect(await codeOf(caldav.propfind("https://evil.example/x/", propfind(["D:displayname"])))).toBe(
      "invalid_argument",
    );
    expect(calls).toHaveLength(2);
  });

  it("refuses a path outside the home", async () => {
    const { caldav, calls } = await ready([]);
    expect(await codeOf(caldav.propfind(`/${DSID}/contacts/`, propfind(["D:displayname"])))).toBe(
      "invalid_argument",
    );
    expect(calls).toHaveLength(2);
  });

  it("refuses a relative path that escapes the home", async () => {
    const { caldav, calls } = await ready([]);
    expect(await codeOf(caldav.propfind("../../contacts/", propfind(["D:displayname"])))).toBe(
      "invalid_argument",
    );
    expect(calls).toHaveLength(2);
  });

  it("refuses an encoded separator", async () => {
    const { caldav } = await ready([]);
    expect(await codeOf(caldav.propfind(`${HOME}x%2fy/`, propfind(["D:displayname"])))).toBe("malformed");
  });

  it("re-discovers once when the shard redirects", async () => {
    const { caldav, calls } = await ready([
      xml("", 301, { Location: HOME }),
      xml(ROOT_OK),
      xml(PRINCIPAL_OK),
      xml(COLLECTIONS),
    ]);
    const response = await caldav.propfind(collectionPath(COLLECTION_ID), propfind(["D:displayname"]), 1);
    expect(response.status).toBe(207);
    expect(calls.map((call) => call.url)).toEqual([
      "https://caldav.icloud.com/",
      `https://caldav.icloud.com/${DSID}/principal/`,
      `${HOME}${COLLECTION_ID}/`,
      "https://caldav.icloud.com/",
      `https://caldav.icloud.com/${DSID}/principal/`,
      `${HOME}${COLLECTION_ID}/`,
    ]);
  });

  it("gives up after a second redirect", async () => {
    const { caldav, calls } = await ready([
      xml("", 302),
      xml(ROOT_OK),
      xml(PRINCIPAL_OK),
      xml("", 307),
    ]);
    expect(await codeOf(caldav.propfind(collectionPath(COLLECTION_ID), propfind(["D:displayname"])))).toBe(
      "upstream_error",
    );
    expect(calls).toHaveLength(6);
  });

  it("GETs a resource as text/calendar and returns its ETag", async () => {
    const { caldav, calls } = await ready([
      new Response(ICS, { status: 200, headers: { ETag: '"mq7p46um"', "Content-Type": "text/calendar" } }),
    ]);
    const response = await caldav.get(resourcePath(COLLECTION_ID, UID));
    expect(response.status).toBe(200);
    expect(response.etag).toBe('"mq7p46um"');
    expect(response.body).toContain("BEGIN:VEVENT");
    expect(new Headers(calls[2].init.headers).get("accept")).toBe("text/calendar");
  });
});

describe("writes", () => {
  it("creates with If-None-Match: * and returns the ETag", async () => {
    const { caldav, calls } = await ready([xml("", 201, { ETag: '"new"' })]);
    const response = await caldav.put(resourcePath(COLLECTION_ID, UID), ICS, null);
    expect(response).toMatchObject({ status: 201, etag: '"new"', body: "" });
    const headers = new Headers(calls[2].init.headers);
    expect(headers.get("if-none-match")).toBe("*");
    expect(headers.get("if-match")).toBeNull();
    expect(headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(calls[2].init.body).toBe(ICS);
  });

  it("updates with If-Match", async () => {
    const { caldav, calls } = await ready([new Response(null, { status: 204 })]);
    const response = await caldav.put(resourcePath(COLLECTION_ID, UID), ICS, '"old"');
    expect(response.status).toBe(204);
    expect(new Headers(calls[2].init.headers).get("if-match")).toBe('"old"');
  });

  it("maps a stale ETag to conflict", async () => {
    const { caldav } = await ready([xml("", 412)]);
    expect(await codeOf(caldav.put(resourcePath(COLLECTION_ID, UID), ICS, '"old"'))).toBe("conflict");
  });

  it("refuses an invalid ETag before any request", async () => {
    const { caldav, calls } = await ready([]);
    expect(await codeOf(caldav.put(resourcePath(COLLECTION_ID, UID), ICS, "abc"))).toBe("invalid_argument");
    expect(calls).toHaveLength(2);
  });

  it("deletes with If-Match", async () => {
    const { caldav, calls } = await ready([new Response(null, { status: 204 })]);
    const response = await caldav.delete(resourcePath(COLLECTION_ID, UID), '"old"');
    expect(response.status).toBe(204);
    expect(calls[2].init.method).toBe("DELETE");
    expect(new Headers(calls[2].init.headers).get("if-match")).toBe('"old"');
    expect(calls[2].init.body).toBeUndefined();
  });

  it("maps a stale DELETE to conflict", async () => {
    const { caldav } = await ready([xml("", 412)]);
    expect(await codeOf(caldav.delete(resourcePath(COLLECTION_ID, UID), '"old"'))).toBe(
      "conflict",
    );
  });

  it("refuses a weak DELETE ETag before any request", async () => {
    const { caldav, calls } = await ready([]);
    expect(await codeOf(caldav.delete(resourcePath(COLLECTION_ID, UID), 'W/"old"'))).toBe(
      "invalid_argument",
    );
    expect(calls).toHaveLength(2);
  });
});

describe("bounds and failures", () => {
  it("refuses a declared body over the limit", async () => {
    const { caldav } = await ready([xml("ok", 207, { "Content-Length": "70000" })], {
      maxResponseBytes: 65_536,
    });
    expect(await codeOf(caldav.propfind(collectionPath(COLLECTION_ID), propfind(["D:displayname"])))).toBe(
      "upstream_error",
    );
  });

  it("stops a streamed body over the limit", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("a".repeat(40_000)));
        controller.enqueue(new TextEncoder().encode("b".repeat(40_000)));
        controller.close();
      },
    });
    const { caldav } = await ready([new Response(stream, { status: 207 })], { maxResponseBytes: 65_536 });
    expect(await codeOf(caldav.propfind(collectionPath(COLLECTION_ID), propfind(["D:displayname"])))).toBe(
      "upstream_error",
    );
  });

  it("refuses a response with a DTD when it is parsed", async () => {
    const { caldav } = await ready([xml('<!DOCTYPE x [<!ENTITY y "z">]><D:multistatus xmlns:D="DAV:"/>')]);
    const response = await caldav.propfind(collectionPath(COLLECTION_ID), propfind(["D:displayname"]));
    expect(() => parseMultistatus(response.body)).toThrow(CalDavError);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [507, "too_many_resources"],
    [500, "upstream_error"],
  ])("maps HTTP %i to %s", async (status, code) => {
    const { caldav } = await ready([xml("", status)]);
    expect(await codeOf(caldav.propfind(collectionPath(COLLECTION_ID), propfind(["D:displayname"])))).toBe(code);
  });

  it("maps a timeout on a read to upstream_error", async () => {
    const { caldav } = await ready([
      () => {
        throw new DOMException("aborted", "TimeoutError");
      },
    ]);
    expect(await codeOf(caldav.get(resourcePath(COLLECTION_ID, UID)))).toBe("upstream_error");
  });

  it("maps a timeout on a write to mutation_state_unknown", async () => {
    const { caldav } = await ready([
      () => {
        throw new DOMException("aborted", "TimeoutError");
      },
    ]);
    expect(await codeOf(caldav.put(resourcePath(COLLECTION_ID, UID), ICS, null))).toBe(
      "mutation_state_unknown",
    );
  });

  it("maps a network failure on a write to mutation_state_unknown", async () => {
    const { caldav } = await ready([
      () => {
        throw new TypeError("network down");
      },
    ]);
    expect(await codeOf(caldav.put(resourcePath(COLLECTION_ID, UID), ICS, null))).toBe(
      "mutation_state_unknown",
    );
  });
});
