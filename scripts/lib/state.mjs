// Nonsecret resume state for the guided setup: which account and Worker were
// selected, which folders were configured, and how far the last run got
// (`progress.uploadedAt` is when the secrets were uploaded). Credentials are
// never written here: writeState refuses to persist a value it was told is a
// secret, or any key whose name suggests it holds one.

import fs from "node:fs";
import path from "node:path";
import { statePath } from "./paths.mjs";

export const STATE_VERSION = 1;

const FORBIDDEN_KEY = /password|secret|token|credential/i;

/** Throw if any value in `value` is one of `secrets`, or any key looks secret. */
export function assertNoSecrets(value, secrets = [], trail = "state") {
  const needles = secrets.filter((s) => typeof s === "string" && s.length > 0);
  if (typeof value === "string") {
    if (needles.some((s) => value.includes(s))) {
      throw new Error(`refusing to persist a secret value at ${trail}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => assertNoSecrets(item, needles, `${trail}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) {
        throw new Error(`refusing to persist a secret-looking key at ${trail}.${key}`);
      }
      assertNoSecrets(item, needles, `${trail}.${key}`);
    }
  }
}

export function readState(file = statePath) {
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    return state && typeof state === "object" ? state : null;
  } catch {
    return null;
  }
}

export function writeState(state, { file = statePath, secrets = [] } = {}) {
  const next = { version: STATE_VERSION, ...state, updatedAt: new Date().toISOString() };
  assertNoSecrets(next, secrets);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

/** A state store bound to one file, so orchestration can stay pure. */
export function fileStateStore(file = statePath) {
  let cached = readState(file);
  return {
    read: () => cached,
    write(state, secrets) {
      cached = writeState(state, { file, secrets });
      return cached;
    },
    path: file,
  };
}
