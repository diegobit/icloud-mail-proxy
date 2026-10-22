// Collection discovery for the CalDAV home: which calendars exist, what they
// are called, and whether this account may write them.
//
// A calendar is usable only if its resourcetype contains C:calendar, it has a
// display name, and its component set is exactly VEVENT. That excludes the
// home collection (collection only) and the inbox / notification / outbox
// pseudo-collections (no display name), and fails closed on a collection that
// is not a plain event calendar.

import {
  componentNames,
  createCalDav,
  displayName,
  parseMultistatus,
  propText,
  propValue,
  propfind,
  resourcetypeKinds,
  type DavResponse,
} from "./caldav";
import { calendarsEnabled, calendarConfig } from "./calendar-config";
import { ApiError } from "./core";
import type { Env } from "./types";

export interface CollectionInfo {
  id: string;
  name: string;
  kind: "calendar";
  color: string | null;
  readOnly: boolean;
}

export interface CollectionOptions {
  /** Bootstrap mode: return every calendar, before allowlist filtering. */
  all?: boolean;
  /** Injected for tests; production uses the Worker's fetch. */
  fetchImpl?: typeof fetch;
}

const COLLECTION_PROPERTIES = [
  "D:resourcetype",
  "D:displayname",
  "D:current-user-privilege-set",
  "C:supported-calendar-component-set",
  "A:calendar-color",
];

const ID = /^[A-Za-z0-9._-]{1,128}$/;

export async function discoverCalendars(
  env: Env,
  options: CollectionOptions = {},
): Promise<CollectionInfo[]> {
  const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
  const { homeUrl } = await caldav.discover();
  const response = await caldav.propfind(homeUrl, propfind(COLLECTION_PROPERTIES), 1);
  const homePath = new URL(homeUrl).pathname;

  const calendars: CollectionInfo[] = [];
  for (const entry of parseMultistatus(response.body)) {
    if (!resourcetypeKinds(entry).includes("calendar")) continue;
    const name = displayName(entry);
    if (name === null) continue;
    const components = componentNames(entry);
    if (!components.includes("VEVENT") || components.includes("VTODO")) continue;
    const id = idFromHref(entry.href, homePath);
    if (id === null) continue;
    calendars.push({
      id,
      name,
      kind: "calendar",
      color: propText(entry, "calendar-color"),
      readOnly: isReadOnly(entry),
    });
  }
  return calendars;
}

export async function listCalendars(
  env: Env,
  options: CollectionOptions = {},
): Promise<CollectionInfo[]> {
  if (!options.all && !calendarsEnabled(env)) return [];
  const calendars = await discoverCalendars(env, options);
  if (options.all) return calendars;

  const allow = calendarConfig(env).calendars;
  if (allow !== "*") assertAllowlistResolvable(allow, calendars);
  const allowed = allow === "*" ? calendars : calendars.filter((calendar) => allow.includes(calendar.name));
  return sortByName(allowed);
}

/**
 * Resolve a tool argument (a calendar name) against the account and the
 * allowlist. Names are matched exactly; a name outside the allowlist is a
 * client error, a configured name with no calendar fails closed.
 */
export async function resolveCalendar(
  env: Env,
  name: string,
  options: CollectionOptions = {},
): Promise<CollectionInfo> {
  const allow = calendarConfig(env).calendars;
  if (allow !== "*" && !allow.includes(name)) {
    throw new ApiError(
      400,
      "calendar_not_allowed",
      `not an allowed calendar: ${JSON.stringify(name)}`,
    );
  }

  const calendars = await discoverCalendars(env, options);
  if (allow !== "*") assertAllowlistResolvable(allow, calendars);

  const matches = calendars.filter((calendar) => calendar.name === name);
  if (matches.length === 0) {
    throw new ApiError(
      500,
      "configured_calendar_missing",
      `no calendar named ${JSON.stringify(name)} exists in this account`,
    );
  }
  if (matches.length > 1) {
    throw new ApiError(
      409,
      "ambiguous_calendar_name",
      `more than one calendar is named ${JSON.stringify(name)}`,
    );
  }
  return matches[0]!;
}

function assertAllowlistResolvable(allow: string[], calendars: CollectionInfo[]): void {
  for (const name of allow) {
    const matches = calendars.filter((calendar) => calendar.name === name).length;
    if (matches === 0) {
      throw new ApiError(
        500,
        "configured_calendar_missing",
        `the configured calendar ${JSON.stringify(name)} does not exist in this account`,
      );
    }
    if (matches > 1) {
      throw new ApiError(
        409,
        "ambiguous_calendar_name",
        `more than one calendar is named ${JSON.stringify(name)}`,
      );
    }
  }
}

function sortByName(calendars: CollectionInfo[]): CollectionInfo[] {
  return [...calendars].sort((a, b) => a.name.localeCompare(b.name));
}

function idFromHref(href: string, homePath: string): string | null {
  let url: URL;
  try {
    url = new URL(href, "https://caldav.icloud.com/");
  } catch {
    return null;
  }
  if (!url.pathname.startsWith(homePath)) return null;
  const rest = url.pathname.slice(homePath.length);
  if (!rest.endsWith("/")) return null;
  const id = rest.slice(0, -1);
  if (id === "" || id.includes("/")) return null;
  if (!ID.test(id) || id === "." || id === "..") return null;
  return id;
}

function isReadOnly(entry: DavResponse): boolean {
  const privileges = privilegeNames(entry);
  return !privileges.some((name) => name === "write" || name === "write-content" || name === "bind");
}

function privilegeNames(entry: DavResponse): string[] {
  const value = propValue(entry, "current-user-privilege-set");
  if (!isRecord(value)) return [];
  const privileges = Array.isArray(value.privilege)
    ? value.privilege
    : value.privilege === undefined
      ? []
      : [value.privilege];
  const names: string[] = [];
  for (const privilege of privileges) {
    if (!isRecord(privilege)) continue;
    for (const key of Object.keys(privilege)) {
      if (!key.startsWith("@_") && key !== "#text") names.push(key);
    }
  }
  return names;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
