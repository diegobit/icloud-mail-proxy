// Process adapter for the installed Wrangler. Every call is an argument array
// (no shell), secrets travel on stdin only, and structured results come from
// Wrangler's own machine-readable output file rather than screen-scraping.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { repoRoot, wranglerBin } from "./paths.mjs";
import { redact } from "./redact.mjs";

/** A failure we can explain: `kind` drives the message the user sees. */
export class WranglerError extends Error {
  constructor(message, { kind = "wrangler", exitCode = 1, hint } = {}) {
    super(message);
    this.name = "WranglerError";
    this.kind = kind;
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

function classify(text) {
  if (/register a workers\.dev subdomain|workers\/onboarding|workers\.dev subdomain/i.test(text)) {
    return "workers_dev_subdomain";
  }
  if (/not logged in|authentication error|CLOUDFLARE_API_TOKEN|\[code: 10000\]/i.test(text)) {
    return "cloudflare_auth";
  }
  return "wrangler";
}

function readEntries(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((entry) => entry !== null);
  } catch {
    return [];
  }
}

/** Pull the first JSON value out of noisy stdout. */
function extractJson(stdout, open, close) {
  const start = stdout.indexOf(open);
  const end = stdout.lastIndexOf(close);
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function createWranglerAdapter({
  bin = wranglerBin,
  cwd = repoRoot,
  node = process.execPath,
  secrets = [],
  log = () => {},
} = {}) {
  if (!fs.existsSync(bin)) {
    throw new WranglerError(`Wrangler is not installed at ${bin}`, {
      kind: "dependencies",
      exitCode: 2,
      hint: "Run `npm ci` in the repository, then start setup again.",
    });
  }

  function run(args, { input, inherit = false, accountId, outputFile } = {}) {
    return new Promise((resolve, reject) => {
      const env = { ...process.env };
      if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
      if (outputFile) env.WRANGLER_OUTPUT_FILE_PATH = outputFile;
      const stdio = inherit
        ? [input === undefined ? "inherit" : "pipe", "inherit", "inherit"]
        : ["pipe", "pipe", "pipe"];
      const child = spawn(node, [bin, ...args], { cwd, env, stdio });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => (stdout += chunk));
      child.stderr?.on("data", (chunk) => (stderr += chunk));
      child.on("error", (err) =>
        reject(new WranglerError(`could not run wrangler: ${err.message}`, { kind: "dependencies", exitCode: 2 })),
      );
      if (child.stdin && input !== undefined) {
        child.stdin.end(input);
      } else if (child.stdin && !inherit) {
        child.stdin.end();
      }
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }

  /** Run wrangler with its machine-readable output file enabled. */
  async function runWithOutput(args, options = {}) {
    const file = path.join(os.tmpdir(), `wrangler-output-${randomBytes(8).toString("hex")}.ndjson`);
    try {
      const result = await run(args, { ...options, outputFile: file });
      return { ...result, entries: readEntries(file) };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  return {
    async version() {
      const { code, stdout, stderr } = await run(["--version"]);
      if (code !== 0) {
        throw new WranglerError(redact(stderr || "wrangler --version failed", secrets), {
          kind: "dependencies",
          exitCode: 2,
        });
      }
      return (/\d+\.\d+\.\d+/.exec(stdout) ?? ["unknown"])[0];
    },

    /**
     * `{ loggedIn, accounts: [{ id, name }], email }`. Never prompts.
     * Wrangler reports "never logged in" as `{"loggedIn":false}` on stdout with
     * a non-zero exit, and an expired token as an error on stderr; both mean
     * the same thing to us.
     */
    async whoami() {
      const { code, stdout, stderr } = await run(["whoami", "--json"]);
      const info = extractJson(stdout, "{", "}");
      if (info?.loggedIn === false) return { loggedIn: false, accounts: [] };
      if (code !== 0) {
        const text = redact(stderr, secrets);
        if (/not logged in|not authenticated|no credentials|CLOUDFLARE_API_TOKEN|wrangler login/i.test(text)) {
          return { loggedIn: false, accounts: [], reason: text.trim() };
        }
        throw new WranglerError(text.trim() || "wrangler whoami failed", { kind: classify(text) });
      }
      if (!info) throw new WranglerError("could not read `wrangler whoami --json` output", { kind: "wrangler" });
      return {
        loggedIn: info.loggedIn !== false,
        email: info.email ?? null,
        accounts: (info.accounts ?? []).map((a) => ({ id: a.id, name: a.name })),
      };
    },

    /** Interactive OAuth login; Wrangler owns the terminal and the browser. */
    async login() {
      log("Opening Cloudflare's login page in your browser…");
      const { code } = await run(["login"], { inherit: true });
      if (code !== 0) {
        throw new WranglerError("`wrangler login` did not complete", {
          kind: "cloudflare_auth",
          hint: "Run `npx wrangler login` yourself, then re-run `npm run setup`.",
        });
      }
    },

    /**
     * Existence probe and secret inventory in one call: Wrangler cannot return
     * secret values, only names.
     */
    async inspectWorker({ name, accountId }) {
      const { code, stdout, stderr } = await run(["secret", "list", "--name", name, "--format", "json"], {
        accountId,
      });
      if (code === 0) {
        const parsed = extractJson(stdout, "[", "]");
        if (!Array.isArray(parsed)) {
          throw new WranglerError("could not parse `wrangler secret list --format json` output as an array", {
            kind: "wrangler",
          });
        }
        const secretNames = [];
        for (const entry of parsed) {
          if (!entry || typeof entry !== "object" || typeof entry.name !== "string" || entry.name.length === 0) {
            throw new WranglerError("malformed entry in `wrangler secret list` output", { kind: "wrangler" });
          }
          secretNames.push(entry.name);
        }
        return { exists: true, secretNames };
      }
      const text = redact(stderr, secrets);
      if (/not found/i.test(text) && text.includes(name)) {
        return { exists: false, secretNames: [] };
      }
      throw new WranglerError(text.trim() || `could not inspect Worker "${name}"`, { kind: classify(text) });
    },

    /** Upload secrets as JSON on stdin. Values never appear in argv or on disk. */
    async putSecrets({ name, accountId, values }) {
      const keys = Object.keys(values);
      if (keys.length === 0) return { uploaded: [] };
      const { code, stdout, stderr } = await run(["secret", "bulk", "--name", name], {
        accountId,
        input: JSON.stringify(values),
      });
      if (code !== 0) {
        const text = redact(`${stderr}\n${stdout}`, secrets);
        throw new WranglerError(text.trim() || "uploading secrets failed", {
          kind: classify(text) === "wrangler" ? "secret_upload" : classify(text),
          hint: "No deploy was attempted. Re-run `npm run setup` to try again.",
        });
      }
      return { uploaded: keys };
    },

    /** Deploy with an explicit config path; returns the URLs Wrangler reports. */
    async deploy({ configPath, accountId, extraArgs = [] }) {
      const { code, entries } = await runWithOutput(["deploy", "-c", configPath, ...extraArgs], {
        accountId,
        inherit: true,
      });
      const deployEntry = entries.find((entry) => entry.type === "deploy");
      if (code !== 0) {
        const failure = entries.find((entry) => entry.type === "command-failed");
        const text = redact(failure?.message ?? "", secrets);
        const kind = classify(text);
        throw new WranglerError(text.trim() || "`wrangler deploy` failed; see the output above", {
          kind: kind === "wrangler" ? "deploy" : kind,
        });
      }
      if (extraArgs.includes("--dry-run")) {
        return { targets: [], versionId: null, workerName: null, dryRun: true };
      }
      if (!deployEntry) {
        throw new WranglerError("`wrangler deploy` succeeded but reported no deploy target", { kind: "deploy" });
      }
      if (deployEntry.targets !== undefined && !Array.isArray(deployEntry.targets)) {
        throw new WranglerError("`wrangler deploy` reported a malformed deploy entry", { kind: "deploy" });
      }
      const targets = (deployEntry.targets ?? []).map((target) =>
        /^https?:\/\//.test(target) ? target : `https://${target}`,
      );
      return { targets, versionId: deployEntry.version_id ?? null, workerName: deployEntry.worker_name ?? null };
    },
  };
}
