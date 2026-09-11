// Every path the deployment scripts touch, resolved from this file's location
// so the scripts work regardless of the caller's working directory.

import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const baseConfigPath = path.join(repoRoot, "wrangler.base.jsonc");
export const profilesPath = path.join(repoRoot, "deploy-profiles.jsonc");
/** Gitignored: generated configs and nonsecret resume state. */
export const localDir = path.join(repoRoot, ".deploy");
export const statePath = path.join(localDir, "state.json");
export const wranglerBin = path.join(repoRoot, "node_modules", "wrangler", "bin", "wrangler.js");

/** Generated config for a target, e.g. "local" -> .deploy/wrangler.local.jsonc */
export function generatedConfigPath(label, dir = localDir) {
  return path.join(dir, `wrangler.${label}.jsonc`);
}
