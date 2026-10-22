// CalDAV transport for iCloud calendars.
//
// Two trust boundaries live here, and both must hold before the Basic
// credential is attached to a request:
//
//   1. bootstrap: https://caldav.icloud.com/ and the exact /<dsid>/principal/
//      path Apple names in the current-user-principal response;
//   2. pinned: the account's own /<dsid>/calendars/ on the pNN-caldav shard
//      named by calendar-home-set.
//
// The shard host must match ^p\d+-caldav\.icloud\.com$ and the home path must
// be the calendars directory of the same dsid the principal belongs to, so a
// response can never point the credential at another host or account.
// Redirects are never followed: a 3xx means the shard moved, which invalidates
// discovery, so the caller retries once after re-discovering.
//
// Request bodies are built here rather than in the tool layer so they can be
// tested byte for byte. Responses are parsed with fast-xml-parser (no DOM in
// Workers) and are bounded before parsing.

import { XMLParser } from "fast-xml-parser";
import type { Env } from "./types";

export type CalDavErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "too_many_resources"
  | "recurrence_too_complex"
  | "mutation_state_unknown"
  | "upstream_error"
  | "malformed"
  | "invalid_argument";

export class CalDavError extends Error {
  readonly status: number;
  readonly code: CalDavErrorCode;
  readonly davStatus?: string;

  constructor(code: CalDavErrorCode, status: number, message: string, davStatus?: string) {
    super(message);
    this.name = "CalDavError";
    this.code = code;
    this.status = status;
    this.davStatus = davStatus;
  }
}

export interface CalDavOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
  /** Discovery memo TTL; 0 disables memoization (useful in tests). */
  discoveryTtlMs?: number;
}

export interface CalDavDiscovery {
  principalUrl: string;
  homeUrl: string;
}

export type CalDavDepth = 0 | 1 | "infinity";

export interface CalDavResponse {
  status: number;
  etag: string | null;
  body: string;
}

export interface CalDav {
  discover(): Promise<CalDavDiscovery>;
  propfind(href: string, body: string, depth?: CalDavDepth): Promise<CalDavResponse>;
  report(href: string, body: string, depth?: CalDavDepth): Promise<CalDavResponse>;
  get(href: string): Promise<CalDavResponse>;
  /** Creates when `etag` is null (If-None-Match: *), updates otherwise (If-Match). */
  put(href: string, ics: string, etag: string | null): Promise<CalDavResponse>;
}

export interface CalendarQueryInput {
  component: "VEVENT";
  timeRange?: { start: string; end: string };
}

const BOOTSTRAP_ORIGIN = "https://caldav.icloud.com";
const BOOTSTRAP_ROOT = `${BOOTSTRAP_ORIGIN}/`;
const PRINCIPAL_PATH = /^\/(\d{6,})\/principal\/?$/;
const SHARD_HOST = /^p\d+-caldav\.icloud\.com$/;
const ENCODED_SEPARATOR = /%(?:2e|2f|5c)/i;
const CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUT_MS = 15_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MIN_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DISCOVERY_TTL_MS = 10 * 60_000;
const DISCOVERY_CACHE_LIMIT = 8;
const ID = /^[A-Za-z0-9._-]{1,128}$/;
const ETAG = /^(?:W\/)?"[\x20-\x21\x23-\x7e]*"$/;
const TIME_RANGE = /^\d{8}T\d{6}Z$/;
const PROP_NAME = /^[A-Za-z]+:[A-Za-z-]+$/;
const XML_NAMESPACES =
  'xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" ' +
  'xmlns:CS="http://calendarserver.org/ns/" xmlns:A="http://apple.com/ns/ical/"';

export function propfind(props: readonly string[]): string {
  assertProps(props);
  const body = props.map((prop) => `<${prop}/>`).join("");
  return `<D:propfind ${XML_NAMESPACES}><D:prop>${body}</D:prop></D:propfind>`;
}

