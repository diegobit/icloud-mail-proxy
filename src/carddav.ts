// Read-only CardDAV client for iCloud contacts (plans/feature-gap-roadmap.md,
// unit 2).
//
// It reuses the CalDAV transport (src/caldav.ts) with its own service: the
// bootstrap host is contacts.icloud.com, the shard must match
// ^p\d+-contacts\.icloud\.com$ and the home must be exactly the principal's
// /<dsid>/carddavhome/ (probed 2026-10-28). The client object has no put,
// delete or get, and the service allows only PROPFIND and REPORT, so nothing
// here can write to the address book even by mistake.
//
// iCloud honours addressbook-query text-match (case-insensitive, `anyof`
// across properties) but ignores both <limit> and per-property address-data
// selection: every match comes back whole, photos included. The caller caps
// the result list and strips fields itself.

import {
  CalDavError,
  createDavTransport,
  escapeXml,
  clearDiscoveryCache,
  type CalDavDiscovery,
  type CalDavOptions,
  type CalDavResponse,
  type DavService,
} from "./caldav";
import type { Env } from "./types";

export interface CardDav {
  discover(): Promise<CalDavDiscovery>;
  propfind(href: string, body: string, depth?: 0 | 1): Promise<CalDavResponse>;
  report(href: string, body: string, depth?: 0 | 1): Promise<CalDavResponse>;
}

const NAMESPACES = 'xmlns:D="DAV:" xmlns:CR="urn:ietf:params:xml:ns:carddav"';
const ID = /^[A-Za-z0-9._-]{1,128}$/;

/** The vCard properties a search matches against. */
export const SEARCH_PROPERTIES = ["FN", "NICKNAME", "EMAIL", "ORG"] as const;

const CARDDAV: DavService = {
  label: "CardDAV",
  bootstrapOrigin: "https://contacts.icloud.com",
  shardHost: /^p\d+-contacts\.icloud\.com$/,
  homeSetBody: `<D:propfind ${NAMESPACES}><D:prop><CR:addressbook-home-set/></D:prop></D:propfind>`,
  homeSetProperty: "addressbook-home-set",
  homeDirectory: "carddavhome",
  homeLabel: "address book home",
  accept: "text/vcard",
  methods: new Set(["PROPFIND", "REPORT"]),
  cache: new Map(),
};

export function clearCardDavDiscoveryCache(user?: string): void {
  clearDiscoveryCache(CARDDAV, user);
}

export function createCardDav(env: Env, options: CalDavOptions = {}): CardDav {
  const transport = createDavTransport(env, CARDDAV, options);
  return {
    discover: () => transport.discover(),
    propfind: (href, body, depth = 0) => transport.propfind(href, body, depth),
    report: (href, body, depth = 1) => transport.report(href, body, depth),
  };
}

export const ADDRESS_BOOKS_PROPFIND =
  `<D:propfind ${NAMESPACES}><D:prop><D:resourcetype/><D:displayname/></D:prop></D:propfind>`;

/**
 * addressbook-query matching `needle` as a case-insensitive substring of any
 * search property. The needle is XML-escaped; the property names are fixed.
 */
export function addressbookQuery(needle: string): string {
  if (needle === "" || /[\u0000-\u001f\u007f]/.test(needle)) {
    throw new CalDavError("invalid_argument", 0, "the contact query is empty or contains a control character");
  }
  const text = escapeXml(needle);
  const filters = SEARCH_PROPERTIES.map(
    (property) =>
      `<CR:prop-filter name="${property}">` +
      `<CR:text-match collation="i;unicode-casemap" match-type="contains">${text}</CR:text-match>` +
      "</CR:prop-filter>",
  ).join("");
  return (
    `<CR:addressbook-query ${NAMESPACES}>` +
    "<D:prop><D:getetag/><CR:address-data/></D:prop>" +
    `<CR:filter test="anyof">${filters}</CR:filter>` +
    "</CR:addressbook-query>"
  );
}

export function addressbookMultiget(hrefs: readonly string[]): string {
  if (hrefs.length === 0) throw new CalDavError("invalid_argument", 0, "addressbook-multiget needs at least one href");
  const body = hrefs.map((href) => `<D:href>${escapeXml(href)}</D:href>`).join("");
  return (
    `<CR:addressbook-multiget ${NAMESPACES}>` +
    `<D:prop><D:getetag/><CR:address-data/></D:prop>${body}</CR:addressbook-multiget>`
  );
}

export function isContactId(value: string): boolean {
  return ID.test(value) && value !== "." && value !== "..";
}

/** The contact id is the resource name without `.vcf`, when it is id-safe. */
export function contactIdFromHref(href: string, bookPath: string): string | null {
  let path: string;
  try {
    path = new URL(href, "https://contacts.invalid").pathname;
  } catch {
    return null;
  }
  if (!path.startsWith(bookPath)) return null;
  const rest = path.slice(bookPath.length);
  if (rest.includes("/") || !rest.toLowerCase().endsWith(".vcf")) return null;
  let id: string;
  try {
    id = decodeURIComponent(rest.slice(0, -".vcf".length));
  } catch {
    return null;
  }
  return isContactId(id) ? id : null;
}

/** Href of one contact inside an address book path. */
export function contactHref(bookPath: string, id: string): string {
  if (!isContactId(id)) throw new CalDavError("invalid_argument", 0, "invalid contact id");
  return `${bookPath}${encodeURIComponent(id)}.vcf`;
}
