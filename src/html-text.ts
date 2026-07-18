// Pure HTML-to-plain-text conversion, used as a fallback when a message only
// carries an HTML body. Hand-rolled with no dependencies so it can be unit
// tested under Node/vitest (this file imports nothing Workers-specific).
//
// The output is plain text: all HTML tags are stripped before entities are
// decoded, so a decoded entity can never re-introduce a tag that then gets
// interpreted. We never re-parse the result as HTML.

/** Decode the handful of entities that appear in real email bodies. */
function decodeEntities(s: string): string {
  // Single left-to-right pass: this cannot double-decode (e.g. "&amp;lt;"
  // becomes the literal "&lt;", never "<").
  return s.replace(
    /&(amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-fA-F]+);/g,
    (_m, body: string) => {
      switch (body) {
        case "amp":
          return "&";
        case "lt":
          return "<";
        case "gt":
          return ">";
        case "quot":
          return '"';
        case "apos":
          return "'";
        case "nbsp":
          return " ";
      }
      const code =
        body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
      try {
        return String.fromCodePoint(code);
      } catch {
        return "";
      }
    },
  );
}

/** Read the href value out of an <a> tag's attribute string. */
function extractHref(attrs: string): string | null {
  const m = attrs.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (!m) return null;
  const raw = m[2] ?? m[3] ?? m[4] ?? "";
  return raw.trim();
}

/**
 * Convert HTML to plain text. Tags are dropped or turned into whitespace,
 * links become `label (url)`, and entities are decoded last. The result never
 * contains `<...>` tag remnants.
 */
export function htmlToText(html: string): string {
  let s = html;

  // Drop comments and non-content blocks (with their contents) entirely.
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  // Links: keep the visible label, and append the URL when it is an http(s)
  // target that differs from the label the reader already sees.
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const label = inner.replace(/<[^>]*>/g, "").trim();
    const href = extractHref(attrs);
    const isHttp = href !== null && /^https?:\/\//i.test(href);
    if (!isHttp) return label;
    if (label === "") return href!;
    return href === label ? label : `${label} (${href})`;
  });

  // Line breaks and block boundaries become newlines; list items get a bullet.
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "- ");
  s = s.replace(/<\/(p|div|li|tr|h[1-6])\s*>/gi, "\n");

  // Strip every remaining tag, then decode entities on the tag-free text.
  s = s.replace(/<[^>]*>/g, "");
  s = decodeEntities(s);

  // Normalize whitespace: unify newlines, collapse space/tab runs, trim each
  // line's edges, and cap blank runs at a single blank line.
  s = s.replace(/\r\n?/g, "\n");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/[ \t]*\n[ \t]*/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}