export function calendarQuery({ component, timeRange }: CalendarQueryInput): string {
  const range = timeRange ? timeRangeElement(timeRange) : "";
  return (
    `<C:calendar-query ${XML_NAMESPACES}>` +
    "<D:prop><D:getetag/><C:calendar-data/></D:prop>" +
    '<C:filter><C:comp-filter name="VCALENDAR">' +
    `<C:comp-filter name="${component}">${range}</C:comp-filter>` +
    "</C:comp-filter></C:filter></C:calendar-query>"
  );
}

export function calendarMultiget(hrefs: readonly string[]): string {
  if (hrefs.length === 0) throw new CalDavError("invalid_argument", 0, "calendar-multiget needs at least one href");
  const body = hrefs.map((href) => `<D:href>${escapeXml(href)}</D:href>`).join("");
  return (
    `<C:calendar-multiget ${XML_NAMESPACES}>` +
    `<D:prop><D:getetag/><C:calendar-data/></D:prop>${body}</C:calendar-multiget>`
  );
}

export function putResource(
  href: string,
  ics: string,
  etag: string | null,
): { url: string; init: RequestInit } {
  if (etag !== null && !ETAG.test(etag)) {
    throw new CalDavError("invalid_argument", 0, "the ETag is not a quoted HTTP entity tag");
  }
  return {
    url: href,
    init: {
      method: "PUT",
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        ...(etag === null ? { "If-None-Match": "*" } : { "If-Match": etag }),
      },
      body: ics,
    },
  };
}

/** Relative href of a collection inside the home: `<id>/`. */
export function collectionPath(collectionId: string): string {
  return `${encodeId("collection id", collectionId)}/`;
}

/** Relative href of a resource inside a collection: `<id>/<uid>.ics`. */
export function resourcePath(collectionId: string, uid: string): string {
  return `${encodeId("collection id", collectionId)}/${encodeId("resource id", uid)}.ics`;
}

// --- Multistatus parsing ---------------------------------------------------

export interface DavPropstat {
  status: number | null;
  props: Record<string, unknown>;
}

export interface DavResponse {
  href: string;
  status: number | null;
  propstats: DavPropstat[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: true,
  htmlEntities: false,
  trimValues: false,
  ignoreDeclaration: true,
  allowBooleanAttributes: true,
});

export function parseMultistatus(xml: string): DavResponse[] {
  rejectDangerousMarkup(xml);
  let parsed: unknown;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    throw new CalDavError("malformed", 0, `the CalDAV XML could not be parsed: ${messageOf(error)}`);
  }
  const multistatus = isRecord(parsed) ? parsed.multistatus : undefined;
  // An empty <multistatus> is a valid 207 with zero responses: fast-xml-parser
  // represents it as a string (empty, or whitespace) rather than an object.
  // Only a non-empty, non-object value is malformed.
  if (typeof multistatus === "string" && multistatus.trim() === "") return [];
  if (!isRecord(multistatus)) {
    throw new CalDavError("malformed", 0, "the CalDAV response is not a DAV multistatus");
  }
  return asArray(multistatus.response).map((response) => parseResponse(response, xml));
}

function parseResponse(node: unknown, _xml: string): DavResponse {
  if (!isRecord(node)) throw malformedMultistatus("a response element is not an object");
  const href = textOf(node.href);
  if (href === null || href.trim() === "") {
    throw malformedMultistatus("a multistatus response has no href");
  }
  return {
    href: href.trim(),
    status: statusOf(node.status),
    propstats: asArray(node.propstat).map((propstat) => parsePropstat(propstat)),
  };
}

function parsePropstat(node: unknown): DavPropstat {
  if (!isRecord(node)) throw malformedMultistatus("a propstat element is not an object");
  return {
    status: statusOf(node.status),
    props: isRecord(node.prop) ? node.prop : {},
  };
}

