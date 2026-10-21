import ICAL from "ical.js";
import { describe, expect, it } from "vitest";
import { CalDavError } from "../src/caldav";
import {
  createRecurrenceBudget,
  expandResource,
  mutateResource,
  parseResource,
  type ExpandedOccurrence,
} from "../src/ical";
import { isoInZone } from "../src/tz";

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Rome",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

function calendar(...components: string[]): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//icloud-mail-proxy test//EN",
    ...components,
    "END:VCALENDAR",
  ].join("\r\n");
}

function vevent(...lines: string[]): string {
  return ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
}

function vtodo(...lines: string[]): string {
  return ["BEGIN:VTODO", ...lines, "END:VTODO"].join("\r\n");
}

function event(uid: string, ...lines: string[]): string {
  return vevent(`UID:${uid}`, "DTSTAMP:20260101T000000Z", ...lines);
}

function expand(
  source: string,
  from: string,
  to: string,
  options: { budget?: ReturnType<typeof createRecurrenceBudget>; maxCandidates?: number } = {},
): { occurrences: ExpandedOccurrence[]; truncated: boolean; unsupportedRange: boolean } {
  const parsed = parseResource(source, {
    maxRecurrenceCandidatesPerRule: options.maxCandidates ?? 50_000,
  });
  return expandResource(parsed, {
    from: Date.parse(from),
    to: Date.parse(to),
    timeZone: "Europe/Rome",
    budget: options.budget,
    maxRecurrenceCandidatesPerRule: options.maxCandidates ?? 50_000,
  });
}

function codes(source: string): string {
  try {
    parseResource(source);
  } catch (error) {
    expect(error).toBeInstanceOf(CalDavError);
    return (error as CalDavError).code;
  }
  throw new Error("expected the resource to be refused");
}

