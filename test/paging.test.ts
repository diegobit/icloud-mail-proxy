import { describe, it, expect } from "vitest";
import { selectPage } from "../src/paging";

describe("selectPage", () => {
  it("takes the newest `limit` matches when no cursor is given", () => {
    const { page, nextBeforeUid } = selectPage([10, 40, 20, 50, 30], 3);
    expect(page).toEqual([30, 40, 50]);
    // Older matches (10, 20) remain below the page, so cursor is the page's low.
    expect(nextBeforeUid).toBe(30);
  });

  it("sorts unsorted input ascending before slicing", () => {
    const { page } = selectPage([5, 1, 9, 3], 2);
    expect(page).toEqual([5, 9]);
  });

  it("applies a mid-list beforeUid cursor (strictly older only)", () => {
    // Second page after a first page whose lowest uid was 30.
    const { page, nextBeforeUid } = selectPage([10, 20, 30, 40, 50], 2, 30);
    expect(page).toEqual([10, 20]);
    // Nothing older than 10 remains.
    expect(nextBeforeUid).toBeNull();
  });

  it("returns an empty page and null cursor when beforeUid is older than all", () => {
    const { page, nextBeforeUid } = selectPage([10, 20, 30], 5, 5);
    expect(page).toEqual([]);
    expect(nextBeforeUid).toBeNull();
  });

  it("returns null cursor at an exact page boundary (remaining == 0)", () => {
    // Exactly `limit` matches are eligible, so none are left over.
    const { page, nextBeforeUid } = selectPage([10, 20, 30, 40], 2, 30);
    expect(page).toEqual([10, 20]);
    expect(nextBeforeUid).toBeNull();
  });

  it("returns all matches and null cursor when fewer than limit match", () => {
    const { page, nextBeforeUid } = selectPage([10, 20], 5);
    expect(page).toEqual([10, 20]);
    expect(nextBeforeUid).toBeNull();
  });

  it("excludes the boundary uid itself (uid < beforeUid, not <=)", () => {
    const { page } = selectPage([10, 20, 30], 10, 20);
    expect(page).toEqual([10]);
  });

  it("sets the cursor to the lowest uid of the page when older matches remain", () => {
    const { page, nextBeforeUid } = selectPage([10, 20, 30, 40, 50], 2);
    expect(page).toEqual([40, 50]);
    expect(nextBeforeUid).toBe(40);
  });

  it("handles an empty match set", () => {
    expect(selectPage([], 10)).toEqual({ page: [], nextBeforeUid: null });
    expect(selectPage([], 10, 100)).toEqual({ page: [], nextBeforeUid: null });
  });
});
