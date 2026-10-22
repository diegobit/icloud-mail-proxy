// Runtime configuration for the calendar surface (plans/calendar-reminders.md).
//
// An allowlist is either a comma-separated list of calendar names or the
// single value `*`. Names are matched exactly after trimming, because Apple
// lets the owner rename calendars and the allowlist is a policy, not a
// pattern. An empty value disables the domain: no tools, no routes, no scopes.
// `*` must be alone: `*,Lavoro` is a configuration error, not a superset.

import type { Env } from "./types";
import type { ResourceScope, Scope } from "./scopes";

export type Allowlist = "*" | string[];

export interface CalendarConfig {
  calendars: Allowlist;
  calendarWrite: boolean;
}

export interface CalendarLimits {
  maxCalendarDays: number;
  maxEventResults: number;
  maxResourceBytes: number;
  maxResourcesPerQuery: number;
  maxOccurrencesPerResource: number;
  maxRdateExdate: number;
  maxRecurrenceCandidatesPerRule: number;
  maxRecurrenceCandidatesPerRequest: number;
}

/** The zone used when a tool argument omits `timeZone`. */
export const DEFAULT_TIME_ZONE = "Europe/Rome";

export function parseAllowlist(value: string | undefined, variable: string): Allowlist {
  const names = (value ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (names.length === 0) return [];
  if (names.includes("*")) {
    if (names.length > 1) {
      throw new Error(`${variable} must be "*" alone or a comma-separated list of names`);
    }
    return "*";
  }
  return [...new Set(names)];
}

export function calendarConfig(env: Env): CalendarConfig {
  return {
    calendars: parseAllowlist(env.ALLOWED_CALENDARS, "ALLOWED_CALENDARS"),
    calendarWrite: env.CALENDAR_WRITE === "1",
  };
}

export function calendarsEnabled(env: Env): boolean {
  const calendars = calendarConfig(env).calendars;
  return Array.isArray(calendars) ? calendars.length > 0 : true;
}

/** Writes exist only when the domain is enabled and its write flag is on. */
export function calendarWritesEnabled(env: Env): boolean {
  return calendarsEnabled(env) && calendarConfig(env).calendarWrite;
}

/** The resource scopes this deployment can actually offer. */
export function enabledResourceScopes(env: Env): ResourceScope[] {
  const config = calendarConfig(env);
  const scopes: ResourceScope[] = ["mail:read"];
  if (calendarsEnabled(env)) {
    scopes.push("calendar:read");
    if (config.calendarWrite) scopes.push("calendar:write");
  }
  return scopes;
}

/** What the provider advertises on the authorization server. */
export function supportedScopes(env: Env): Scope[] {
  return [...enabledResourceScopes(env), "offline_access"];
}

/**
 * The minimal set published for the protected resource and named in the 401
 * challenge. Advertised, not enforced: the per-tool matrix decides.
 */
export function requiredScopes(env: Env): ResourceScope[] {
  const scopes: ResourceScope[] = ["mail:read"];
  if (calendarsEnabled(env)) scopes.push("calendar:read");
  return scopes;
}

/** Stable fingerprint of the offered scope set, used in the provider cache key. */
export function scopeProfile(env: Env): string {
  return enabledResourceScopes(env).join(",");
}

export function calendarLimits(env: Env): CalendarLimits {
  return {
    maxCalendarDays: positiveInt(env.MAX_CALENDAR_DAYS, 90, 1, 366),
    maxEventResults: positiveInt(env.MAX_EVENT_RESULTS, 50, 1, 200),
    maxResourceBytes: positiveInt(env.MAX_RESOURCE_BYTES, 262_144, 1024, 2 * 1024 * 1024),
    maxResourcesPerQuery: positiveInt(env.MAX_RESOURCES_PER_QUERY, 300, 1, 1000),
    maxOccurrencesPerResource: positiveInt(env.MAX_OCCURRENCES_PER_RESOURCE, 200, 1, 1000),
    maxRdateExdate: positiveInt(env.MAX_RDATE_EXDATE, 500, 0, 5000),
    maxRecurrenceCandidatesPerRule: positiveInt(env.MAX_RECURRENCE_CANDIDATES_PER_RULE, 50_000, 1, 500_000),
    maxRecurrenceCandidatesPerRequest: positiveInt(
      env.MAX_RECURRENCE_CANDIDATES_PER_REQUEST,
      200_000,
      1,
      2_000_000,
    ),
  };
}

function positiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) return fallback;
  return Math.min(max, parsed);
}