describe("parseResource", () => {
  it("reads a TZID event with its rule, alarm and description", () => {
    const source = calendar(
      VTIMEZONE,
      event(
        "evt-1",
        "DTSTART;TZID=Europe/Rome:20260323T100000",
        "DTEND;TZID=Europe/Rome:20260323T110000",
        "SUMMARY:Weekly sync",
        "DESCRIPTION:Line one\\nLine two",
        "LOCATION:Office",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:Reminder",
        "TRIGGER:-PT15M",
        "END:VALARM",
      ),
    );
    const parsed = parseResource(source);

    expect(parsed.kind).toBe("VEVENT");
    expect(parsed.uid).toBe("evt-1");
    expect(parsed.recurring).toBe(true);
    expect(parsed.scheduling).toBe(false);
    expect(parsed.unsupportedRange).toBe(false);
    expect(parsed.master.start).toMatchObject({
      dateOnly: false,
      timeZone: "Europe/Rome",
      unresolved: false,
    });
    expect(parsed.master.start!.wall).toEqual({
      year: 2026,
      month: 3,
      day: 23,
      hour: 10,
      minute: 0,
      second: 0,
    });
    // 23 March is before the spring transition, so Rome is +01:00.
    expect(isoInZone(parsed.master.start!.utc!, "Europe/Rome")).toBe("2026-03-23T10:00:00+01:00");
    expect(parsed.master.end!.utc! - parsed.master.start!.utc!).toBe(3_600_000);
    expect(parsed.master.rruleText).toBe("FREQ=WEEKLY;BYDAY=MO;COUNT=4");
    expect(parsed.master.summary).toBe("Weekly sync");
    expect(parsed.master.description).toBe("Line one\nLine two");
    expect(parsed.master.location).toBe("Office");
    expect(parsed.master.alarms).toBe(1);
  });

  it("reads a UTC event without claiming a zone", () => {
    const parsed = parseResource(
      calendar(event("evt-utc", "DTSTART:20261021T080000Z", "DTEND:20261021T090000Z", "SUMMARY:UTC")),
    );
    expect(parsed.master.start).toMatchObject({ timeZone: null, unresolved: false });
    expect(parsed.master.start!.utc).toBe(Date.UTC(2026, 9, 21, 8));
    expect(parsed.master.start!.wall.hour).toBe(8);
  });

  it("reads an all-day event with an exclusive end", () => {
    const parsed = parseResource(
      calendar(
        event(
          "evt-day",
          "DTSTART;VALUE=DATE:20261021",
          "DTEND;VALUE=DATE:20261023",
          "SUMMARY:Two days",
        ),
      ),
    );
    expect(parsed.master.allDay).toBe(true);
    expect(parsed.master.start).toMatchObject({ dateOnly: true, utc: null });
    expect(parsed.master.start!.wall).toMatchObject({ year: 2026, month: 10, day: 21, hour: 0 });
    expect(parsed.master.durationDays).toBe(2);
  });

  it("defaults an all-day event without DTEND to one day", () => {
    const parsed = parseResource(
      calendar(event("evt-day", "DTSTART;VALUE=DATE:20261021", "SUMMARY:One day")),
    );
    expect(parsed.master.durationDays).toBe(1);
    expect(parsed.master.durationMs).toBeNull();
  });

  it("keeps a floating time floating", () => {
    const parsed = parseResource(
      calendar(event("evt-float", "DTSTART:20261021T100000", "DTEND:20261021T110000")),
    );
    expect(parsed.master.start).toMatchObject({ timeZone: null, utc: null, unresolved: false });
  });

  it("keeps an unknown TZID wall time and flags it", () => {
    const parsed = parseResource(
      calendar(
        event(
          "evt-nowhere",
          "DTSTART;TZID=Europe/Nowhere:20261021T100000",
          "DTEND;TZID=Europe/Nowhere:20261021T110000",
        ),
      ),
    );
    expect(parsed.master.start).toMatchObject({
      timeZone: "Europe/Nowhere",
      utc: null,
      unresolved: true,
    });
    expect(parsed.master.start!.wall.hour).toBe(10);
  });

  it("reads a VTODO's due date, status, priority and completion", () => {
    const parsed = parseResource(
      calendar(
        vtodo(
          "UID:todo-1",
          "DTSTAMP:20260101T000000Z",
          "SUMMARY:Buy milk",
          "DUE;VALUE=DATE:20261023",
          "STATUS:NEEDS-ACTION",
          "PRIORITY:5",
          "PERCENT-COMPLETE:40",
        ),
      ),
    );
    expect(parsed.kind).toBe("VTODO");
    expect(parsed.master.start).toBeNull();
    expect(parsed.master.due).toMatchObject({ dateOnly: true, utc: null });
    expect(parsed.master.status).toBe("NEEDS-ACTION");
    expect(parsed.master.priority).toBe(5);
    expect(parsed.master.percentComplete).toBe(40);
    expect(parsed.master.allDay).toBe(true);
  });

  it("reads an override and its RECURRENCE-ID", () => {
    const parsed = parseResource(
      calendar(
        VTIMEZONE,
        event(
          "evt-1",
          "DTSTART;TZID=Europe/Rome:20260323T100000",
          "DTEND;TZID=Europe/Rome:20260323T110000",
          "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4",
          "SUMMARY:Weekly sync",
        ),
        vevent(
          "UID:evt-1",
          "RECURRENCE-ID;TZID=Europe/Rome:20260330T100000",
          "DTSTART;TZID=Europe/Rome:20260330T113000",
          "DTEND;TZID=Europe/Rome:20260330T123000",
          "SUMMARY:Moved sync",
        ),
      ),
    );
    expect(parsed.overrides).toHaveLength(1);
    expect(parsed.overrides[0]!.recurrenceId).toMatchObject({
      timeZone: "Europe/Rome",
      unresolved: false,
    });
    expect(parsed.overrides[0]!.recurrenceId!.utc).toBe(Date.UTC(2026, 2, 30, 8));
    expect(parsed.overrides[0]!.start!.utc).toBe(Date.UTC(2026, 2, 30, 9, 30));
    expect(parsed.overrides[0]!.summary).toBe("Moved sync");
    expect(parsed.recurring).toBe(true);
  });

  it("detects scheduling properties in any component", () => {
    const parsed = parseResource(
      calendar(
        event(
          "evt-1",
          "DTSTART:20261021T080000Z",
          "ORGANIZER:mailto:owner@example.com",
          "ATTENDEE:mailto:guest@example.com",
        ),
      ),
    );
    expect(parsed.scheduling).toBe(true);
  });

  it("detects RANGE=THISANDFUTURE rather than guessing", () => {
    const parsed = parseResource(
      calendar(
        event("evt-1", "DTSTART:20261101T100000Z", "RRULE:FREQ=WEEKLY;COUNT=3"),
        vevent(
          "UID:evt-1",
          "RECURRENCE-ID;RANGE=THISANDFUTURE:20261108T100000Z",
          "DTSTART:20261108T110000Z",
        ),
      ),
    );
    expect(parsed.unsupportedRange).toBe(true);
    expect(parsed.overrides[0]!.rangeThisAndFuture).toBe(true);
  });

  it("refuses a resource whose components disagree on UID", () => {
    expect(
      codes(
        calendar(
          event("one", "DTSTART:20261021T080000Z"),
          vevent("UID:two", "RECURRENCE-ID:20261021T080000Z", "DTSTART:20261021T090000Z"),
        ),
      ),
    ).toBe("malformed");
  });

  it("refuses a resource with two masters", () => {
    expect(
      codes(
        calendar(
          event("same", "DTSTART:20261021T080000Z"),
          event("same", "DTSTART:20261022T080000Z"),
        ),
      ),
    ).toBe("malformed");
  });

  it("refuses an override without a master", () => {
    expect(
      codes(
        calendar(
          vevent(
            "UID:orphan",
            "RECURRENCE-ID:20261021T080000Z",
            "DTSTART:20261021T090000Z",
          ),
        ),
      ),
    ).toBe("malformed");
  });

  it("refuses a resource with both VEVENT and VTODO", () => {
    expect(
      codes(
        calendar(
          event("one", "DTSTART:20261021T080000Z"),
          vtodo("UID:one", "DUE;VALUE=DATE:20261021"),
        ),
      ),
    ).toBe("malformed");
  });
});

