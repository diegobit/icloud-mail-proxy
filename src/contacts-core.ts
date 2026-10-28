// Contacts: read-only search and lookup over CardDAV (plans/
// feature-gap-roadmap.md, unit 2).
//
// The contract:
// - opt-in through CONTACTS_ENABLED; off means no tools, routes or scope;
// - a query of at least 2 characters is mandatory: there is no "list
//   everything", and at most MAX_CONTACT_RESULTS contacts come back;
// - only id, name, emails, phones and organization are returned, labelled as
//   untrusted third-party content; notes, addresses, birthdays, photos and
//   related names are never read out of the vCard;
// - a per-IP limiter (CONTACTS_LIMITER, fails closed when missing) runs before
//   any network work, so an injected agent cannot harvest the book quickly;
// - one audit line per call with the principal and result count, never the
//   query or any contact field.

import { CalDavError, parseMultistatus, propText, resourcetypeKinds, type CalDavOptions } from "./caldav";
import {
  ADDRESS_BOOKS_PROPFIND,
  addressbookMultiget,
  addressbookQuery,
  contactHref,
  contactIdFromHref,
  createCardDav,
  isContactId,
  type CardDav,
} from "./carddav";
import { ApiError } from "./core";
import type { Env } from "./types";
import { parseVCard } from "./vcard";

export const MIN_QUERY_CHARS = 2;
export const MAX_QUERY_CHARS = 64;
const MAX_ADDRESS_BOOKS = 4;

export interface ContactContent {
  name: string | null;
  emails: string[];
  phones: string[];
  organization: string | null;
}

export interface Contact {
  id: string;
  untrustedContactContent: ContactContent;
}

export interface ContactSearchResult {
  contacts: Contact[];
  total: number;
  truncated: boolean;
}

export interface ContactOptions {
  /** Recorded in the audit line; defaults to "unknown". */
  principal?: string;
  /** Per-IP bucket for CONTACTS_LIMITER. */
  rateLimitKey?: string;
  /** Injected for tests; production uses the Worker's fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests. */
  davOptions?: CalDavOptions;
}

export function contactsEnabled(env: Env): boolean {
  return env.CONTACTS_ENABLED === "1";
}

export function maxContactResults(env: Env): number {
  const value = env.MAX_CONTACT_RESULTS;
  if (value === undefined || value.trim() === "") return 10;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 10;
  return Math.min(50, parsed);
}

function disabled(): ApiError {
  return new ApiError(404, "not_supported", "contacts are disabled: CONTACTS_ENABLED is not 1");
}

/** Validated, trimmed query; refuses before any network work. */
export function normalizeQuery(value: unknown): string {
  if (typeof value !== "string") throw new ApiError(400, "invalid_request", "query must be a string");
  const query = value.trim();
  if (/[\u0000-\u001f\u007f]/.test(query)) {
    throw new ApiError(400, "invalid_request", "query must not contain control characters");
  }
  const chars = [...query].length;
  if (chars < MIN_QUERY_CHARS) {
    throw new ApiError(
      400,
      "query_too_short",
      `query must be at least ${MIN_QUERY_CHARS} characters; there is no way to list every contact`,
    );
  }
  if (chars > MAX_QUERY_CHARS) {
    throw new ApiError(400, "invalid_request", `query is ${chars} characters; the limit is ${MAX_QUERY_CHARS}`);
  }
  return query;
}

async function withContactLimit<T>(env: Env, key: string | undefined, fn: () => Promise<T>): Promise<T> {
  const limiter = env.CONTACTS_LIMITER;
  if (limiter === undefined || limiter === null) {
    throw new ApiError(500, "configuration_error", "CONTACTS_LIMITER is not configured; contacts are disabled");
  }
  const { success } = await limiter.limit({ key: key ?? "unknown" });
  if (!success) throw new ApiError(429, "rate_limited", "too many contact lookups; retry in a minute");
  return fn();
}

function outcomeOf(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (error instanceof CalDavError) return error.code;
  return "internal_error";
}

function audit(event: "contact_search" | "contact_read", principal: string | undefined, results: number, outcome: string) {
  console.log(event, JSON.stringify({ principal: principal ?? "unknown", results, outcome }));
}

