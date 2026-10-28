// Minimal vCard reader for the contacts surface (plans/feature-gap-roadmap.md,
// unit 2). iCloud serves vCard 3.0 (probed 2026-10-28): CRLF lines folded with
// a leading space or tab, Apple group prefixes such as `item1.EMAIL`, and
// RFC 6350 escapes (`\,`, `\;`, `\n`, `\\`). Only the properties the tools
// return are read: FN, N, EMAIL, TEL and ORG. Everything else (notes,
// addresses, birthdays, photos, related names) is skipped unparsed, so it can
// never reach a response by accident.

export interface VCard {
  /** FN, else a name built from N, else null. */
  name: string | null;
  emails: string[];
  phones: string[];
  organization: string | null;
  /** Apple stores contact groups as vCards with X-ADDRESSBOOKSERVER-KIND:group. */
  isGroup: boolean;
}

/** Per-card list caps: a hostile card cannot inflate a response. */
export const MAX_VALUES_PER_FIELD = 10;
const MAX_VALUE_CHARS = 256;

interface ContentLine {
  name: string;
  value: string;
}

/** Undo line folding: CRLF (or a bare LF/CR) followed by one space or tab. */
export function unfold(text: string): string[] {
  return text
    .replace(/\r\n[ \t]|\n[ \t]|\r[ \t]/g, "")
    .split(/\r\n|\n|\r/)
    .filter((line) => line.length > 0);
}

/**
 * Split one content line into its upper-cased property name (group prefix
 * dropped) and raw value. A colon inside a quoted parameter value does not end
 * the name part.
 */
export function parseContentLine(line: string): ContentLine | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon <= 0) return null;
  const head = line.slice(0, colon);
  const semicolon = head.indexOf(";");
  const qualified = semicolon < 0 ? head : head.slice(0, semicolon);
  const dot = qualified.lastIndexOf(".");
  const name = (dot < 0 ? qualified : qualified.slice(dot + 1)).toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return null;
  return { name, value: line.slice(colon + 1) };
}

/** Split on separators not preceded by a backslash escape. */
function splitUnescaped(value: string, separator: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && i + 1 < value.length) {
      current += char + value[i + 1];
      i++;
    } else if (char === separator) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

export function unescapeValue(value: string): string {
  return value.replace(/\\([\\,;nN])/g, (_, char: string) =>
    char === "n" || char === "N" ? "\n" : char,
  );
}

function clean(value: string): string | null {
  // Control characters (other than the newline an escape produces) have no
  // place in a name, address or number; collapse whitespace runs.
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return [...text].slice(0, MAX_VALUE_CHARS).join("");
}

function structured(value: string): string[] {
  return splitUnescaped(value, ";").map((part) => clean(unescapeValue(part)) ?? "");
}

/** Read the first VCARD block of `text`. Returns null when there is none. */
export function parseVCard(text: string): VCard | null {
  const lines = unfold(text);
  const begin = lines.findIndex((line) => /^BEGIN:VCARD$/i.test(line.trim()));
  if (begin < 0) return null;

  let fn: string | null = null;
  let nameFromN: string | null = null;
  let organization: string | null = null;
  let isGroup = false;
  const emails: string[] = [];
  const phones: string[] = [];
  let depth = 0;

  for (const raw of lines.slice(begin + 1)) {
    const line = raw.trim();
    if (/^END:VCARD$/i.test(line)) {
      if (depth === 0) break;
      depth -= 1;
      continue;
    }
    if (/^BEGIN:/i.test(line)) {
      // A nested component (AGENT in vCard 2.1) is not this contact's data.
      depth += 1;
      continue;
    }
    if (depth > 0) continue;
    const parsed = parseContentLine(line);
    if (!parsed) continue;
    switch (parsed.name) {
      case "FN":
        fn ??= clean(unescapeValue(parsed.value));
        break;
      case "N": {
        // family;given;additional;prefix;suffix
        const [family = "", given = "", additional = "", prefix = "", suffix = ""] = structured(parsed.value);
        nameFromN ??= clean([prefix, given, additional, family, suffix].filter(Boolean).join(" "));
        break;
      }
      case "EMAIL": {
        const email = clean(unescapeValue(parsed.value));
        if (email && emails.length < MAX_VALUES_PER_FIELD && !emails.includes(email)) emails.push(email);
        break;
      }
      case "TEL": {
        const phone = clean(unescapeValue(parsed.value).replace(/^tel:/i, ""));
        if (phone && phones.length < MAX_VALUES_PER_FIELD && !phones.includes(phone)) phones.push(phone);
        break;
      }
      case "ORG":
        organization ??= clean(structured(parsed.value).filter(Boolean).join(", "));
        break;
      case "X-ADDRESSBOOKSERVER-KIND":
        if (parsed.value.trim().toLowerCase() === "group") isGroup = true;
        break;
      case "KIND":
        if (parsed.value.trim().toLowerCase() === "group") isGroup = true;
        break;
    }
  }

  return { name: fn ?? nameFromN, emails, phones, organization, isGroup };
}
