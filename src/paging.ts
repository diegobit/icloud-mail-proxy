// Pure paging logic for search results, kept free of any Workers-only imports
// so it can be unit-tested directly under Node/vitest.

export interface PageSelection {
  /** The selected UIDs for this page, ascending (newest last). */
  page: number[];
  /**
   * Cursor for the next (older) page: the lowest UID in this page when older
   * matches remain beyond it, otherwise null.
   */
  nextBeforeUid: number | null;
}

/**
 * Select one page of matched UIDs, newest-first paging via a `beforeUid`
 * cursor. Matches are considered newest-highest-UID. When `beforeUid` is given,
 * only strictly-older matches (uid < beforeUid) are eligible; the newest
 * `limit` of the eligible matches form the page. `nextBeforeUid` is the lowest
 * UID in the page when further older matches were left out, else null.
 */
export function selectPage(
  matched: number[],
  limit: number,
  beforeUid?: number,
): PageSelection {
  const ascending = [...matched].sort((a, b) => a - b);
  const eligible =
    beforeUid === undefined ? ascending : ascending.filter((uid) => uid < beforeUid);
  const page = eligible.slice(-limit);
  const moreOlderRemain = eligible.length > page.length;
  const nextBeforeUid = moreOlderRemain && page.length > 0 ? page[0] : null;
  return { page, nextBeforeUid };
}
