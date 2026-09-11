#!/usr/bin/env node
// `npm run setup` — guided deployment to the user's own Cloudflare account.
// This file only wires the real adapters to the orchestration in
// lib/setup.mjs and turns the outcome into an exit code.

import { randomBytes } from "node:crypto";
import { readBaseConfig, writeGeneratedConfig } from "./lib/config.mjs";
import { AbortedError, createPrompts } from "./lib/prompts.mjs";
import { redact } from "./lib/redact.mjs";
import { fileStateStore } from "./lib/state.mjs";
import { NONINTERACTIVE_HELP, runSetup } from "./lib/setup.mjs";
import { verifyDeployment } from "./lib/verify.mjs";
import { WranglerError, createWranglerAdapter } from "./lib/wrangler.mjs";

const MIN_NODE_MAJOR = 22;

/** Turn a Wrangler failure into something the user can act on. */
function explain(error, accountId) {
  const dashboard = accountId
    ? `https://dash.cloudflare.com/${accountId}/workers/onboarding`
    : "https://dash.cloudflare.com/ → Workers & Pages → Subdomain";
  switch (error.kind) {
    case "workers_dev_subdomain":
      return [
        "Your Cloudflare account has no workers.dev subdomain yet, and Wrangler could not register one.",
        `Create it here: ${dashboard}`,
        "Then run `npm run setup` again — it keeps the account, Worker and secrets from this run.",
      ].join("\n");
    case "cloudflare_auth":
      return `Cloudflare rejected the credentials: ${error.message}\nRun \`npx wrangler login\`, then \`npm run setup\` again.`;
    case "secret_upload":
      return [
        `Uploading the secrets failed: ${error.message}`,
        "Wrangler reported a failure, but a secret can still have been applied on Cloudflare before the connection dropped.",
        "Do not assume the previous token (or password) is still in place, and do not assume the new one is.",
        "Re-run `npm run setup`, inspect `npx wrangler secret list --name <worker>`, and paste or rotate as needed.",
      ].join("\n");
    case "deploy":
      return `The deploy failed: ${error.message}\nThe secrets that were uploaded are kept. Run \`npm run setup\` again — it will deploy again, then verify.`;
    case "dependencies":
      return `${error.message}\n${error.hint ?? "Run `npm ci`, then `npm run setup`."}`;
    default:
      return `${error.message}${error.hint ? `\n${error.hint}` : ""}`;
  }
}

async function main() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    console.error(`This setup needs Node ${MIN_NODE_MAJOR} or newer; you are running ${process.versions.node}.`);
    return 2;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(NONINTERACTIVE_HELP);
    return 2;
  }

  const secrets = [];
  const store = fileStateStore();
  const prompts = createPrompts();
  const log = (text = "") => prompts.print(text);

  try {
    const wrangler = createWranglerAdapter({ secrets, log });
    const result = await runSetup({
      prompts,
      wrangler,
      state: {
        read: () => store.read(),
        write: (state) => store.write(state, secrets),
        path: store.path,
      },
      verify: verifyDeployment,
      writeConfig: (fragment) => writeGeneratedConfig(fragment),
      baseConfig: readBaseConfig(),
      generateToken: () => randomBytes(32).toString("base64url"),
      registerSecret: (secret) => secrets.push(secret),
      interactive: true,
      log,
    });
    if (result.message) {
      log("");
      log(result.message);
    }
    return result.code;
  } catch (error) {
    log("");
    if (error instanceof AbortedError) {
      log("Cancelled. Nothing further was changed — run `npm run setup` again to continue where you left off.");
      return 130;
    }
    if (error instanceof WranglerError) {
      log(explain(error, store.read()?.accountId));
      return error.exitCode ?? 1;
    }
    log(redact(error instanceof Error ? (error.stack ?? error.message) : String(error), secrets));
    return 1;
  }
}

process.exitCode = await main();
