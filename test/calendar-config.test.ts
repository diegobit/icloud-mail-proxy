import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIME_ZONE,
  calendarConfig,
  calendarLimits,
  calendarWritesEnabled,
  calendarsEnabled,
  enabledResourceScopes,
  parseAllowlist,
  requiredScopes,
  scopeProfile,
  supportedScopes,
} from "../src/calendar-config";
import type { Env } from "../src/types";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { API_TOKEN: "token", ...overrides } as unknown as Env;
}

describe("parseAllowlist", () => {
  it("turns an empty or missing value into an empty list", () => {
    expect(parseAllowlist(undefined, "ALLOWED_CALENDARS")).toEqual([]);
    expect(parseAllowlist("", "ALLOWED_CALENDARS")).toEqual([]);
    expect(parseAllowlist(" , , ", "ALLOWED_CALENDARS")).toEqual([]);
  });

  it("trims, drops empty entries and deduplicates names", () => {
    expect(parseAllowlist(" Lavoro, Personale ,Lavoro,", "ALLOWED_CALENDARS")).toEqual([
      "Lavoro",
      "Personale",
    ]);
  });

  it("accepts * alone", () => {
    expect(parseAllowlist("*", "ALLOWED_CALENDARS")).toBe("*");
    expect(parseAllowlist(" * ", "ALLOWED_CALENDARS")).toBe("*");
  });

  it("refuses * mixed with names", () => {
    expect(() => parseAllowlist("*,Lavoro", "ALLOWED_CALENDARS")).toThrow(
      'ALLOWED_CALENDARS must be "*" alone',
    );
    expect(() => parseAllowlist("Lavoro,*", "ALLOWED_CALENDARS")).toThrow();
    expect(() => parseAllowlist("*,*", "ALLOWED_CALENDARS")).toThrow();
  });
});

describe("calendarConfig", () => {
  it("keeps calendars disabled by default", () => {
    const config = calendarConfig(makeEnv());
    expect(config).toEqual({ calendars: [], calendarWrite: false });
    expect(calendarsEnabled(makeEnv())).toBe(false);
  });

  it("enables calendars with names or *", () => {
    expect(calendarsEnabled(makeEnv({ ALLOWED_CALENDARS: "Lavoro" }))).toBe(true);
    expect(calendarsEnabled(makeEnv({ ALLOWED_CALENDARS: "*" }))).toBe(true);
  });

  it("reads the write flag only as 1", () => {
    expect(calendarConfig(makeEnv({ CALENDAR_WRITE: "1" })).calendarWrite).toBe(true);
    expect(calendarConfig(makeEnv({ CALENDAR_WRITE: "true" })).calendarWrite).toBe(false);
    expect(calendarConfig(makeEnv({ CALENDAR_WRITE: "0" })).calendarWrite).toBe(false);
  });

  it("runs writes only when calendars are enabled and the flag is on", () => {
    expect(calendarWritesEnabled(makeEnv({ ALLOWED_CALENDARS: "*", CALENDAR_WRITE: "1" }))).toBe(true);
    expect(calendarWritesEnabled(makeEnv({ ALLOWED_CALENDARS: "", CALENDAR_WRITE: "1" }))).toBe(false);
    expect(calendarWritesEnabled(makeEnv({ ALLOWED_CALENDARS: "*", CALENDAR_WRITE: "0" }))).toBe(false);
  });

  it("passes a malformed allowlist through as a configuration error", () => {
    expect(() => calendarConfig(makeEnv({ ALLOWED_CALENDARS: "*,Lavoro" }))).toThrow();
  });
});

describe("scopes", () => {
  it("offers only mail:read when calendars are disabled", () => {
    expect(enabledResourceScopes(makeEnv())).toEqual(["mail:read"]);
    expect(supportedScopes(makeEnv())).toEqual(["mail:read", "offline_access"]);
    expect(requiredScopes(makeEnv())).toEqual(["mail:read"]);
  });

  it("adds calendar read scope for enabled calendars", () => {
    const env = makeEnv({ ALLOWED_CALENDARS: "*" });
    expect(enabledResourceScopes(env)).toEqual(["mail:read", "calendar:read"]);
    expect(requiredScopes(env)).toEqual(["mail:read", "calendar:read"]);
  });

  it("adds the write scope only when the write flag is on", () => {
    const reads = makeEnv({ ALLOWED_CALENDARS: "*" });
    expect(enabledResourceScopes(reads)).toEqual(["mail:read", "calendar:read"]);

    const writes = makeEnv({ ALLOWED_CALENDARS: "*", CALENDAR_WRITE: "1" });
    expect(enabledResourceScopes(writes)).toEqual([
      "mail:read",
      "calendar:read",
      "calendar:write",
      "calendar:delete",
    ]);
    expect(supportedScopes(writes)).toContain("calendar:delete");
    expect(supportedScopes(writes)).toContain("offline_access");
  });

  it("does not offer the write scope for disabled calendars", () => {
    expect(enabledResourceScopes(makeEnv({ CALENDAR_WRITE: "1" }))).toEqual(["mail:read"]);
  });

  it("keeps requiredScopes free of write scopes", () => {
    const env = makeEnv({ ALLOWED_CALENDARS: "*", CALENDAR_WRITE: "1" });
    expect(requiredScopes(env)).toEqual(["mail:read", "calendar:read"]);
  });

  it("fingerprints the enabled scopes for the provider cache", () => {
    const calendarOnly = makeEnv({ ALLOWED_CALENDARS: "*" });
    expect(scopeProfile(calendarOnly)).toBe("mail:read,calendar:read");
    expect(scopeProfile(calendarOnly)).toBe(scopeProfile(calendarOnly));

    const writes = makeEnv({ ALLOWED_CALENDARS: "*", CALENDAR_WRITE: "1" });
    expect(scopeProfile(writes)).toBe(
      "mail:read,calendar:read,calendar:write,calendar:delete",
    );
  });
});

describe("calendarLimits", () => {
  it("returns the documented defaults", () => {
    expect(calendarLimits(makeEnv())).toEqual({
      maxCalendarDays: 90,
      maxEventResults: 50,
      maxResourceBytes: 262144,
      maxResourcesPerQuery: 300,
      maxOccurrencesPerResource: 200,
      maxRdateExdate: 500,
      maxRecurrenceCandidatesPerRule: 50000,
      maxRecurrenceCandidatesPerRequest: 200000,
    });
    expect(DEFAULT_TIME_ZONE).toBe("Europe/Rome");
  });

  it("reads valid overrides and clamps them", () => {
    expect(calendarLimits(makeEnv({ MAX_CALENDAR_DAYS: "31" })).maxCalendarDays).toBe(31);
    expect(calendarLimits(makeEnv({ MAX_CALENDAR_DAYS: "9999" })).maxCalendarDays).toBe(366);
    expect(calendarLimits(makeEnv({ MAX_EVENT_RESULTS: "1000" })).maxEventResults).toBe(200);
    expect(calendarLimits(makeEnv({ MAX_RDATE_EXDATE: "0" })).maxRdateExdate).toBe(0);
  });

  it("falls back for malformed, negative or too-small values", () => {
    for (const value of ["", "abc", "-1", "0", "1.5"]) {
      expect(calendarLimits(makeEnv({ MAX_EVENT_RESULTS: value })).maxEventResults).toBe(50);
    }
    expect(calendarLimits(makeEnv({ MAX_RESOURCE_BYTES: "1" })).maxResourceBytes).toBe(262144);
  });
});
