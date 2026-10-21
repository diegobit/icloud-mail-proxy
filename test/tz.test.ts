import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  daysInMonth,
  formatOffset,
  isoDate,
  isoInZone,
  isoWall,
  offsetMinutes,
  tryOffsetMinutes,
  wallClockInZone,
  wallClockToUtc,
  weekday,
  type WallClock,
} from "../src/tz";

function wall(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): WallClock {
  return { year, month, day, hour, minute, second };
}

describe("offsetMinutes", () => {
  it("reads Europe/Rome summer and winter offsets", () => {
    expect(offsetMinutes("Europe/Rome", Date.UTC(2026, 0, 15, 12))).toBe(60);
    expect(offsetMinutes("Europe/Rome", Date.UTC(2026, 6, 15, 12))).toBe(120);
  });

  it("reads non-hour offsets", () => {
    expect(offsetMinutes("Australia/Lord_Howe", Date.UTC(2026, 0, 15))).toBe(11 * 60);
    expect(offsetMinutes("Australia/Lord_Howe", Date.UTC(2026, 6, 15))).toBe(10 * 60 + 30);
    expect(offsetMinutes("Pacific/Chatham", Date.UTC(2026, 0, 15))).toBe(13 * 60 + 45);
  });

  it("reports UTC as zero", () => {
    expect(offsetMinutes("UTC", Date.UTC(2026, 0, 15))).toBe(0);
    expect(offsetMinutes("Etc/GMT", Date.UTC(2026, 0, 15))).toBe(0);
  });

  it("returns null for a zone Intl does not know", () => {
    expect(tryOffsetMinutes("Europe/Nowhere", 0)).toBeNull();
    expect(tryOffsetMinutes("../etc/passwd", 0)).toBeNull();
    expect(() => offsetMinutes("Europe/Nowhere", 0)).toThrow(RangeError);
  });
});

describe("wallClockToUtc in Europe/Rome", () => {
  it("maps ordinary winter and summer readings", () => {
    expect(wallClockToUtc("Europe/Rome", wall(2026, 1, 15, 12, 0))).toBe(Date.UTC(2026, 0, 15, 11));
    expect(wallClockToUtc("Europe/Rome", wall(2026, 7, 15, 12, 0))).toBe(Date.UTC(2026, 6, 15, 10));
  });

  it("moves a skipped spring-forward reading forward by the gap", () => {
    // 2026-03-29: 02:00 becomes 03:00. 02:30 does not exist and is read using
    // the offset before the gap (+01:00), so it lands at 03:30 local.
    const instant = wallClockToUtc("Europe/Rome", wall(2026, 3, 29, 2, 30));
    expect(instant).toBe(Date.UTC(2026, 2, 29, 1, 30));
    expect(wallClockInZone("Europe/Rome", instant)).toEqual(wall(2026, 3, 29, 3, 30));
  });

  it("resolves the repeated autumn reading to the first occurrence", () => {
    // 2026-10-25: 03:00 becomes 02:00. 02:30 happens twice: 00:30Z (+02:00)
    // and 01:30Z (+01:00). RFC 5545 says take the first.
    const first = wallClockToUtc("Europe/Rome", wall(2026, 10, 25, 2, 30));
    expect(first).toBe(Date.UTC(2026, 9, 25, 0, 30));
    expect(offsetMinutes("Europe/Rome", first)).toBe(120);
    expect(offsetMinutes("Europe/Rome", Date.UTC(2026, 9, 25, 1, 30))).toBe(60);
  });

  it("keeps the readings on either side of the transition correct", () => {
    expect(wallClockToUtc("Europe/Rome", wall(2026, 3, 29, 1, 30))).toBe(Date.UTC(2026, 2, 29, 0, 30));
    expect(wallClockToUtc("Europe/Rome", wall(2026, 3, 29, 3, 30))).toBe(Date.UTC(2026, 2, 29, 1, 30));
    expect(wallClockToUtc("Europe/Rome", wall(2026, 10, 25, 1, 30))).toBe(Date.UTC(2026, 9, 24, 23, 30));
    expect(wallClockToUtc("Europe/Rome", wall(2026, 10, 25, 3, 30))).toBe(Date.UTC(2026, 9, 25, 2, 30));
  });
});