describe("recurrence rule refusals", () => {
  const rules: Array<[string, string]> = [
    ["sub-daily frequency", "FREQ=SECONDLY"],
    ["huge interval", "FREQ=DAILY;INTERVAL=2147483647"],
    ["BYSETPOS", "FREQ=MONTHLY;BYDAY=MO;BYSETPOS=1"],
    ["BYHOUR", "FREQ=DAILY;BYHOUR=9"],
    ["BYWEEKNO", "FREQ=YEARLY;BYWEEKNO=1"],
    ["impossible month/day", "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30"],
    ["BYMONTHDAY with WEEKLY", "FREQ=WEEKLY;BYMONTHDAY=1"],
    ["ordinal BYDAY with WEEKLY", "FREQ=WEEKLY;BYDAY=1MO"],
    ["COUNT above one thousand", "FREQ=DAILY;COUNT=1001"],
    ["UNTIL beyond ten years", "FREQ=DAILY;UNTIL=20400101T000000Z"],
    ["COUNT and UNTIL together", "FREQ=DAILY;COUNT=2;UNTIL=20270101T000000Z"],
    ["zero BYMONTHDAY", "FREQ=MONTHLY;BYMONTHDAY=0"],
    ["UNTIL without UTC", "FREQ=DAILY;UNTIL=20270101T000000"],
  ];

  it.each(rules)("refuses %s", (_name, rule) => {
    expect(
      codes(
        calendar(
          event(
            "evt-1",
            "DTSTART:20260101T100000Z",
            "RRULE:" + rule,
          ),
        ),
      ),
    ).toBe("recurrence_too_complex");
  });

  it("refuses an RDATE list above the cap", () => {
    const values = Array.from({ length: 10_001 }, () => "20260102T100000Z").join(",");
    expect(
      codes(
        calendar(
          event("evt-1", "DTSTART:20260101T100000Z", "RDATE:" + values),
        ),
      ),
    ).toBe("recurrence_too_complex");
  });

  it("refuses an RDATE PERIOD value", () => {
    expect(
      codes(
        calendar(
          event(
            "evt-1",
            "DTSTART:20260101T100000Z",
            "RDATE;VALUE=PERIOD:20260102T100000Z/20260102T110000Z",
          ),
        ),
      ),
    ).toBe("recurrence_too_complex");
  });

  it("refuses an RDATE whose value type differs from DTSTART", () => {
    expect(
      codes(
        calendar(
          event("evt-1", "DTSTART:20260101T100000Z", "RDATE;VALUE=DATE:20260102"),
        ),
      ),
    ).toBe("malformed");
  });
});

