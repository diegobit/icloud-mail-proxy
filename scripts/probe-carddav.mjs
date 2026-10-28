#!/usr/bin/env node
// Read-only iCloud CardDAV probe.
//
// Answers the questions the contacts design depends on (plans/
// feature-gap-roadmap.md, unit 2), without writing anything: does discovery
// work with an app-specific password, where the principal and
// addressbook-home-set live, which address books exist, whether
// addressbook-query with a text-match on FN/EMAIL is honoured, which vCard
// version comes back, and the ETag/href shape and size of the whole book.
//
// Only PROPFIND, REPORT, OPTIONS, GET and HEAD are ever issued; the request
// helper refuses anything else, so this file cannot mutate an account even by
// accident. It is not part of the deployed Worker.
//
// Usage: node scripts/probe-carddav.mjs [--env-file .dev.vars] [--json]
// Credentials: ICLOUD_USER / ICLOUD_APP_PASSWORD from the environment, falling
// back to the env file. Nothing is printed except structure and counts: no
// name, address, number or note of any contact. The numeric account segment
// becomes <dsid>, the shard host becomes pNN-contacts and resource names are
// reduced to their shape.

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
const root = "https://contacts.icloud.com/";

function redact(value) {
  return String(value ?? "")
    .replace(/\/\d{6,}\//g, "/<dsid>/")
    .replace(/p\d+-contacts/g, "pNN-contacts");
}

/** The shape of a resource name, never the name itself. */
function nameShape(tail) {
  if (!tail) return null;
  if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\.vcf$/i.test(tail)) return "<uuid>.vcf";
  if (/^[A-Za-z0-9._-]{1,128}\.vcf$/.test(tail)) return "<id-safe>.vcf";
  if (/\.vcf$/i.test(tail)) return "<other>.vcf";
  return "<other>";
}

// Destination guard, as in probe-caldav.mjs: the bootstrap host only for the
// root and then the exact principal path; afterwards only an Apple contacts
// shard on 443, under the validated account home.
const BOOTSTRAP_ORIGIN = "https://contacts.icloud.com";
const SHARD_HOST = /^p\d+-contacts\.icloud\.com$/;
const destinations = {
  origins: new Set([BOOTSTRAP_ORIGIN]),
  pathByOrigin: new Map([[BOOTSTRAP_ORIGIN, "/"]]),
};

function assertDestination(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error(`refusing ${parsed.protocol} URL`);
  if (parsed.username || parsed.password) throw new Error("refusing a URL with credentials");
  if (parsed.port && parsed.port !== "443") throw new Error(`refusing port ${parsed.port}`);
  if (!destinations.origins.has(parsed.origin)) throw new Error(`refusing host ${parsed.host}`);
  if (/%2e|%2f|%5c/i.test(parsed.pathname)) throw new Error("refusing an encoded path separator");
  const prefix = destinations.pathByOrigin.get(parsed.origin);
  if (!prefix) throw new Error(`refusing ${parsed.host}: no allowed path`);
  const allowed =
    parsed.origin === BOOTSTRAP_ORIGIN ? parsed.pathname === prefix : parsed.pathname.startsWith(prefix);
  if (!allowed) throw new Error(`refusing path ${parsed.pathname} on ${parsed.host}`);
}