function malformedMultistatus(message: string): CalDavError {
  return new CalDavError("malformed", 0, `malformed multistatus: ${message}`);
}

/** Value of a property from a 2xx propstat only; 404 groups are ignored. */
export function propValue(response: DavResponse, name: string): unknown {
  for (const propstat of response.propstats) {
    if (propstat.status === null || propstat.status < 200 || propstat.status >= 300) continue;
    if (Object.hasOwn(propstat.props, name)) return propstat.props[name];
  }
  return undefined;
}

export function propText(response: DavResponse, name: string): string | null {
  return textOf(propValue(response, name));
}

export function propHref(response: DavResponse, name: string): string | null {
  const value = propValue(response, name);
  const href = isRecord(value) ? value.href : value;
  const text = textOf(href);
  if (text === null) return null;
  const trimmed = text.trim();
  return trimmed === "" ? null : trimmed;
}

export function displayName(response: DavResponse): string | null {
  const name = propText(response, "displayname");
  if (name === null) return null;
  const trimmed = name.trim();
  return trimmed === "" ? null : trimmed;
}

export function resourcetypeKinds(response: DavResponse): string[] {
  const value = propValue(response, "resourcetype");
  if (!isRecord(value)) return [];
  return Object.keys(value).filter((key) => !key.startsWith("@_") && key !== "#text");
}

export function componentNames(response: DavResponse): string[] {
  const value = propValue(response, "supported-calendar-component-set");
  if (!isRecord(value)) return [];
  const names: string[] = [];
  for (const component of asArray(value.comp)) {
    if (!isRecord(component)) continue;
    const name = component["@_name"];
    if (typeof name === "string" && name !== "") names.push(name.toUpperCase());
  }
  return [...new Set(names)];
}

// --- Transport -------------------------------------------------------------

interface Pinned {
  origin: string;
  homePath: string;
}

interface CacheEntry extends CalDavDiscovery {
  expiresAt: number;
}

const discoveryCache = new Map<string, CacheEntry>();

/** Clears the per-isolate discovery memo; tests call it between cases. */
export function clearCalDavDiscoveryCache(user?: string): void {
  if (user === undefined) discoveryCache.clear();
  else discoveryCache.delete(user);
}

