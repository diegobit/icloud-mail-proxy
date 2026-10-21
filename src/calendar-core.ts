// Collection discovery for the CalDAV home: which calendars and reminder
// lists exist, what they are called, and whether this account may write them.
//
// A collection is usable only if its resourcetype contains C:calendar, it has a
// display name, and its component set is exactly one of VEVENT or VTODO. That
// excludes the home collection (collection only) and the inbox / notification /
// outbox pseudo-collections (no display name), and fails closed on a collection
// that claims both components.

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
import { calendarsEnabled, calendarConfig, reminderListsEnabled } from "./calendar-config";
import { ApiError } from "./core";
import type { Env } from "./types";

export type CollectionKind = "calendar" | "reminders";

export interface CollectionInfo {
  id: string;
  name: string;
  kind: CollectionKind;
  color: string | null;
  readOnly: boolean;
}

export interface CollectionOptions {
  /** Bootstrap mode: return every collection, before allowlist filtering. */
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

export async function discoverCollections(
  env: Env,
  options: CollectionOptions = {},
): Promise<CollectionInfo[]> {
  const caldav = createCalDav(env, { fetchImpl: options.fetchImpl });
  const { homeUrl } = await caldav.discover();
  const response = await caldav.propfind(homeUrl, propfind(COLLECTION_PROPERTIES), 1);
  const homePath = new URL(homeUrl).pathname;

  const collections: CollectionInfo[] = [];
  for (const entry of parseMultistatus(response.body)) {
    if (!resourcetypeKinds(entry).includes("calendar")) continue;
    const name = displayName(entry);
    if (name === null) continue;
    const components = componentNames(entry);
    const kind: CollectionKind | null =
      components.includes("VEVENT") && !components.includes("VTODO")
        ? "calendar"
        : components.includes("VTODO") && !components.includes("VEVENT")
          ? "reminders"
          : null;
    if (kind === null) continue;
    const id = idFromHref(entry.href, homePath);
    if (id === null) continue;
    collections.push({
      id,
      name,
      kind,
      color: propText(entry, "calendar-color"),
      readOnly: isReadOnly(entry),
    });
  }
  return collections;
}

export async function listCollections(
  env: Env,
  kind: CollectionKind,
  options: CollectionOptions = {},
): Promise<CollectionInfo[]> {
  if (!options.all) {
    if (kind === "calendar" && !calendarsEnabled(env)) return [];
    if (kind === "reminders" && !reminderListsEnabled(env)) return [];
  }
  const collections = await discoverCollections(env, options);
  const ofKind = collections.filter((collection) => collection.kind === kind);
  if (options.all) return ofKind;

  const allow = allowlistFor(env, kind);
  if (allow !== "*") assertAllowlistResolvable(allow, ofKind, kind);
  const allowed = allow === "*" ? ofKind : ofKind.filter((collection) => allow.includes(collection.name));
  return sortByName(allowed);
}

/**
 * Resolve a tool argument (a collection name) against the account and the
 * allowlist. Names are matched exactly; a name outside the allowlist is a
 * client error, a configured name with no collection fails closed.
 */
export async function resolveCollection(
  env: Env,
  kind: CollectionKind,
  name: string,
  options: CollectionOptions = {},
): Promise<CollectionInfo> {
  const allow = allowlistFor(env, kind);
  if (allow !== "*" && !allow.includes(name)) {
    throw new ApiError(
      400,
      kind === "calendar" ? "calendar_not_allowed" : "reminder_list_not_allowed",
      `not an allowed ${kind === "calendar" ? "calendar" : "reminder list"}: ${JSON.stringify(name)}`,
    );
  }

  const collections = (await discoverCollections(env, options)).filter((collection) => collection.kind === kind);
  if (allow !== "*") assertAllowlistResolvable(allow, collections, kind);

  const matches = collections.filter((collection) => collection.name === name);
  if (matches.length === 0) {
    throw new ApiError(
      500,
      kind === "calendar" ? "configured_calendar_missing" : "configured_reminder_list_missing",
      `no ${kind === "calendar" ? "calendar" : "reminder list"} named ${JSON.stringify(name)} exists in this account`,
    );
  }
  if (matches.length > 1) {
    throw new ApiError(
      409,
      "ambiguous_calendar_name",
      `more than one collection is named ${JSON.stringify(name)}`,
    );
  }
  return matches[0]!;
}

function allowlistFor(env: Env, kind: CollectionKind) {
  const config = calendarConfig(env);
  return kind === "calendar" ? config.calendars : config.reminderLists;
}

function assertAllowlistResolvable(
  allow: string[],
  collections: CollectionInfo[],
  kind: CollectionKind,
): void {
  for (const name of allow) {
    const matches = collections.filter((collection) => collection.name === name).length;
    if (matches === 0) {
      throw new ApiError(
        500,
        kind === "calendar" ? "configured_calendar_missing" : "configured_reminder_list_missing",
        `the configured ${kind === "calendar" ? "calendar" : "reminder list"} ${JSON.stringify(name)} does not exist in this account`,
      );
    }
    if (matches > 1) {
      throw new ApiError(
        409,
        "ambiguous_calendar_name",
        `more than one collection is named ${JSON.stringify(name)}`,
      );
    }
  }
}

function sortByName(collections: CollectionInfo[]): CollectionInfo[] {
  return [...collections].sort((a, b) => a.name.localeCompare(b.name));
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
