// The one place IMAP SEARCH criteria are built (plans/feature-gap-roadmap.md,
// unit 4).
//
// Callers describe a search with a closed shape — fixed fields, at most
// MAX_ALTERNATIVES strings per field, one level of `not` — and this module
// turns it into protocol tokens. Keys and keywords (FROM, OR, NOT, UNSEEN, ...)
// come from constants here; a caller's text only ever becomes a quoted string
// (printable ASCII). There is no way to
// pass a raw SEARCH string or a free boolean tree, so a value cannot inject a
// keyword, a parenthesis or a CRLF.
//
// Search terms remain printable ASCII until the UTF-8 probe gate is met.

import { ApiError } from "./core";
import { quoteImapString, toImapDate } from "./imap-parse";

export const MAX_ALTERNATIVES = 4;
export const MAX_SEARCH_TERMS = 12;
export const MAX_TERM_CHARS = 200;

export type Terms = string | string[];

export interface SearchFilters {
  from?: Terms;
  to?: Terms;
  cc?: Terms;
  subject?: Terms;
  text?: Terms;
  not?: { from?: Terms; subject?: Terms; text?: Terms };
  unseen?: boolean;
  flagged?: boolean;
}

const POSITIVE_KEYS = { from: "FROM", to: "TO", cc: "CC", subject: "SUBJECT", text: "TEXT" } as const;
const NEGATIVE_KEYS = { from: "FROM", subject: "SUBJECT", text: "TEXT" } as const;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
// A lone surrogate half has no UTF-8 encoding.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_criteria", message);
}

/**
 * The values of one field: a single string or 1..MAX_ALTERNATIVES strings.
 * A lone empty string means "no filter", as before; inside an array it is
 * refused, because an empty IMAP term matches everything.
 */
function termsOf(field: string, value: unknown): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value === "" ? [] : [checkTerm(field, value)];
  if (!Array.isArray(value)) throw invalid(`${field} must be a string or an array of strings`);
  if (value.length === 0) throw invalid(`${field} must not be an empty array`);
  if (value.length > MAX_ALTERNATIVES) {
    throw invalid(`${field} has ${value.length} alternatives; the limit is ${MAX_ALTERNATIVES}`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string") throw invalid(`${field} alternatives must be strings`);
    if (entry === "") throw invalid(`${field} alternatives must not be empty`);
    return checkTerm(field, entry);
  });
}

function checkTerm(field: string, value: string): string {
  if (!PRINTABLE_ASCII.test(value)) throw invalid(`${field} must contain printable ASCII only`);
  if (CONTROL.test(value)) throw invalid(`${field} must not contain control characters`);
  const chars = [...value].length;
  if (chars > MAX_TERM_CHARS) {
    throw invalid(`${field} is ${chars} characters; the limit is ${MAX_TERM_CHARS}`);
  }
  if (LONE_SURROGATE.test(value)) throw invalid(`${field} is not valid Unicode`);
  return value;
}

export function buildSearchCriteria(
  window: { since: Date; before: Date | null },
  filters: SearchFilters,
): string {
  const parts: string[] = [`SINCE ${toImapDate(window.since)}`];
  if (window.before) parts.push(`BEFORE ${toImapDate(window.before)}`);
  // Flag keywords are fixed tokens, never built from caller text.
  if (filters.unseen === true) parts.push("UNSEEN");
  if (filters.flagged === true) parts.push("FLAGGED");
  else if (filters.flagged === false) parts.push("UNFLAGGED");

  let count = 0;
  const term = (value: string): string => quoteImapString(value);

  for (const [field, key] of Object.entries(POSITIVE_KEYS)) {
    const values = termsOf(field, filters[field as keyof typeof POSITIVE_KEYS]);
    count += values.length;
    // n alternatives: OR KEY a OR KEY b KEY c (prefix form, right-nested).
    values.forEach((value, index) => {
      if (index < values.length - 1) parts.push("OR");
      parts.push(key, term(value));
    });
  }

  const not = filters.not;
  if (not !== undefined) {
    if (typeof not !== "object" || not === null || Array.isArray(not)) {
      throw invalid("not must be an object with from, subject or text");
    }
    for (const key of Object.keys(not)) {
      if (!Object.hasOwn(NEGATIVE_KEYS, key)) throw invalid(`not.${key} is not supported; use from, subject or text`);
    }
    for (const [field, key] of Object.entries(NEGATIVE_KEYS)) {
      const values = termsOf(`not.${field}`, not[field as keyof typeof NEGATIVE_KEYS]);
      count += values.length;
      for (const value of values) parts.push("NOT", key, term(value));
    }
  }

  if (count > MAX_SEARCH_TERMS) {
    throw invalid(`the search has ${count} terms; the limit is ${MAX_SEARCH_TERMS}`);
  }
  return parts.join(" ");
}