export function createCalDav(env: Env, options: CalDavOptions = {}): CalDav {
  const user = env.ICLOUD_USER;
  const password = env.ICLOUD_APP_PASSWORD;
  if (!user || !password) {
    throw new CalDavError("upstream_error", 0, "ICLOUD_USER and ICLOUD_APP_PASSWORD are required for CalDAV");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = clamp(
    options.timeoutMs ?? envInt(env.CALDAV_TIMEOUT_MS),
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const maxBytes = clamp(
    options.maxResponseBytes ?? envInt(env.MAX_RESPONSE_BYTES),
    MIN_RESPONSE_BYTES,
    MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
  );
  const discoveryTtlMs = options.discoveryTtlMs ?? DISCOVERY_TTL_MS;
  const authorization = `Basic ${base64Utf8(`${user}:${password}`)}`;

  function cachedDiscovery(): CalDavDiscovery | null {
    const entry = discoveryCache.get(user);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      discoveryCache.delete(user);
      return null;
    }
    return { principalUrl: entry.principalUrl, homeUrl: entry.homeUrl };
  }

  function storeDiscovery(discovery: CalDavDiscovery): void {
    discoveryCache.delete(user);
    discoveryCache.set(user, { ...discovery, expiresAt: Date.now() + discoveryTtlMs });
    while (discoveryCache.size > DISCOVERY_CACHE_LIMIT) {
      const oldest = discoveryCache.keys().next().value;
      if (oldest === undefined) break;
      discoveryCache.delete(oldest);
    }
  }

  async function send(init: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: string;
    mutation?: boolean;
  }): Promise<CalDavResponse> {
    let response: Response;
    try {
      response = await fetchImpl(init.url, {
        method: init.method,
        headers: { Authorization: authorization, ...init.headers },
        body: init.body,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const detail = describeFetchError(error, timeoutMs);
      if (init.mutation) {
        throw new CalDavError(
          "mutation_state_unknown",
          0,
          `the ${init.method} request may or may not have been applied: ${detail}`,
        );
      }
      throw new CalDavError("upstream_error", 0, detail);
    }

    const etag = response.headers.get("etag");
    const skipBody =
      response.body === null || response.status === 204 || response.status === 304 || REDIRECTS.has(response.status);
    if (skipBody) {
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status, etag, body: "" };
    }

    try {
      return { status: response.status, etag, body: await readBounded(response, maxBytes) };
    } catch (error) {
      if (init.mutation) {
        throw new CalDavError(
          "mutation_state_unknown",
          response.status,
          `the ${init.method} request may have been applied but its response could not be read: ${messageOf(error)}`,
        );
      }
      throw error;
    }
  }

  async function readBounded(response: Response, limit: number): Promise<string> {
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const length = Number(declared);
      if (!Number.isFinite(length) || length < 0) {
        throw new CalDavError("malformed", response.status, "iCloud sent an invalid Content-Length");
      }
      if (length > limit) {
        await response.body?.cancel().catch(() => undefined);
        throw new CalDavError(
          "upstream_error",
          response.status,
          `the CalDAV response declares ${length} bytes, over the ${limit} byte limit`,
        );
      }
    }

    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        total += value.byteLength;
        if (total > limit) {
          await reader.cancel().catch(() => undefined);
          throw new CalDavError(
            "upstream_error",
            response.status,
            `the CalDAV response is over the ${limit} byte limit`,
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof CalDavError) throw error;
      throw new CalDavError("upstream_error", response.status, `reading the CalDAV response failed: ${messageOf(error)}`);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
  }

  function assertStatus(response: CalDavResponse, allowed: readonly number[]): void {
    if (allowed.includes(response.status)) return;
    throw httpError(response.status);
  }

  function resolveBootstrapHref(href: string): string {
    const url = parseHref(href, BOOTSTRAP_ROOT, "principal");
    if (url.origin !== BOOTSTRAP_ORIGIN) {
      throw new CalDavError("malformed", 0, `refusing a principal on ${url.host}`);
    }
    const match = PRINCIPAL_PATH.exec(url.pathname);
    if (!match) {
      throw new CalDavError("malformed", 0, `unexpected iCloud principal path ${url.pathname}`);
    }
    return `${BOOTSTRAP_ORIGIN}/${match[1]}/principal/`;
  }

  function validateHome(principalUrl: string, href: string): string {
    const principal = new URL(principalUrl);
    const account = PRINCIPAL_PATH.exec(principal.pathname);
    if (!account) throw new CalDavError("malformed", 0, `unexpected iCloud principal path ${principal.pathname}`);

    const home = parseHref(href, principalUrl, "calendar home");
    if (home.origin === BOOTSTRAP_ORIGIN) {
      throw new CalDavError("malformed", 0, "the calendar home is on the bootstrap host, not a shard");
    }
    if (!SHARD_HOST.test(home.hostname)) {
      throw new CalDavError("malformed", 0, `the calendar home is not an Apple shard: ${home.hostname}`);
    }
    const expected = `/${account[1]}/calendars/`;
    if (home.pathname !== expected) {
      throw new CalDavError(
        "malformed",
        0,
        `the calendar home ${home.pathname} is not the principal's ${expected}`,
      );
    }
    return `${home.origin}${home.pathname}`;
  }

  function parseHref(href: string, base: string, what: string): URL {
    if (href === "" || CONTROL_OR_BACKSLASH.test(href)) {
      throw new CalDavError("malformed", 0, `refusing an unusable ${what} href`);
    }
    if (ENCODED_SEPARATOR.test(href)) {
      throw new CalDavError("malformed", 0, `refusing a ${what} with an encoded path separator`);
    }
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      throw new CalDavError("malformed", 0, `refusing an unparseable ${what} href`);
    }
    if (url.protocol !== "https:") {
      throw new CalDavError("malformed", 0, `refusing a ${what} that is not https`);
    }
    if (url.username !== "" || url.password !== "") {
      throw new CalDavError("malformed", 0, `refusing a ${what} that carries credentials`);
    }
    if (url.port !== "" && url.port !== "443") {
      throw new CalDavError("malformed", 0, `refusing a ${what} on port ${url.port}`);
    }
    if (url.search !== "" || url.hash !== "") {
      throw new CalDavError("malformed", 0, `refusing a ${what} with a query or fragment`);
    }
    if (ENCODED_SEPARATOR.test(url.pathname)) {
      throw new CalDavError("malformed", 0, `refusing a ${what} with an encoded path separator`);
    }
    return url;
  }

  function resolvePinned(pinned: Pinned, href: string): string {
    if (href === "" || CONTROL_OR_BACKSLASH.test(href)) {
      throw new CalDavError("invalid_argument", 0, "the CalDAV path is empty or contains a control character");
    }
    const url = parseHref(href, `${pinned.origin}${pinned.homePath}`, "calendar");
    if (url.origin !== pinned.origin) {
      throw new CalDavError("invalid_argument", 0, `refusing a request to ${url.host}`);
    }
    if (!url.pathname.startsWith(pinned.homePath)) {
      throw new CalDavError("invalid_argument", 0, `refusing a path outside the calendar home: ${url.pathname}`);
    }
    return url.toString();
  }

  async function discover(): Promise<CalDavDiscovery> {
    const cached = cachedDiscovery();
    if (cached) return cached;

    const root = await send({
      method: "PROPFIND",
      url: BOOTSTRAP_ROOT,
      headers: xmlHeaders(0),
      body: propfind(["D:current-user-principal"]),
    });
    assertStatus(root, [200, 207]);
    const principalHref = firstPropHref(parseMultistatus(root.body), "current-user-principal");
    if (principalHref === null) {
      throw new CalDavError("malformed", root.status, "iCloud returned no current-user-principal");
    }
    const principalUrl = resolveBootstrapHref(principalHref);

    const principal = await send({
      method: "PROPFIND",
      url: principalUrl,
      headers: xmlHeaders(0),
      body: propfind(["C:calendar-home-set"]),
    });
    assertStatus(principal, [200, 207]);
    const homeHref = firstPropHref(parseMultistatus(principal.body), "calendar-home-set");
    if (homeHref === null) {
      throw new CalDavError("malformed", principal.status, "iCloud returned no calendar-home-set");
    }
    const homeUrl = validateHome(principalUrl, homeHref);

    const discovery = { principalUrl, homeUrl };
    storeDiscovery(discovery);
    return discovery;
  }

  async function pinnedCall(
    href: string,
    callback: (url: string) => Promise<CalDavResponse>,
  ): Promise<CalDavResponse> {
    let discovery = await discover();
    let response = await callback(resolvePinned(pin(discovery), href));
    if (!REDIRECTS.has(response.status)) return response;

    clearCalDavDiscoveryCache(user);
    discovery = await discover();
    response = await callback(resolvePinned(pin(discovery), href));
    if (REDIRECTS.has(response.status)) {
      throw new CalDavError("upstream_error", response.status, "iCloud kept redirecting the CalDAV request");
    }
    return response;
  }

  return {
    discover,

    async propfind(href, body, depth = 0) {
      const response = await pinnedCall(href, (url) =>
        send({ method: "PROPFIND", url, headers: xmlHeaders(depth), body }),
      );
      assertStatus(response, [200, 207]);
      return response;
    },

    async report(href, body, depth = 1) {
      const response = await pinnedCall(href, (url) =>
        send({ method: "REPORT", url, headers: xmlHeaders(depth), body }),
      );
      assertStatus(response, [200, 207]);
      return response;
    },

    async get(href) {
      const response = await pinnedCall(href, (url) =>
        send({ method: "GET", url, headers: { Accept: "text/calendar" } }),
      );
      assertStatus(response, [200]);
      return response;
    },

    async put(href, ics, etag) {
      const built = putResource(href, ics, etag);
      const response = await pinnedCall(href, (url) =>
        send({
          method: "PUT",
          url,
          headers: built.init.headers as Record<string, string>,
          body: built.init.body as string,
          mutation: true,
        }),
      );
      assertStatus(response, [200, 201, 204]);
      return response;
    },
  };
}

