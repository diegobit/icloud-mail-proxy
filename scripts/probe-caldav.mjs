#!/usr/bin/env node
// Read-only iCloud CalDAV probe.
//
// Answers the questions a CalDAV design depends on, without writing anything:
// where the principal and calendar home live, which collections exist and
// which components they advertise, how time-range filtering behaves, whether
// the server applies C:expand, and how a single resource is fetched.
//
// Only PROPFIND, REPORT, OPTIONS and GET are ever issued; the request helper
// refuses anything else, so this file cannot mutate an account even by
// accident. It exists to make plans/calendar-reminders.md reproducible, and is
// not part of the deployed Worker.
//
// Usage: node scripts/probe-caldav.mjs [--env-file .dev.vars] [--json]
// Credentials: ICLOUD_USER / ICLOUD_APP_PASSWORD from the environment, falling
// back to the env file. Nothing is printed except structure: the numeric
// account segment becomes <dsid> and the shard host becomes pNN-caldav.

import fs from "node:fs";

const READ_ONLY_METHODS = new Set(["PROPFIND", "REPORT", "OPTIONS", "GET", "HEAD"]);

function parseArgs(argv) {
  const options = { envFile: ".dev.vars", json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") options.envFile = argv[++i];
    else if (argv[i] === "--json") options.json = true;
  }
  return options;
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const options = parseArgs(process.argv.slice(2));
const fileEnv = readEnvFile(options.envFile);
const user = process.env.ICLOUD_USER ?? fileEnv.ICLOUD_USER;
const password = process.env.ICLOUD_APP_PASSWORD ?? fileEnv.ICLOUD_APP_PASSWORD;
if (!user || !password) {
  console.error("Missing ICLOUD_USER / ICLOUD_APP_PASSWORD (environment or --env-file).");
  process.exit(2);
}

const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
const root = "https://caldav.icloud.com/";

function redact(value) {
  return String(value ?? "")
    .replace(/\/\d{6,}\//g, "/<dsid>/")
    .replace(/p\d+-caldav/g, "pNN-caldav");
}

// Destination guard. The probe attaches Basic credentials to URLs that come
// out of Apple's XML, so it validates them the way the Worker must: bootstrap
// requests only to the well-known host, then only the discovered shard origin
// and the discovered home path.
const destinations = {
  origins: new Set(["https://caldav.icloud.com"]),
  pathByOrigin: new Map([["https://caldav.icloud.com", "/"]]),
};

function assertDestination(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`refusing ${parsed.protocol} URL`);
  if (parsed.username || parsed.password) throw new Error("refusing a URL with credentials");
  if (!destinations.origins.has(parsed.origin)) throw new Error(`refusing host ${parsed.host}`);
  const prefix = destinations.pathByOrigin.get(parsed.origin);
  if (!prefix || !parsed.pathname.startsWith(prefix)) {
    throw new Error(`refusing path outside ${prefix} on ${parsed.host}`);
  }
}

async function request(url, method, body, depth) {
  if (!READ_ONLY_METHODS.has(method)) throw new Error(`refusing ${method}: this probe is read-only`);
  assertDestination(url);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      ...(body ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
      ...(depth ? { Depth: depth } : {}),
      ...(method === "GET" ? { Accept: "text/calendar" } : {}),
    },
    body,
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

function firstHref(xml) {
  const match = /<(?:\w+:)?href[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/.exec(xml);
  return match ? match[1].trim() : null;
}

function innerHref(xml, name) {
  const match = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return match ? firstHref(match[1]) : null;
}

function componentSet(xml) {
  // Apple writes name='VEVENT' with single quotes; be forgiving.
  return [
    ...new Set(
      [...xml.matchAll(/<(?:\w+:)?comp\b[^>]*name\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ),
  ];
}

function responseChunks(xml) {
  return xml.split(/<(?:\w+:)?response[\s>]/).slice(1);
}

function icsMetrics(text) {
  const vevents = [...text.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)].map((m) => m[0]);
  const vtodos = [...text.matchAll(/BEGIN:VTODO[\s\S]*?END:VTODO/g)].map((m) => m[0]);
  const count = (blocks, pattern) => blocks.reduce((n, block) => n + (block.match(pattern) ?? []).length, 0);
  // Only component rules: VTIMEZONE also carries RRULE (YEARLY BYDAY), which
  // would otherwise dominate the counts.
  const rules = [...vevents, ...vtodos].flatMap((block) =>
    [...block.matchAll(/^RRULE:([^\r\n]*)/gm)].map((m) => m[1]),
  );
  const freq = {};
  for (const rule of rules) {
    const value = /(?:^|;)FREQ=([A-Z]+)/.exec(rule)?.[1] ?? "UNKNOWN";
    freq[value] = (freq[value] ?? 0) + 1;
  }
  return {
    resources: responseChunks(text).length,
    vevents: vevents.length,
    vtodos: vtodos.length,
    rrule: rules.length,
    recurrenceId: count(vevents, /^RECURRENCE-ID/gm) + count(vtodos, /^RECURRENCE-ID/gm),
    dtstartTzid: count(vevents, /^DTSTART;TZID=/gm),
    dtstartUtc: count(vevents, /^DTSTART:\d{8}T\d{6}Z/gm),
    dtstartDate: count(vevents, /^DTSTART;VALUE=DATE:/gm),
    freq,
    rulesWithByParts: rules.filter((rule) => /;BY/.test(rule)).length,
    rulesWithCount: rules.filter((rule) => /;COUNT=/.test(rule)).length,
    rulesWithUntil: rules.filter((rule) => /;UNTIL=/.test(rule)).length,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

async function discover() {
  const rootResponse = await request(
    root,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:current-user-principal/></d:prop>
</d:propfind>`,
    "0",
  );
  const principal = innerHref(rootResponse.text, "current-user-principal");
  if (!principal) throw new Error(`no current-user-principal (HTTP ${rootResponse.status})`);

  const principalUrl = new URL(principal, root).toString();
  const principalResponse = await request(
    principalUrl,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-home-set/><d:displayname/></d:prop>
</d:propfind>`,
    "0",
  );
  const home = innerHref(principalResponse.text, "calendar-home-set");
  if (!home) throw new Error(`no calendar-home-set (HTTP ${principalResponse.status})`);
  const homeUrl = new URL(home, principalUrl);
  // From here on, credentialed requests only reach the discovered shard and
  // only under the discovered calendars path.
  destinations.origins.add(homeUrl.origin);
  destinations.pathByOrigin.set(homeUrl.origin, homeUrl.pathname);
  return { rootStatus: rootResponse.status, principalUrl, home: homeUrl.toString() };
}

async function listCollections(home) {
  const response = await request(
    home,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <c:supported-calendar-component-set/>
    <d:current-user-privilege-set/>
    <ical:calendar-color/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`,
    "1",
  );
  const collections = responseChunks(response.text).map((chunk) => {
    const href = firstHref(chunk);
    const displayName = /<(?:\w+:)?displayname[^>]*>([\s\S]*?)<\/(?:\w+:)?displayname>/.exec(chunk)?.[1]?.trim() ?? null;
    const isCalendar = /<(?:\w+:)?calendar[\s/>]/.test(chunk);
    const privileges = [...chunk.matchAll(/<(?:\w+:)?(read|write|write-content|write-properties|bind|unbind)\s*\/>/g)].map(
      (m) => m[1],
    );
    return {
      href,
      displayName,
      isCalendar,
      components: componentSet(chunk),
      privileges: [...new Set(privileges)],
      url: href ? new URL(href, home).toString() : null,
    };
  });
  return { status: response.status, collections };
}

async function query(collectionUrl, component, { timeRange, expand } = {}) {
  const range = timeRange
    ? `<c:time-range start="${timeRange[0]}" end="${timeRange[1]}"/>`
    : "";
  const data = expand
    ? `<c:calendar-data><c:expand start="${expand[0]}" end="${expand[1]}"/></c:calendar-data>`
    : "<c:calendar-data/>";
  const response = await request(
    collectionUrl,
    "REPORT",
    `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/>${data}</d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${component}">${range}</c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`,
    "1",
  );
  return { status: response.status, ...icsMetrics(response.text), body: response.text };
}

const report = {};

try {
  const discovered = await discover();
  report.discovery = {
    rootStatus: discovered.rootStatus,
    principal: redact(discovered.principalUrl),
    home: redact(discovered.home),
  };

  const listed = await listCollections(discovered.home);
  report.collectionsStatus = listed.status;
  report.collections = listed.collections.map((c) => ({
    name: c.displayName,
    path: redact(c.href),
    isCalendar: c.isCalendar,
    components: c.components,
    privileges: c.privileges,
  }));

  const usable = listed.collections.filter((c) => c.isCalendar && c.displayName && c.url);
  const eventCollection = usable.find((c) => c.components.includes("VEVENT"));
  const todoCollection = usable.find((c) => c.components.includes("VTODO"));

  if (eventCollection) {
    const plain = await query(eventCollection.url, "VEVENT");
    const expanded = await query(eventCollection.url, "VEVENT", {
      expand: ["20260101T000000Z", "20261231T000000Z"],
    });
    report.expandCheck = {
      note: "same request body twice, differing only by C:expand; identical output means the server ignores it",
      plain: (({ body, ...rest }) => rest)(plain),
      expanded: (({ body, ...rest }) => rest)(expanded),
      identical: plain.body === expanded.body,
      bytes: {
        plain: Buffer.byteLength(plain.body, "utf8"),
        expanded: Buffer.byteLength(expanded.body, "utf8"),
      },
    };
    report.timeRange = {
      all: (({ body, ...rest }) => rest)(await query(eventCollection.url, "VEVENT")),
      next30Days: (({ body, ...rest }) => rest)(
        await query(eventCollection.url, "VEVENT", {
          timeRange: ["20261021T000000Z", "20261120T000000Z"],
        }),
      ),
      wide: (({ body, ...rest }) => rest)(
        await query(eventCollection.url, "VEVENT", {
          timeRange: ["20200101T000000Z", "20301231T000000Z"],
        }),
      ),
    };

    // One resource: href shape, ETag, and the two ways to fetch one item.
    const sample = await query(eventCollection.url, "VEVENT", {
      timeRange: ["20200101T000000Z", "20301231T000000Z"],
    });
    const href = firstHref(sample.body);
    if (href) {
      const resourceUrl = new URL(href, discovered.home).toString();
      const viaGet = await request(resourceUrl, "GET");
      const viaPropfind = await request(
        resourceUrl,
        "PROPFIND",
        `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop></d:propfind>`,
        "0",
      );
      const viaMultiget = await request(
        eventCollection.url,
        "REPORT",
        `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-multiget xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <d:href>${new URL(resourceUrl).pathname}</d:href>
</c:calendar-multiget>`,
        "1",
      );
      const etag = /<(?:\w+:)?getetag[^>]*>([\s\S]*?)<\/(?:\w+:)?getetag>/.exec(extractFirstResponse(viaPropfind.text))?.[1] ?? null;
      report.singleResource = {
        hrefTail: href.split("/").filter(Boolean).slice(-1)[0],
        etagShape: etag ? (etag.trim().startsWith('"') ? "strong-quoted" : "unquoted") : null,
        get: { status: viaGet.status, calendarData: /BEGIN:VCALENDAR/.test(viaGet.text) },
        propfind: { status: viaPropfind.status, calendarData: /BEGIN:VCALENDAR/.test(viaPropfind.text) },
        multiget: { status: viaMultiget.status, calendarData: /BEGIN:VCALENDAR/.test(viaMultiget.text) },
        timezones: (viaGet.text.match(/BEGIN:VTIMEZONE/g) ?? []).length,
      };
    }
  }

  if (todoCollection) {
    report.todos = (({ body, ...rest }) => rest)(await query(todoCollection.url, "VTODO"));
    report.todosWithRange = (({ body, ...rest }) => rest)(
      await query(todoCollection.url, "VTODO", {
        timeRange: ["20261021T000000Z", "20261120T000000Z"],
      }),
    );
  }

  const optionsResponse = await request(discovered.principalUrl, "OPTIONS");
  report.options = {
    status: optionsResponse.status,
    dav: optionsResponse.headers.get("dav"),
    allow: optionsResponse.headers.get("allow"),
  };
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : String(error));
}

function extractFirstResponse(xml) {
  return responseChunks(xml)[0] ?? "";
}

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { collections = [], ...rest } = report;
  console.log(JSON.stringify(rest, null, 2));
  console.log("\ncollections:");
  for (const collection of collections) {
    console.log(
      `  ${String(collection.name ?? "(unnamed)").padEnd(20)} ${collection.components.join(",") || "-"}`,
    );
  }
}

process.exit(report.error ? 1 : 0);
