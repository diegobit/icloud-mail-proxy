import { describe, it, expect } from "vitest";
import { buildSearchCriteria } from "../src/search-criteria";

const window = { since: new Date("2026-01-01T00:00:00Z"), before: null };
describe("search criteria", () => {
  it("builds OR and exclusions from fixed keys", () => {
    expect(buildSearchCriteria(window, { from: ["one", "two", "three"], not: { subject: "bad" }, flagged: false })).toBe('SINCE 01-Jan-2026 UNFLAGGED OR FROM "one" OR FROM "two" FROM "three" NOT SUBJECT "bad"');
  });
  it("rejects unsafe or oversized terms and nesting", () => {
    for (const filters of [{ from: ["a", "b", "c", "d", "e"] }, { from: "é" }, { not: { not: { from: "a" } } }, { text: "a\r\nb" }]) {
      expect(() => buildSearchCriteria(window, filters as never)).toThrow();
    }
  });
});
