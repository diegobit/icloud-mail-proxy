// One-resource read for calendar events.
//
// iCloud requires absolute pathname hrefs in a calendar-multiget, so the home
// URL from discovery is needed even though the collection path is already
// known. The multiget returns the ETag and the data in one round trip; an
// update later needs both, and a read must not invent an ETag when the server
// omitted one.

import {
  CalDavError,
  calendarMultiget,
  collectionPath,
  createCalDav,
  parseMultistatus,
  propText,
  resourcePath,
  type DavResponse,
} from "./caldav";
import { calendarLimits, type CalendarLimits } from "./calendar-config";
import type { CollectionInfo } from "./calendar-core";
import { ApiError } from "./core";
import type { IcalCaps, ParsedResource } from "./ical";
import type { Env } from "./types";

const RESOURCE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ETAG = /^(?:W\/)?"[\x20-\x21\x23-\x7e]*"$/;

export type ReadOnlyReason = "recurring" | "scheduling";

export interface ResourceReadOptions {
  /** Injected for tests; production uses the Worker's fetch. */
  fetchImpl?: typeof fetch;
}

export interface ResourceContent {
  ics: string;
  etag: string;
}

export function isResourceId(value: string): boolean {
  return RESOURCE_ID.test(value) && value !== "." && value !== "..";
}

const STRONG_ETAG = /^"[\x20-\x21\x23-\x7e]*"$/;

/**
 * Validate the ETag a caller passes back for an update. Reads tolerate a weak
 * ETag, but If-Match needs exactly one strong, quoted tag.
 */
export function assertStrongEtag(value: string): string {
  if (!STRONG_ETAG.test(value)) {
    throw new ApiError(
      400,
      "invalid_etag",
      "etag must be exactly one strong, quoted ETag returned by get_event; " +
        "W/, *, and comma-separated lists are refused",
    );
  }
  return value;
}

export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/** The resource id from a response href, or null if it is not one in this collection. */
export function resourceIdFromHref(href: string, collectionId: string): string | null {
  let url: URL;
  try {
    url = new URL(href, "https://caldav.icloud.com/");
  } catch {
    return null;
  }
  const marker = `/${collectionId}/`;
  const index = url.pathname.lastIndexOf(marker);
  if (index === -1) return null;
  const tail = url.pathname.slice(index + marker.length);
  if (tail === "" || tail.includes("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(tail);
  } catch {
    return null;
  }
  if (!decoded.endsWith(".ics")) return null;
  const id = decoded.slice(0, -4);
  return isResourceId(id) ? id : null;
}

/** The trimmed calendar-data of one multistatus response, or null if it has none. */
export function calendarData(response: DavResponse): string | null {
  const raw = propText(response, "calendar-data");
  return raw === null ? null : raw.trim();
}

export function icalCaps(limits: CalendarLimits): IcalCaps {
  return {
    maxRdateExdate: limits.maxRdateExdate,
    maxRecurrenceCandidatesPerRule: limits.maxRecurrenceCandidatesPerRule,
    maxRecurrenceCandidatesPerRequest: limits.maxRecurrenceCandidatesPerRequest,
    maxOccurrencesPerResource: limits.maxOccurrencesPerResource,
  };
}

export function readOnlyReasonOf(parsed: ParsedResource): ReadOnlyReason | null {
  if (parsed.recurring) return "recurring";
  if (parsed.scheduling) return "scheduling";
  return null;
}

/** Read one resource with calendar-multiget, enforcing the byte cap and ETag contract. */
export async function readResource(
  env: Env,
  collection: CollectionInfo,
  id: string,
  options: ResourceReadOptions = {},
): Promise<ResourceContent> {
  const label = "event";
  const limits = calendarLimits(env);
  const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
  const { homeUrl } = await caldav.discover();
  const href = new URL(resourcePath(collection.id, id), homeUrl).pathname;
  const response = await caldav.report(
    collectionPath(collection.id),
    calendarMultiget([href]),
    1,
  );
  const entries = parseMultistatus(response.body);

  let match: DavResponse | null = null;
  for (const entry of entries) {
    if (resourceIdFromHref(entry.href, collection.id) !== id) {
      throw new CalDavError(
        "malformed",
        0,
        `the calendar-multiget returned an unrelated href for the ${label}`,
      );
    }
    if (match !== null) {
      throw new CalDavError(
        "malformed",
        0,
        `the calendar-multiget returned the ${label} more than once`,
      );
    }
    match = entry;
  }
  if (match === null || match.status === 404) {
    throw new CalDavError("not_found", 404, `the ${label} ${JSON.stringify(id)} was not found`);
  }
  if (match.status !== null && match.status >= 400) {
    throw new CalDavError(
      match.status === 403 ? "forbidden" : "upstream_error",
      match.status,
      `iCloud returned ${match.status} for the ${label} ${JSON.stringify(id)}`,
    );
  }

  const ics = calendarData(match);
  if (ics === null) {
    throw new CalDavError("malformed", 0, `the ${label} response has no calendar-data`);
  }
  const bytes = byteLength(ics);
  if (bytes > limits.maxResourceBytes) {
    throw new ApiError(
      422,
      "resource_too_large",
      `resource ${JSON.stringify(id)} is ${bytes} bytes; MAX_RESOURCE_BYTES is ` +
        `${limits.maxResourceBytes}.`,
    );
  }

  const etag = propText(match, "getetag")?.trim() ?? "";
  if (etag === "" || !ETAG.test(etag)) {
    throw new CalDavError("malformed", 0, `the ${label} has no usable ETag`);
  }
  return { ics, etag };
}
