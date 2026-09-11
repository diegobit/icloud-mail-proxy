// Minimal JSONC reader for the two tracked wrangler-style config files.
// Handles // and /* */ comments and trailing commas; wrangler itself accepts
// the same dialect, so what we parse is what wrangler would parse.

/**
 * Strip comments and trailing commas from JSONC text. String contents are
 * never rewritten: a comma inside a value (`"INBOX,Archive"`) survives, and
 * so does a string that merely looks like a trailing comma (`"value,}"`).
 */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    // A comma separated from this closing bracket by nothing but whitespace
    // (comments are already gone) is a trailing comma. Only structural text
    // has been emitted at this point, so this can't touch a string value.
    if (c === "}" || c === "]") out = out.replace(/,(\s*)$/, "$1");
    out += c;
  }
  return out;
}

/** Parse JSONC text, reporting the source path on failure. */
export function parseJsonc(text, source = "config") {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (e) {
    throw new Error(`${source} is not valid JSONC: ${e instanceof Error ? e.message : String(e)}`);
  }
}