// --- Helpers ---------------------------------------------------------------

function pin(discovery: CalDavDiscovery): Pinned {
  const home = new URL(discovery.homeUrl);
  return { origin: home.origin, homePath: home.pathname };
}

function xmlHeaders(depth: CalDavDepth): Record<string, string> {
  return { "Content-Type": "application/xml; charset=utf-8", Depth: String(depth) };
}

function firstPropHref(responses: readonly DavResponse[], name: string): string | null {
  for (const response of responses) {
    const href = propHref(response, name);
    if (href !== null) return href;
  }
  return null;
}

function timeRangeElement(range: { start: string; end: string }): string {
  if (!TIME_RANGE.test(range.start) || !TIME_RANGE.test(range.end)) {
    throw new CalDavError("invalid_argument", 0, "time ranges must be UTC iCalendar timestamps");
  }
  if (range.start >= range.end) {
    throw new CalDavError("invalid_argument", 0, "the time range start must precede its end");
  }
  return `<C:time-range start="${range.start}" end="${range.end}"/>`;
}

function assertProps(props: readonly string[]): void {
  if (props.length === 0) {
    throw new CalDavError("invalid_argument", 0, "a propfind needs at least one property");
  }
  for (const prop of props) {
    if (!PROP_NAME.test(prop)) {
      throw new CalDavError("invalid_argument", 0, `invalid property name ${prop}`);
    }
  }
}