describe("expandResource", () => {
  it("keeps a weekly Rome series at 10:00 across the DST change", () => {
    const source = calendar(
      VTIMEZONE,
      event(
        "evt-1",
        "DTSTART;TZID=Europe/Rome:20260316T100000",
        "DTEND;TZID=Europe/Rome:20260316T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "SUMMARY:Weekly sync",
      ),
    );
    const { occurrences } = expand(source, "2026-03-16T00:00:00Z", "2026-04-07T00:00:00Z");

    expect(occurrences.map((entry) => isoInZone(entry.start.utc!, "Europe/Rome"))).toEqual([
      "2026-03-16T10:00:00+01:00",
      "2026-03-23T10:00:00+01:00",
      "2026-03-30T10:00:00+02:00",
      "2026-04-06T10:00:00+02:00",
    ]);
    expect(occurrences[2]!.start.utc).toBe(Date.UTC(2026, 2, 30, 8));
    expect(occurrences[2]!.end.utc! - occurrences[2]!.start.utc!).toBe(3_600_000);
  });

  it("expands COUNT rules from DTSTART, not from the window", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260101T100000Z",
        "RRULE:FREQ=DAILY;COUNT=5",
        "SUMMARY:Daily",
      ),
    );
    expect(expand(source, "2026-01-01T00:00:00Z", "2026-01-07T00:00:00Z").occurrences).toHaveLength(5);
    expect(expand(source, "2026-02-01T00:00:00Z", "2026-02-10T00:00:00Z").occurrences).toHaveLength(0);
  });

  it("finds the right instances of a January series in February", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260105T100000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10",
        "SUMMARY:Monday",
      ),
    );
    const { occurrences } = expand(source, "2026-02-02T00:00:00Z", "2026-02-10T00:00:00Z");
    expect(occurrences.map((entry) => entry.start.utc)).toEqual([
      Date.UTC(2026, 1, 2, 10),
      Date.UTC(2026, 1, 9, 10),
    ]);
  });

  it("stops a hostile February 29 COUNT before the candidate cap", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260101T100000Z",
        "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=29;COUNT=1000",
        "SUMMARY:Leap day",
      ),
    );
    expect(() => expand(source, "2200-02-01T00:00:00Z", "2200-03-01T00:00:00Z")).toThrow(CalDavError);
    try {
      expand(source, "2200-02-01T00:00:00Z", "2200-03-01T00:00:00Z");
    } catch (error) {
      expect((error as CalDavError).code).toBe("recurrence_too_complex");
    }
  });

  it("honours EXDATE without resetting COUNT", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260105T100000Z",
        "RRULE:FREQ=DAILY;COUNT=3",
        "EXDATE:20260106T100000Z",
        "SUMMARY:Daily",
      ),
    );
    const { occurrences } = expand(source, "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z");
    expect(occurrences.map((entry) => entry.start.utc)).toEqual([
      Date.UTC(2026, 0, 5, 10),
      Date.UTC(2026, 0, 7, 10),
    ]);
  });

  it("adds RDATE instances to the recurrence set", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260105T100000Z",
        "RRULE:FREQ=WEEKLY;COUNT=2",
        "RDATE:20260108T150000Z",
        "SUMMARY:Weekly",
      ),
    );
    const { occurrences } = expand(source, "2026-01-01T00:00:00Z", "2026-01-10T00:00:00Z");
    expect(occurrences.map((entry) => entry.start.utc)).toEqual([
      Date.UTC(2026, 0, 5, 10),
      Date.UTC(2026, 0, 8, 15),
    ]);
  });

  it("replaces a generated instance with its RECURRENCE-ID override", () => {
    const source = calendar(
      VTIMEZONE,
      event(
        "evt-1",
        "DTSTART;TZID=Europe/Rome:20260323T100000",
        "DTEND;TZID=Europe/Rome:20260323T110000",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4",
        "SUMMARY:Weekly sync",
      ),
      vevent(
        "UID:evt-1",
        "RECURRENCE-ID;TZID=Europe/Rome:20260330T100000",
        "DTSTART;TZID=Europe/Rome:20260330T113000",
        "DTEND;TZID=Europe/Rome:20260330T123000",
        "SUMMARY:Moved sync",
      ),
    );
    const { occurrences } = expand(source, "2026-03-23T00:00:00Z", "2026-04-20T00:00:00Z");
    expect(occurrences.map((entry) => entry.component.summary)).toEqual([
      "Weekly sync",
      "Moved sync",
      "Weekly sync",
      "Weekly sync",
    ]);
    expect(occurrences.map((entry) => entry.override)).toEqual([false, true, false, false]);
    expect(isoInZone(occurrences[1]!.start.utc!, "Europe/Rome")).toBe("2026-03-30T11:30:00+02:00");
    expect(occurrences[1]!.recurrenceId.utc).toBe(Date.UTC(2026, 2, 30, 8));
  });

  it("flags THISANDFUTURE and still applies the exact override", () => {
    const source = calendar(
      event("evt-1", "DTSTART:20261101T100000Z", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Weekly"),
      vevent(
        "UID:evt-1",
        "RECURRENCE-ID;RANGE=THISANDFUTURE:20261108T100000Z",
        "DTSTART:20261108T110000Z",
        "SUMMARY:Future",
      ),
    );
    const result = expand(source, "2026-11-01T00:00:00Z", "2026-11-20T00:00:00Z");
    expect(result.unsupportedRange).toBe(true);
    expect(result.occurrences.map((entry) => entry.start.utc)).toEqual([
      Date.UTC(2026, 10, 1, 10),
      Date.UTC(2026, 10, 8, 11),
      Date.UTC(2026, 10, 15, 10),
    ]);
  });

  it("expands an all-day weekly series with exclusive ends", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART;VALUE=DATE:20261019",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3",
        "SUMMARY:All day",
      ),
    );
    const { occurrences } = expand(source, "2026-10-19T00:00:00Z", "2026-11-10T00:00:00Z");
    expect(occurrences.map((entry) => entry.start.wall.day)).toEqual([19, 26, 2]);
    expect(occurrences.every((entry) => entry.allDay)).toBe(true);
    expect(occurrences[0]!.end.wall.day).toBe(20);
  });

  it("expands the last Friday of each month", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260130T090000Z",
        "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3",
        "SUMMARY:Last Friday",
      ),
    );
    const { occurrences } = expand(source, "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z");
    expect(occurrences.map((entry) => entry.start.wall.day)).toEqual([30, 27, 27]);
    expect(occurrences.map((entry) => entry.start.wall.month)).toEqual([1, 2, 3]);
  });

  it("expands the last day of each month", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260131T090000Z",
        "RRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3",
        "SUMMARY:Month end",
      ),
    );
    const { occurrences } = expand(source, "2026-01-01T00:00:00Z", "2026-05-01T00:00:00Z");
    expect(occurrences.map((entry) => entry.start.wall.day)).toEqual([31, 28, 31]);
  });

  it("expands a plain yearly rule", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260215T090000Z",
        "RRULE:FREQ=YEARLY;COUNT=3",
        "SUMMARY:Yearly",
      ),
    );
    const { occurrences } = expand(source, "2026-01-01T00:00:00Z", "2029-01-01T00:00:00Z");
    expect(occurrences.map((entry) => entry.start.wall.year)).toEqual([2026, 2027, 2028]);
  });

  it("skips to the window instead of walking an old monthly series", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:19000115T090000Z",
        "RRULE:FREQ=MONTHLY",
        "SUMMARY:Monthly",
      ),
    );
    const budget = createRecurrenceBudget(200_000);
    const result = expand(source, "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z", { budget });
    expect(result.occurrences).toHaveLength(3);
    expect(result.occurrences.map((entry) => entry.start.wall.month)).toEqual([1, 2, 3]);
    expect(budget.remaining).toBeGreaterThan(199_900);
  });

  it("skips to the window instead of walking an old daily series", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:19000101T090000Z",
        "RRULE:FREQ=DAILY",
        "SUMMARY:Daily",
      ),
    );
    const budget = createRecurrenceBudget(200_000);
    const result = expand(source, "2026-01-01T00:00:00Z", "2026-01-05T00:00:00Z", { budget });
    expect(result.occurrences.map((entry) => entry.start.wall.day)).toEqual([1, 2, 3, 4]);
    expect(budget.remaining).toBeGreaterThan(199_990);
  });

  it("skips to the window instead of walking an old yearly series", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:19000215T090000Z",
        "RRULE:FREQ=YEARLY",
        "SUMMARY:Yearly",
      ),
    );
    const budget = createRecurrenceBudget(200_000);
    const result = expand(source, "2026-01-01T00:00:00Z", "2028-01-01T00:00:00Z", { budget });
    expect(result.occurrences.map((entry) => entry.start.wall.year)).toEqual([2026, 2027]);
    expect(budget.remaining).toBeGreaterThan(199_900);
  });

  it("counts weekly offsets from WKST, not from Sunday", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20261101T100000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=MO;WKST=SU;COUNT=3",
        "SUMMARY:Monday",
      ),
    );
    const { occurrences } = expand(source, "2026-11-01T00:00:00Z", "2026-11-20T00:00:00Z");
    expect(occurrences.map((entry) => entry.start.utc)).toEqual([
      Date.UTC(2026, 10, 2, 10),
      Date.UTC(2026, 10, 9, 10),
      Date.UTC(2026, 10, 16, 10),
    ]);
  });

  it("stops on the shared request budget and reports truncation", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20260101T100000Z",
        "RRULE:FREQ=DAILY",
        "SUMMARY:Daily",
      ),
    );
    const budget = createRecurrenceBudget(10);
    const result = expand(source, "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z", { budget });
    expect(result.truncated).toBe(true);
    expect(result.occurrences).toHaveLength(10);
    expect(budget.remaining).toBe(0);
  });

  it("includes an override moved into the window", () => {
    const source = calendar(
      event("evt-1", "DTSTART:20260101T100000Z", "RRULE:FREQ=WEEKLY;COUNT=3"),
      vevent(
        "UID:evt-1",
        "RECURRENCE-ID:20260101T100000Z",
        "DTSTART:20260102T100000Z",
        "SUMMARY:Moved in",
      ),
    );
    const { occurrences } = expand(source, "2026-01-02T00:00:00Z", "2026-01-03T00:00:00Z");
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.component.summary).toBe("Moved in");
  });

  it("does not compare an unresolved TZID as if it were UTC", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART;TZID=Europe/Nowhere:20261021T100000",
        "DTEND;TZID=Europe/Nowhere:20261021T110000",
      ),
    );
    const { occurrences } = expand(source, "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z");
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.timeZoneUnresolved).toBe(true);
    expect(occurrences[0]!.start.utc).toBeNull();
  });

  it("refuses an expansion window that is empty or backwards", () => {
    const parsed = parseResource(calendar(event("evt-1", "DTSTART:20261021T080000Z")));
    expect(() => expandResource(parsed, { from: 10, to: 10 })).toThrow(CalDavError);
    expect(() => expandResource(parsed, { from: 10, to: 5 })).toThrow(CalDavError);
  });
});