async function addressBooks(dav: CardDav): Promise<string[]> {
  const { homeUrl } = await dav.discover();
  const response = await dav.propfind(homeUrl, ADDRESS_BOOKS_PROPFIND, 1);
  const books = parseMultistatus(response.body)
    .filter((entry) => resourcetypeKinds(entry).includes("addressbook"))
    .map((entry) => new URL(entry.href, homeUrl).pathname);
  if (books.length > MAX_ADDRESS_BOOKS) {
    throw new CalDavError(
      "too_many_resources",
      0,
      `the account has ${books.length} address books; at most ${MAX_ADDRESS_BOOKS} are supported`,
    );
  }
  return books;
}

/**
 * iCloud writes each CR of the vCard as `&#13;` (probed 2026-10-28), and the
 * shared XML parser leaves numeric character references undecoded. Decode
 * them here so a value never ends in a literal `&#13;`.
 */
export function decodeCharRefs(text: string): string {
  return text.replace(/&#(?:x([0-9a-fA-F]{1,6})|([0-9]{1,7}));/g, (whole, hex: string | undefined, dec: string | undefined) => {
    const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
    if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return whole;
    return String.fromCodePoint(code);
  });
}

/** Contacts out of one multistatus body; groups and unaddressable cards are skipped. */
function contactsOf(body: string, bookPath: string): Contact[] {
  const contacts: Contact[] = [];
  for (const entry of parseMultistatus(body)) {
    const data = propText(entry, "address-data");
    if (data === null) continue;
    // Every probed resource name was id-safe; one that is not cannot be read
    // back with get_contact, so it is left out rather than given a fake id.
    const id = contactIdFromHref(entry.href, bookPath);
    if (id === null) continue;
    const card = parseVCard(decodeCharRefs(data));
    if (card === null || card.isGroup) continue;
    contacts.push({
      id,
      untrustedContactContent: {
        name: card.name,
        emails: card.emails,
        phones: card.phones,
        organization: card.organization,
      },
    });
  }
  return contacts;
}

function sortKey(contact: Contact): string {
  const content = contact.untrustedContactContent;
  return (content.name ?? content.organization ?? content.emails[0] ?? "").toLocaleLowerCase("en");
}

export async function searchContacts(
  env: Env,
  input: { query: unknown; limit?: number },
  options: ContactOptions = {},
): Promise<ContactSearchResult> {
  if (!contactsEnabled(env)) throw disabled();
  const query = normalizeQuery(input.query);
  const cap = maxContactResults(env);
  const limit = input.limit === undefined ? cap : Math.min(cap, Math.max(1, Math.floor(input.limit)));
  const body = addressbookQuery(query);

  let results = 0;
  try {
    const result = await withContactLimit(env, options.rateLimitKey, async () => {
      const dav = createCardDav(env, { fetchImpl: options.fetchImpl, ...options.davOptions });
      const found: Contact[] = [];
      for (const book of await addressBooks(dav)) {
        const response = await dav.report(book, body, 1);
        found.push(...contactsOf(response.body, book));
      }
      found.sort((a, b) => sortKey(a).localeCompare(sortKey(b), "en") || a.id.localeCompare(b.id));
      return { contacts: found.slice(0, limit), total: found.length, truncated: found.length > limit };
    });
    results = result.contacts.length;
    audit("contact_search", options.principal, results, "ok");
    return result;
  } catch (error) {
    audit("contact_search", options.principal, results, outcomeOf(error));
    throw error;
  }
}

export async function getContact(env: Env, input: { id: unknown }, options: ContactOptions = {}): Promise<Contact> {
  if (!contactsEnabled(env)) throw disabled();
  if (typeof input.id !== "string" || !isContactId(input.id)) {
    throw new ApiError(400, "invalid_request", "id must be a contact id returned by search_contacts");
  }
  const id = input.id;
  try {
    const contact = await withContactLimit(env, options.rateLimitKey, async () => {
      const dav = createCardDav(env, { fetchImpl: options.fetchImpl, ...options.davOptions });
      for (const book of await addressBooks(dav)) {
        const response = await dav.report(book, addressbookMultiget([contactHref(book, id)]), 1);
        const match = contactsOf(response.body, book).find((candidate) => candidate.id === id);
        if (match) return match;
      }
      throw new ApiError(404, "not_found", "no contact with that id");
    });
    audit("contact_read", options.principal, 1, "ok");
    return contact;
  } catch (error) {
    audit("contact_read", options.principal, 0, outcomeOf(error));
    throw error;
  }
}