describe("wallClockToUtc in Australia/Lord_Howe", () => {
  it("handles a thirty-minute fall-back", () => {
    // 2026-04-05: 02:00 becomes 01:30. 01:45 happens at 14:45Z (+11:00) and
    // 15:15Z (+10:30); the first occurrence wins.
    const first = wallClockToUtc("Australia/Lord_Howe", wall(2026, 4, 5, 1, 45));
    expect(first).toBe(Date.UTC(2026, 3, 4, 14, 45));
    expect(offsetMinutes("Australia/Lord_Howe", first)).toBe(11 * 60);
  });

  it("handles a thirty-minute spring-forward gap", () => {
    // 2026-10-04: 02:00 becomes 02:30. 02:15 is read with +10:30 and lands at
    // 02:45 local, not 01:45.
    const instant = wallClockToUtc("Australia/Lord_Howe", wall(2026, 10, 4, 2, 15));
    expect(instant).toBe(Date.UTC(2026, 9, 3, 15, 45));
    expect(wallClockInZone("Australia/Lord_Howe", instant)).toEqual(wall(2026, 10, 4, 2, 45));
  });
});

describe("ISO formatting", () => {
  it("formats a wall clock without a zone", () => {
    expect(isoWall(wall(2026, 1, 2, 3, 4, 5))).toBe("2026-01-02T03:04:05");
    expect(isoDate({ year: 2026, month: 1, day: 2 })).toBe("2026-01-02");
  });

  it("formats an instant with the zone offset", () => {
    expect(isoInZone(Date.UTC(2026, 6, 15, 12), "Europe/Rome")).toBe("2026-07-15T14:00:00+02:00");
    expect(isoInZone(Date.UTC(2026, 0, 15, 12), "Europe/Rome")).toBe("2026-01-15T13:00:00+01:00");
    expect(isoInZone(Date.UTC(2026, 0, 15, 12), "UTC")).toBe("2026-01-15T12:00:00Z");
    expect(isoInZone(Date.UTC(2026, 0, 15, 12), "Pacific/Chatham")).toBe(
      "2026-01-16T01:45:00+13:45",
    );
  });

  it("formats negative and half-hour offsets", () => {
    expect(formatOffset(0)).toBe("+00:00");
    expect(formatOffset(120)).toBe("+02:00");
    expect(formatOffset(-210)).toBe("-03:30");
    expect(() => formatOffset(24 * 60 + 1)).toThrow(RangeError);
  });

  it("round-trips an unambiguous instant through the zone's wall clock", () => {
    for (const instant of [
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 2, 29, 1, 30),
      Date.UTC(2026, 9, 25, 0, 30),
      Date.UTC(2026, 9, 25, 2, 30),
    ]) {
      expect(wallClockToUtc("Europe/Rome", wallClockInZone("Europe/Rome", instant))).toBe(instant);
    }
    // The second pass through 02:30 is deliberately not round-tripped: RFC
    // 5545 maps that reading to the first occurrence.
    expect(wallClockToUtc("Europe/Rome", wallClockInZone("Europe/Rome", Date.UTC(2026, 9, 25, 1, 30)))).toBe(
      Date.UTC(2026, 9, 25, 0, 30),
    );
  });
});

describe("date arithmetic", () => {
  it("adds days across months, years and leap days", () => {
    expect(addDays({ year: 2026, month: 12, day: 31 }, 1)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(addDays({ year: 2024, month: 2, day: 28 }, 1)).toEqual({ year: 2024, month: 2, day: 29 });
    expect(addDays({ year: 2025, month: 2, day: 28 }, 1)).toEqual({ year: 2025, month: 3, day: 1 });
    expect(addDays({ year: 2026, month: 1, day: 1 }, -1)).toEqual({ year: 2025, month: 12, day: 31 });
  });

  it("counts whole days between dates", () => {
    expect(daysBetween({ year: 2026, month: 1, day: 1 }, { year: 2026, month: 1, day: 2 })).toBe(1);
    expect(daysBetween({ year: 2024, month: 2, day: 28 }, { year: 2024, month: 3, day: 1 })).toBe(2);
    expect(daysBetween({ year: 2026, month: 1, day: 2 }, { year: 2026, month: 1, day: 1 })).toBe(-1);
  });

  it("reports the weekday with Sunday as zero", () => {
    expect(weekday({ year: 2026, month: 3, day: 29 })).toBe(0);
    expect(weekday({ year: 2026, month: 3, day: 30 })).toBe(1);
    expect(weekday({ year: 2026, month: 10, day: 21 })).toBe(3);
  });

  it("knows month lengths", () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it("refuses impossible dates", () => {
    expect(() => wallClockToUtc("UTC", wall(2026, 2, 30, 12, 0))).toThrow(RangeError);
    expect(() => wallClockToUtc("UTC", wall(2026, 13, 1, 12, 0))).toThrow(RangeError);
    expect(() => wallClockToUtc("UTC", wall(2026, 1, 1, 24, 0))).toThrow(RangeError);
  });
});
