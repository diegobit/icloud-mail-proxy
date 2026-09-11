// Exercises the real subprocess adapter against a fake wrangler CLI: argument
// arrays, secrets on stdin only, Wrangler's machine-readable output file, and
// the error classes the setup flow branches on.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WranglerError, createWranglerAdapter } from "../../scripts/lib/wrangler.mjs";
import { repoRoot } from "../../scripts/lib/paths.mjs";

const fakeBin = fileURLToPath(new URL("./fake-wrangler.mjs", import.meta.url));
const PASSWORD = "abcd-efgh-ijkl-mnop";
const TOKEN = "sekret-api-token-0123456789";

let logFile;

beforeEach(() => {
  logFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fake-wrangler-")), "calls.ndjson");
  process.env.FAKE_WRANGLER_LOG = logFile;
});

afterEach(() => {
  delete process.env.FAKE_WRANGLER_LOG;
  delete process.env.FAKE_WRANGLER_LOGGED_OUT;
  fs.rmSync(path.dirname(logFile), { recursive: true, force: true });
});

function calls() {
  if (!fs.existsSync(logFile)) return [];
  return fs
    .readFileSync(logFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

const adapter = (secrets = []) => createWranglerAdapter({ bin: fakeBin, secrets });

describe("dependency check", () => {
  it("asks for `npm ci` when wrangler is not installed", () => {
    expect(() => createWranglerAdapter({ bin: path.join(repoRoot, "node_modules", "nope", "wrangler.js") })).toThrow(
      /not installed/,
    );
    try {
      createWranglerAdapter({ bin: "/nope/wrangler.js" });
    } catch (error) {
      expect(error.kind).toBe("dependencies");
      expect(error.exitCode).toBe(2);
      expect(error.hint).toMatch(/npm ci/);
    }
  });
});

describe("account discovery", () => {
  it("parses accounts out of noisy `whoami --json` output", async () => {
    const who = await adapter().whoami();
    expect(who).toMatchObject({ loggedIn: true, email: "user@example.com" });
    expect(who.accounts).toEqual([
      { id: "acc-1", name: "Work" },
      { id: "acc-2", name: "Personal" },
    ]);
    expect(calls()[0].argv).toEqual(["whoami", "--json"]);
  });

  it("reports an expired login without throwing", async () => {
    process.env.FAKE_WRANGLER_LOGGED_OUT = "expired";
    const who = await adapter().whoami();
    expect(who.loggedIn).toBe(false);
    expect(who.accounts).toEqual([]);
  });

  it("reports a never-logged-in user, whose status arrives as JSON on stdout", async () => {
    process.env.FAKE_WRANGLER_LOGGED_OUT = "never";
    const who = await adapter().whoami();
    expect(who.loggedIn).toBe(false);
    expect(who.accounts).toEqual([]);
  });
});

describe("existing Worker detection", () => {
  it("returns the secret names of an existing Worker", async () => {
    const info = await adapter().inspectWorker({ name: "icloud-mail-proxy", accountId: "acc-2" });
    expect(info).toEqual({ exists: true, secretNames: ["API_TOKEN"] });
    expect(calls()[0].argv).toEqual(["secret", "list", "--name", "icloud-mail-proxy", "--format", "json"]);
    expect(calls()[0].accountId).toBe("acc-2");
  });

  it("recognizes Wrangler's not-found error as absence", async () => {
    expect(await adapter().inspectWorker({ name: "missing", accountId: "acc-1" })).toEqual({
      exists: false,
      secretNames: [],
    });
  });

  it("does not mistake an authentication error for absence", async () => {
    await expect(adapter().inspectWorker({ name: "authfail", accountId: "acc-1" })).rejects.toMatchObject({
      kind: "cloudflare_auth",
    });
  });

  it("treats an empty secret list as a Worker with no secrets", async () => {
    expect(await adapter().inspectWorker({ name: "emptysecrets", accountId: "acc-1" })).toEqual({
      exists: true,
      secretNames: [],
    });
  });

  it("throws when secret list output is not a JSON array", async () => {
    await expect(adapter().inspectWorker({ name: "notjson" })).rejects.toThrow(/could not parse/);
    await expect(adapter().inspectWorker({ name: "notarray" })).rejects.toThrow(/could not parse/);
    await expect(adapter().inspectWorker({ name: "badentry" })).rejects.toThrow(/malformed entry/);
  });
});

describe("secret transport", () => {
  it("sends secrets on stdin and never as arguments", async () => {
    const values = { ICLOUD_USER: "me@icloud.com", ICLOUD_APP_PASSWORD: PASSWORD, API_TOKEN: TOKEN };
    const result = await adapter([PASSWORD, TOKEN]).putSecrets({ name: "icloud-mail-proxy", accountId: "acc-2", values });

    expect(result.uploaded).toEqual(["ICLOUD_USER", "ICLOUD_APP_PASSWORD", "API_TOKEN"]);
    const [call] = calls();
    expect(call.argv).toEqual(["secret", "bulk", "--name", "icloud-mail-proxy"]);
    expect(call.argv.join(" ")).not.toContain(PASSWORD);
    expect(call.argv.join(" ")).not.toContain(TOKEN);
    expect(JSON.parse(call.stdin)).toEqual(values);
  });

  it("uploads nothing when there is nothing to change", async () => {
    expect(await adapter().putSecrets({ name: "icloud-mail-proxy", values: {} })).toEqual({ uploaded: [] });
    expect(calls()).toHaveLength(0);
  });

  it("redacts secret values that appear in a failure message", async () => {
    const failing = adapter([PASSWORD, TOKEN]).putSecrets({
      name: "boom",
      accountId: "acc-1",
      values: { API_TOKEN: TOKEN },
    });
    await expect(failing).rejects.toBeInstanceOf(WranglerError);
    await failing.catch((error) => {
      expect(error.kind).toBe("secret_upload");
      expect(error.message).not.toContain(TOKEN);
      expect(error.message).toContain("[redacted]");
    });
  });
});

describe("deploy", () => {
  it("reads the deployed URL from Wrangler's output file", async () => {
    const result = await adapter().deploy({ configPath: "/tmp/wrangler.local.jsonc", accountId: "acc-2" });
    expect(result.targets).toEqual(["https://w.personal.workers.dev"]);
    expect(result.versionId).toBe("ver-1");
    const [call] = calls();
    expect(call.argv).toEqual(["deploy", "-c", "/tmp/wrangler.local.jsonc"]);
    expect(call.outputFile).toMatch(/wrangler-output-[0-9a-f]{16}\.ndjson$/);
    // The temporary output file is cleaned up.
    expect(fs.existsSync(call.outputFile)).toBe(false);
  });

  it("keeps a custom-domain target as reported", async () => {
    const result = await adapter().deploy({ configPath: "/tmp/wrangler.production.jsonc" });
    expect(result.targets).toEqual(["https://icloud-mail.diegobit.com (custom domain)"]);
  });

  it("reports a dry run as publishing nothing", async () => {
    const result = await adapter().deploy({ configPath: "/tmp/wrangler.local.jsonc", extraArgs: ["--dry-run"] });
    expect(result).toMatchObject({ dryRun: true, targets: [] });
    expect(calls()[0].argv).toEqual(["deploy", "-c", "/tmp/wrangler.local.jsonc", "--dry-run"]);
  });

  it("errors when a real deploy reports no structured deploy entry", async () => {
    await expect(adapter().deploy({ configPath: "/tmp/wrangler.no-output.jsonc" })).rejects.toThrow(
      /reported no deploy target/,
    );
  });

  it("errors when the deploy entry is malformed", async () => {
    await expect(adapter().deploy({ configPath: "/tmp/wrangler.bad-targets.jsonc" })).rejects.toThrow(
      /malformed deploy entry/,
    );
  });

  it("classifies a missing workers.dev subdomain", async () => {
    await expect(adapter().deploy({ configPath: "/tmp/wrangler.no-subdomain.jsonc" })).rejects.toMatchObject({
      kind: "workers_dev_subdomain",
    });
  });
});