describe("mutateResource", () => {
  it("preserves UID, DTSTAMP, alarms, X-properties and VTIMEZONE", () => {
    const source = calendar(
      VTIMEZONE,
      event(
        "evt-1",
        "DTSTART;TZID=Europe/Rome:20261021T100000",
        "DTEND;TZID=Europe/Rome:20261021T110000",
        "SUMMARY:Before",
        "X-FOO;X-P=1:bar",
        "BEGIN:VALARM",
        "ACTION:DISPLAY",
        "DESCRIPTION:Reminder",
        "TRIGGER:-PT15M",
        "END:VALARM",
      ),
    );
    const output = mutateResource(source, "evt-1", (editor) => {
      editor.setText("summary", "After");
      editor.setDateTimeUtc("dtstart", "2026-10-21T09:00:00Z");
      editor.setDateTimeUtc("dtend", "2026-10-21T10:00:00Z");
    });

    expect(output).toContain("SUMMARY:After");
    expect(output).toContain("DTSTART:20261021T090000Z");
    expect(output).toContain("DTSTAMP:20260101T000000Z");
    expect(output).toContain("X-FOO;X-P=1:bar");
    expect(output).toContain("BEGIN:VALARM");
    expect(output).toContain("BEGIN:VTIMEZONE");
    expect(output).toContain("TZID:Europe/Rome");

    const reparsed = parseResource(output);
    expect(reparsed.uid).toBe("evt-1");
    expect(reparsed.master.summary).toBe("After");
    expect(reparsed.master.start!.utc).toBe(Date.UTC(2026, 9, 21, 9));
    expect(reparsed.master.alarms).toBe(1);
  });

  it("restores the original UID when the callback changes it", () => {
    const source = calendar(
      event("evt-1", "DTSTART:20261021T080000Z", "SUMMARY:Before"),
    );
    const output = mutateResource(source, "evt-1", (editor) => {
      editor.setText("uid", "someone-else");
    });
    expect(parseResource(output).uid).toBe("evt-1");
  });

  it("refuses a recurring resource", () => {
    const source = calendar(
      event("evt-1", "DTSTART:20261021T080000Z", "RRULE:FREQ=DAILY;COUNT=2"),
    );
    expect(() => mutateResource(source, "evt-1", (editor) => editor.setText("summary", "x"))).toThrow(
      /recurring resources are read-only/,
    );
  });

  it("refuses a resource carrying scheduling properties", () => {
    const source = calendar(
      event(
        "evt-1",
        "DTSTART:20261021T080000Z",
        "ATTENDEE:mailto:guest@example.com",
      ),
    );
    expect(() => mutateResource(source, "evt-1", (editor) => editor.setText("summary", "x"))).toThrow(
      /scheduled resources are read-only/,
    );
  });

  it("refuses a UID that does not belong to the resource", () => {
    const source = calendar(event("evt-1", "DTSTART:20261021T080000Z"));
    expect(() => mutateResource(source, "other", (editor) => editor.setText("summary", "x"))).toThrow(
      /UID does not match/,
    );
  });

  it("completes and reopens a reminder without leaving completion residue", () => {
    const source = calendar(
      vtodo(
        "UID:todo-1",
        "DTSTAMP:20260101T000000Z",
        "SUMMARY:Buy milk",
        "STATUS:NEEDS-ACTION",
      ),
    );
    const completed = mutateResource(source, "todo-1", (editor) => {
      editor.setText("status", "COMPLETED");
      editor.setDateTimeUtc("completed", "2026-10-21T12:00:00Z");
      editor.setInteger("percent-complete", 100);
    });
    const completedParsed = parseResource(completed);
    expect(completedParsed.master.status).toBe("COMPLETED");
    expect(completedParsed.master.percentComplete).toBe(100);
    expect(completedParsed.master.completed!.utc).toBe(Date.UTC(2026, 9, 21, 12));

    const reopened = mutateResource(completed, "todo-1", (editor) => {
      editor.setText("status", "NEEDS-ACTION");
      editor.remove("completed");
      editor.remove("percent-complete");
    });
    const reopenedParsed = parseResource(reopened);
    expect(reopenedParsed.master.status).toBe("NEEDS-ACTION");
    expect(reopenedParsed.master.completed).toBeNull();
    expect(reopenedParsed.master.percentComplete).toBeNull();
  });
});