function encodeId(kind: string, value: string): string {
  if (!ID.test(value) || value === "." || value === "..") {
    throw new CalDavError("invalid_argument", 0, `invalid ${kind}`);
  }
  return encodeURIComponent(value);
}

function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function rejectDangerousMarkup(xml: string): void {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new CalDavError("malformed", 0, "refusing a CalDAV response with a DTD or entity declaration");
  }
}

function statusOf(value: unknown): number | null {
  const text = textOf(value);
  if (text === null) return null;
  const match = /^\s*(?:HTTP\/[\d.]+ )?(\d{3})\b/.exec(text);
  return match ? Number(match[1]) : null;
}

function textOf(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (isRecord(value)) {
    const text = value["#text"];
    if (typeof text === "string") return text;
    if (typeof text === "number") return String(text);
  }
  return null;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function httpError(status: number): CalDavError {
  switch (status) {
    case 401:
      return new CalDavError(
        "unauthorized",
        401,
        "iCloud rejected the credentials; the app-specific password may have been revoked",
      );
    case 403:
      return new CalDavError("forbidden", 403, "iCloud refused this request for the collection");
    case 404:
      return new CalDavError("not_found", 404, "the calendar resource was not found");
    case 409:
    case 412:
      return new CalDavError("conflict", status, "the resource changed since it was read");
    case 413:
      return new CalDavError("upstream_error", 413, "iCloud refused the request as too large");
    case 507:
      return new CalDavError("too_many_resources", 507, "iCloud refused the request: too much data");
    default:
      return new CalDavError("upstream_error", status, `iCloud answered HTTP ${status}`);
  }
}

function describeFetchError(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return `the CalDAV request timed out after ${timeoutMs}ms`;
  }
  return `the CalDAV request failed: ${messageOf(error)}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function envInt(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
