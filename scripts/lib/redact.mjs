// Secrets reach this process (typed by the user or generated) but must never
// reach the terminal, a log file, or persisted state. Everything we echo from
// a subprocess goes through redact() first.

/** Replace every occurrence of each secret with a fixed placeholder. */
export function redact(text, secrets = []) {
  let out = String(text ?? "");
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 4) continue;
    out = out.split(secret).join("[redacted]");
  }
  return out;
}