/** The home must be on an Apple contacts shard, under the principal's account. */
function validateHome(principalPath, homeHref, principalUrl) {
  const home = new URL(homeHref, principalUrl);
  if (home.protocol !== "https:") throw new Error("home is not https");
  if (home.port && home.port !== "443") throw new Error(`home is on port ${home.port}`);
  if (home.username || home.password) throw new Error("home carries credentials");
  if (!SHARD_HOST.test(home.hostname)) throw new Error(`home is not an Apple contacts shard: ${home.hostname}`);
  const account = /^\/(\d{6,})\/principal\/?$/.exec(principalPath);
  if (!account) throw new Error(`unexpected principal path ${principalPath}`);
  if (!home.pathname.startsWith(`/${account[1]}/`)) {
    throw new Error(`home path ${redact(home.pathname)} is not under the principal's account`);
  }
  return home;
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
      ...(method === "GET" ? { Accept: "text/vcard" } : {}),
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

function responseChunks(xml) {
  return xml.split(/<(?:\w+:)?response[\s>]/).slice(1);
}

/** Counts and shapes only: never a value out of a card. */
function cardMetrics(text) {
  const cards = [...text.matchAll(/BEGIN:VCARD[\s\S]*?END:VCARD/g)].map((m) => m[0]);
  const versions = {};
  for (const card of cards) {
    const version = /^VERSION:([^\r\n]*)/m.exec(card)?.[1]?.trim() ?? "none";
    versions[version] = (versions[version] ?? 0) + 1;
  }
  const withProperty = (name) =>
    cards.filter((card) => new RegExp(`^(?:[A-Za-z0-9-]+\\.)?${name}[;:]`, "m").test(card)).length;
  const chunks = responseChunks(text);
  const etags = chunks
    .map((chunk) => /<(?:\w+:)?getetag[^>]*>([\s\S]*?)<\/(?:\w+:)?getetag>/.exec(chunk)?.[1]?.trim())
    .filter(Boolean);
  const hrefShapes = {};
  for (const chunk of chunks) {
    const shape = nameShape(firstHref(chunk)?.split("/").filter(Boolean).slice(-1)[0]);
    hrefShapes[shape] = (hrefShapes[shape] ?? 0) + 1;
  }
  return {
    responses: chunks.length,
    cards: cards.length,
    versions,
    groups: cards.filter((card) => /^X-ADDRESSBOOKSERVER-KIND:group/im.test(card)).length,
    withFn: withProperty("FN"),
    withEmail: withProperty("EMAIL"),
    withTel: withProperty("TEL"),
    withOrg: withProperty("ORG"),
    withNote: withProperty("NOTE"),
    withAdr: withProperty("ADR"),
    withPhoto: withProperty("PHOTO"),
    groupedProperties: cards.filter((card) => /^item\d+\./m.test(card)).length,
    foldedLines: cards.filter((card) => /\r?\n[ \t]/.test(card)).length,
    etagShapes: [...new Set(etags.map((etag) => (etag.startsWith('"') ? "strong-quoted" : etag.startsWith("W/") ? "weak" : "unquoted")))],
    hrefShapes,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

async function discover() {
  const rootResponse = await request(
    root,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    "0",
  );
  const principal = innerHref(rootResponse.text, "current-user-principal");
  if (!principal) throw new Error(`no current-user-principal (HTTP ${rootResponse.status})`);

  const principalUrl = new URL(principal, root).toString();
  if (new URL(principalUrl).origin !== BOOTSTRAP_ORIGIN) throw new Error("principal is not on the bootstrap origin");
  if (!/^\/\d{6,}\/principal\/?$/.test(new URL(principalUrl).pathname)) {
    throw new Error(`unexpected principal path ${redact(new URL(principalUrl).pathname)}`);
  }
  destinations.pathByOrigin.set(BOOTSTRAP_ORIGIN, new URL(principalUrl).pathname);
  const principalResponse = await request(
    principalUrl,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><card:addressbook-home-set/></d:prop>
</d:propfind>`,
    "0",
  );
  const home = innerHref(principalResponse.text, "addressbook-home-set");
  if (!home) throw new Error(`no addressbook-home-set (HTTP ${principalResponse.status})`);
  const homeUrl = validateHome(new URL(principalUrl).pathname, home, principalUrl);
  destinations.origins.add(homeUrl.origin);
  destinations.pathByOrigin.set(homeUrl.origin, homeUrl.pathname);
  return { rootStatus: rootResponse.status, principalStatus: principalResponse.status, principalUrl, home: homeUrl.toString() };
}

async function listCollections(home) {
  const response = await request(
    home,
    "PROPFIND",
    `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <d:current-user-privilege-set/>
    <card:supported-address-data/>
    <card:max-resource-size/>
    <cs:getctag/>
  </d:prop>
</d:propfind>`,
    "1",
  );
  const collections = responseChunks(response.text).map((chunk) => {
    const href = firstHref(chunk);
    const displayName = /<(?:\w+:)?displayname[^>]*>([\s\S]*?)<\/(?:\w+:)?displayname>/.exec(chunk)?.[1]?.trim() ?? null;
    const isAddressBook = /<(?:\w+:)?addressbook[\s/>]/.test(chunk);
    const privileges = [...chunk.matchAll(/<(?:\w+:)?(read|write|write-content|write-properties|bind|unbind)\s*\/>/g)].map(
      (m) => m[1],
    );
    const dataTypes = [...chunk.matchAll(/<(?:\w+:)?address-data-type\b[^>]*version\s*=\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    return {
      href,
      displayName,
      isAddressBook,
      privileges: [...new Set(privileges)],
      dataTypes,
      url: href ? new URL(href, home).toString() : null,
    };
  });
  return { status: response.status, collections };
}

function textMatchQuery(properties, needle, { limit, props } = {}) {
  const data = props
    ? `<card:address-data>${props.map((name) => `<card:prop name="${name}"/>`).join("")}</card:address-data>`
    : "<card:address-data/>";
  const filters = [properties]
    .flat()
    .map(
      (property) => `
    <card:prop-filter name="${property}">
      <card:text-match collation="i;unicode-casemap" match-type="contains">${needle}</card:text-match>
    </card:prop-filter>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/>${data}</d:prop>
  <card:filter test="anyof">${filters}
  </card:filter>${limit ? `\n  <card:limit><card:nresults>${limit}</card:nresults></card:limit>` : ""}
</card:addressbook-query>`;
}

const report = {};

try {
  const discovered = await discover();
  report.discovery = {
    rootStatus: discovered.rootStatus,
    principalStatus: discovered.principalStatus,
    principal: redact(discovered.principalUrl),
    home: redact(discovered.home),
  };

  const listed = await listCollections(discovered.home);
  report.collectionsStatus = listed.status;
  report.collections = listed.collections.map((c) => ({
    name: c.displayName,
    path: redact(c.href),
    isAddressBook: c.isAddressBook,
    privileges: c.privileges,
    dataTypes: c.dataTypes,
  }));

  const book = listed.collections.find((c) => c.isAddressBook && c.url);
  if (book) {
    // The whole book, ETags and data: the baseline for size and shape.
    const all = await request(
      book.url,
      "PROPFIND",
      `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:getcontenttype/></d:prop></d:propfind>`,
      "1",
    );
    report.listing = { status: all.status, ...cardMetrics(all.text) };

    const fullQuery = await request(
      book.url,
      "REPORT",
      `<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop>
</card:addressbook-query>`,
      "1",
    );
    report.unfilteredQuery = { status: fullQuery.status, ...cardMetrics(fullQuery.text) };

    // Server-side filtering: "@" is in every EMAIL, so a working filter
    // returns exactly the cards that have one; a server that ignores the
    // filter returns the whole book.
    const byEmail = await request(book.url, "REPORT", textMatchQuery("EMAIL", "@"), "1");
    report.textMatchEmailAt = { status: byEmail.status, ...cardMetrics(byEmail.text) };
    const byFn = await request(book.url, "REPORT", textMatchQuery("FN", "zzqxjv-no-such-name"), "1");
    report.textMatchFnNoMatch = { status: byFn.status, ...cardMetrics(byFn.text) };
    // Case folding: the same letter in both cases must match the same cards.
    const lower = await request(book.url, "REPORT", textMatchQuery("FN", "a"), "1");
    const upper = await request(book.url, "REPORT", textMatchQuery("FN", "A"), "1");
    report.textMatchCaseFolding = {
      lowerStatus: lower.status,
      upperStatus: upper.status,
      lowerCards: cardMetrics(lower.text).cards,
      upperCards: cardMetrics(upper.text).cards,
    };
    const either = await request(book.url, "REPORT", textMatchQuery(["FN", "EMAIL"], "@"), "1");
    report.textMatchAnyofFnEmail = { status: either.status, cards: cardMetrics(either.text).cards };
    const limited = await request(book.url, "REPORT", textMatchQuery("EMAIL", "@", { limit: 3 }), "1");
    report.textMatchWithLimit3 = { status: limited.status, ...cardMetrics(limited.text) };
    const narrowed = await request(
      book.url,
      "REPORT",
      textMatchQuery("EMAIL", "@", { props: ["VERSION", "UID", "FN", "N", "EMAIL", "TEL", "ORG"] }),
      "1",
    );
    report.textMatchWithPropSubset = { status: narrowed.status, ...cardMetrics(narrowed.text) };

    const href = firstHref(responseChunks(fullQuery.text).find((chunk) => /BEGIN:VCARD/.test(chunk)) ?? "");
    if (href) {
      const resourceUrl = new URL(href, discovered.home).toString();
      const viaGet = await request(resourceUrl, "GET");
      const viaMultiget = await request(
        book.url,
        "REPORT",
        `<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><card:address-data/></d:prop>
  <d:href>${new URL(resourceUrl).pathname}</d:href>
</card:addressbook-multiget>`,
        "1",
      );
      report.singleResource = {
        hrefShape: nameShape(href.split("/").filter(Boolean).slice(-1)[0]),
        hrefUnderBook: new URL(resourceUrl).pathname.startsWith(new URL(book.url).pathname),
        get: { status: viaGet.status, contentType: viaGet.headers.get("content-type"), vcard: /BEGIN:VCARD/.test(viaGet.text) },
        multiget: { status: viaMultiget.status, ...cardMetrics(viaMultiget.text) },
      };
    }
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

if (options.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const { collections = [], ...rest } = report;
  console.log(JSON.stringify(rest, null, 2));
  console.log("\ncollections:");
  for (const collection of collections) {
    console.log(
      `  ${String(collection.name ?? "(unnamed)").padEnd(20)} ${collection.isAddressBook ? "addressbook" : "-"} ${collection.path}`,
    );
  }
}

process.exit(report.error ? 1 : 0);
