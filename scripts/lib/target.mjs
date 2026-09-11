// Which Worker a deploy is aimed at. Selection is explicit: a named profile
// from deploy-profiles.jsonc, an explicit config path, or the target recorded
// by `npm run setup`. There is no implicit fallback, so an update can never
// land on a Worker the caller did not choose.

import { profileFragment, stateFragment } from "./config.mjs";

export const NO_TARGET_HELP = [
  "No deployment target selected, so nothing was deployed.",
  "",
  "  npm run setup                          set up (or re-select) your own deployment",
  "  npm run deploy -- --profile <name>     deploy a profile from deploy-profiles.jsonc",
  "  npm run deploy -- --config <path>      deploy an explicit wrangler config",
].join("\n");

/** Bad CLI usage: missing values, conflicts. The deploy entry point exits 2. */
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.exitCode = 2;
  }
}

function isOption(arg) {
  return typeof arg === "string" && arg.startsWith("-") && arg !== "-";
}

function readValue(argv, i, flag) {
  const value = argv[i + 1];
  if (value === undefined || value === "") {
    throw new UsageError(`${flag} requires a value`);
  }
  if (isOption(value)) {
    throw new UsageError(`${flag} requires a value, not ${value}`);
  }
  return value;
}

function assignUnique(current, value, flag) {
  if (current !== null && current !== value) {
    throw new UsageError(`conflicting ${flag} values: "${current}" and "${value}"`);
  }
  return value;
}

/** Split `deploy.mjs` arguments; anything unrecognized goes to wrangler. */
export function parseArgs(argv) {
  const args = { profile: null, configPath: null, printOnly: false, passthrough: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      args.passthrough.push(...argv.slice(i + 1));
      break;
    } else if (arg === "--profile" || arg === "-p") {
      args.profile = assignUnique(args.profile, readValue(argv, i, "--profile"), "--profile");
      i++;
    } else if (arg.startsWith("--profile=")) {
      const value = arg.slice("--profile=".length);
      if (value === "") throw new UsageError("--profile requires a value");
      args.profile = assignUnique(args.profile, value, "--profile");
    } else if (arg === "--config" || arg === "-c") {
      args.configPath = assignUnique(args.configPath, readValue(argv, i, "--config"), "--config");
      i++;
    } else if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value === "") throw new UsageError("--config requires a value");
      args.configPath = assignUnique(args.configPath, value, "--config");
    } else if (arg === "--print-config") {
      args.printOnly = true;
    } else {
      args.passthrough.push(arg);
    }
  }
  if (args.profile && args.configPath) {
    throw new UsageError("use either --profile or --config, not both");
  }
  return args;
}

/**
 * Resolve the target fragment to deploy. Returns `{ fragment }`, or
 * `{ error }` with a message the caller should print before exiting 2.
 */
export function resolveTarget({ profile, state, profiles }) {
  if (profile) {
    const fragment = profileFragment(profile, profiles);
    if (!fragment) {
      const known = Object.keys(profiles).join(", ") || "none";
      return { error: `unknown deployment profile "${profile}"; profiles in deploy-profiles.jsonc: ${known}` };
    }
    return { fragment };
  }
  const fragment = stateFragment(state);
  if (!fragment) return { error: NO_TARGET_HELP };
  return { fragment };
}
