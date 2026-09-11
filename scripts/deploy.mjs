#!/usr/bin/env node
// `npm run deploy` — deploy the Worker to an explicitly selected target.
//
//   npm run deploy                          the target from `npm run setup`
//   npm run deploy -- --profile production  a profile from deploy-profiles.jsonc
//   npm run deploy -- --config <path>       an explicit wrangler config
//   npm run deploy -- --print-config        compose the config, deploy nothing
//
// Anything else is passed through to `wrangler deploy` (e.g. --dry-run).
// There is deliberately no fallback target: with no setup state and no
// profile this exits without touching Cloudflare.

import { readBaseConfig, readProfiles, writeGeneratedConfig } from "./lib/config.mjs";
import { readState } from "./lib/state.mjs";
import { parseArgs, resolveTarget, UsageError } from "./lib/target.mjs";
import { WranglerError, createWranglerAdapter } from "./lib/wrangler.mjs";

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));
    let configPath = args.configPath;
    let accountId;
    if (!configPath) {
      const { fragment, error } = resolveTarget({
        profile: args.profile,
        state: readState(),
        profiles: readProfiles(),
      });
      if (error) {
        console.error(error);
        return 2;
      }
      configPath = writeGeneratedConfig(fragment, { base: readBaseConfig() });
      accountId = fragment.account_id;
      console.log(`Target: ${fragment.label} → Worker "${fragment.name}"`);
    }
    console.log(`Config: ${configPath}`);
    if (args.printOnly) return 0;

    const wrangler = createWranglerAdapter();
    const { targets, dryRun } = await wrangler.deploy({ configPath, accountId, extraArgs: args.passthrough });
    if (dryRun) console.log("Dry run: the Worker was bundled and checked, nothing was deployed.");
    for (const target of targets) console.log(`Deployed: ${target}`);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      return error.exitCode ?? 2;
    }
    if (error instanceof WranglerError) {
      console.error(error.message);
      if (error.hint) console.error(error.hint);
      return error.exitCode ?? 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exitCode = await main();