describe("ical.js types that must stay out of the request path", () => {
  it("never constructs Event, Time, Timezone, TimezoneService or RecurIterator", () => {
    const keys = ["Event", "Time", "Timezone", "TimezoneService", "RecurIterator"] as const;
    const original = new Map<string, unknown>();
    for (const key of keys) {
      original.set(key, (ICAL as unknown as Record<string, unknown>)[key]);
      Object.defineProperty(ICAL, key, {
        configurable: true,
        get() {
          throw new Error(`ICAL.${key} was constructed or read`);
        },
      });
    }
    try {
      const source = calendar(
        VTIMEZONE,
        event(
          "evt-1",
          "DTSTART;TZID=Europe/Rome:20260323T100000",
          "DTEND;TZID=Europe/Rome:20260323T110000",
          "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=2",
          "SUMMARY:Weekly",
        ),
        vevent(
          "UID:evt-1",
          "RECURRENCE-ID;TZID=Europe/Rome:20260330T100000",
          "DTSTART;TZID=Europe/Rome:20260330T113000",
          "SUMMARY:Moved",
        ),
      );
      const parsed = parseResource(source);
      expect(expandResource(parsed, {
        from: Date.UTC(2026, 2, 20),
        to: Date.UTC(2026, 3, 10),
      }).occurrences).toHaveLength(2);
      const output = mutateResource(calendar(event("plain", "DTSTART:20261021T080000Z")), "plain", (editor) => {
        editor.setText("summary", "Plain");
      });
      expect(output).toContain("SUMMARY:Plain");
    } finally {
      for (const key of keys) {
        Object.defineProperty(ICAL, key, {
          configurable: true,
          writable: true,
          value: original.get(key),
        });
      }
    }
  });
});
