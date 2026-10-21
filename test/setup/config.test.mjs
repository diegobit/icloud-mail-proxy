import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  composeConfig,
  profileFragment,
  readBaseConfig,
  readProfiles,
  stateFragment,
  writeGeneratedConfig,
} from "../../scripts/lib/config.mjs";
import { parseJsonc, stripJsonc } from "../../scripts/lib/jsonc.mjs";
import { NO_TARGET_HELP, parseArgs, resolveTarget, UsageError } from "../../scripts/lib/target.mjs";
import { repoRoot } from "../../scripts/lib/paths.mjs";

describe("JSONC reading", () => {
  it("keeps comment-like text inside strings", () => {
    const text = '{ "a": "http://x/y", /* drop */ "b": "// not a comment" // drop\n}';
    expect(parseJsonc(text)).toEqual({ a: "http://x/y", b: "// not a comment" });
  });

  it("drops trailing commas and reports the source on bad input", () => {
    expect(stripJsonc('{ "a": [1, 2,], }')).toContain("[1, 2]");
    expect(() => parseJsonc("{ nope", "wrangler.base.jsonc")).toThrow(/wrangler\.base\.jsonc is not valid JSONC/);
  });

  it("does not rewrite a string that merely looks like a trailing comma", () => {
    expect(parseJsonc('{ "weird": "value,}" }')).toEqual({ weird: "value,}" });
    expect(parseJsonc('{ "folders": "INBOX,Archive", }')).toEqual({ folders: "INBOX,Archive" });
    expect(parseJsonc('{ "a": "x,}", }')).toEqual({ a: "x,}" });
    expect(stripJsonc('{ "weird": "value,}" }')).toContain('"value,}"');
  });
});

describe("tracked configuration", () => {
  const base = readBaseConfig();

  it("carries no personal deployment identity", () => {
    expect(base.routes).toBeUndefined();
    expect(base.account_id).toBeUndefined();
    expect(base.workers_dev).toBe(true);
    expect(JSON.stringify(base)).not.toMatch(/diegobit/);
  });

  it("is not discoverable as a bare `wrangler deploy` target", () => {
    for (const name of ["wrangler.json", "wrangler.jsonc", "wrangler.toml"]) {
      expect(fs.existsSync(path.join(repoRoot, name))).toBe(false);
    }
  });
});

describe("composing a deployable config", () => {
  const base = readBaseConfig();

  it("preserves the production route and disables workers.dev", () => {
    const config = composeConfig(base, profileFragment("production", readProfiles()), path.join(repoRoot, ".deploy"));
    expect(config.routes).toEqual([{ pattern: "icloud-mail.diegobit.com", custom_domain: true }]);
    expect(config.workers_dev).toBe(false);
    // Inherited, not duplicated, from the tracked defaults.
    expect(config.compatibility_date).toBe(base.compatibility_date);
    expect(config.vars.MAX_MESSAGE_BYTES).toBe(base.vars.MAX_MESSAGE_BYTES);
    expect(config.description).toBeUndefined();
  });

  it("carries the OAuth bindings and flags into every target", () => {
    const configs = [
      composeConfig(base, profileFragment("production", readProfiles()), path.join(repoRoot, ".deploy")),
      composeConfig(base, stateFragment({ accountId: "acc-9", workerName: "my-mail" }), path.join(repoRoot, ".deploy")),
    ];
    for (const config of configs) {
      expect(config.compatibility_flags).toEqual(["nodejs_compat", "global_fetch_strictly_public"]);
      // Deliberately id-less: wrangler provisions the namespace on first deploy.
      expect(config.kv_namespaces).toEqual([{ binding: "OAUTH_KV" }]);
      expect(config.ratelimits).toEqual([
        { name: "OAUTH_REGISTER_LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } },
        { name: "OAUTH_TOKEN_LIMITER", namespace_id: "1002", simple: { limit: 30, period: 60 } },
        { name: "CALENDAR_WRITE_LIMITER", namespace_id: "1003", simple: { limit: 30, period: 60 } },
      ]);
    }
  });

  it("rewrites relative paths for the generated config's directory", () => {
    const config = composeConfig(base, profileFragment("production", readProfiles()), path.join(repoRoot, ".deploy"));
    expect(config.main).toBe("../src/index.ts");
    expect(config.$schema).toBe("../node_modules/wrangler/config-schema.json");
    expect(fs.existsSync(path.resolve(repoRoot, ".deploy", config.main))).toBe(true);
  });

  it("overrides only the folders for a guided setup target", () => {
    const fragment = stateFragment({ accountId: "acc-9", workerName: "my-mail", allowedMailboxes: "INBOX" });
    const config = composeConfig(base, fragment, path.join(repoRoot, ".deploy"));
    expect(config.name).toBe("my-mail");
    expect(config.account_id).toBe("acc-9");
    expect(config.workers_dev).toBe(true);
    expect(config.routes).toBeUndefined();
    expect(config.vars.ALLOWED_MAILBOXES).toBe("INBOX");
    expect(config.vars.MAX_RESULTS).toBe(base.vars.MAX_RESULTS);
  });

  it("refuses a target with a typo or no Worker name", () => {
    expect(() => composeConfig(base, { label: "x", name: "a", route: "oops" }, "/tmp")).toThrow(/unsupported key "route"/);
    expect(() => composeConfig(base, { label: "x" }, "/tmp")).toThrow(/missing a Worker name/);
  });

  it("writes a generated config marked as generated", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-mail-config-"));
    const file = writeGeneratedConfig(stateFragment({ accountId: "a", workerName: "w" }), { base, dir });
    const text = fs.readFileSync(file, "utf8");
    expect(file).toBe(path.join(dir, "wrangler.local.jsonc"));
    expect(text).toMatch(/^\/\/ Generated by scripts\/deploy\.mjs/);
    expect(parseJsonc(text).name).toBe("w");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("target selection", () => {
  it("has no fallback when setup has not run and no profile is given", () => {
    const { fragment, error } = resolveTarget({ profile: null, state: null, profiles: readProfiles() });
    expect(fragment).toBeUndefined();
    expect(error).toBe(NO_TARGET_HELP);
    expect(error).toContain("npm run setup");
  });

  it("names the known profiles when one is misspelled", () => {
    const { error } = resolveTarget({ profile: "prod", state: null, profiles: readProfiles() });
    expect(error).toMatch(/unknown deployment profile "prod".*production/);
  });

  it("prefers an explicit profile over recorded setup state", () => {
    const state = { accountId: "acc-1", workerName: "someone-elses-worker" };
    expect(resolveTarget({ profile: "production", state, profiles: readProfiles() }).fragment.name).toBe(
      "icloud-mail-proxy",
    );
    expect(resolveTarget({ profile: null, state, profiles: readProfiles() }).fragment.name).toBe(
      "someone-elses-worker",
    );
  });

  it("passes unknown flags through to wrangler", () => {
    expect(parseArgs(["--profile", "production", "--dry-run"])).toMatchObject({
      profile: "production",
      passthrough: ["--dry-run"],
    });
    expect(parseArgs(["--config=x.jsonc", "--", "--outdir", "out"])).toMatchObject({
      configPath: "x.jsonc",
      passthrough: ["--outdir", "out"],
    });
    expect(parseArgs(["--print-config"]).printOnly).toBe(true);
  });

  it("rejects a missing, empty, or option-as-value selector before anything else", () => {
    expect(() => parseArgs(["--profile"])).toThrow(UsageError);
    expect(() => parseArgs(["--profile"])).toThrow(/--profile requires a value/);
    expect(() => parseArgs(["--profile="])).toThrow(/--profile requires a value/);
    expect(() => parseArgs(["--profile", "--dry-run"])).toThrow(/not --dry-run/);
    expect(() => parseArgs(["--config"])).toThrow(/--config requires a value/);
    expect(() => parseArgs(["--config="])).toThrow(/--config requires a value/);
    expect(() => parseArgs(["-c", "--print-config"])).toThrow(/not --print-config/);
  });

  it("rejects conflicting selectors", () => {
    expect(() => parseArgs(["--profile", "production", "--config", "x.jsonc"])).toThrow(/either --profile or --config/);
    expect(() => parseArgs(["--profile", "a", "--profile", "b"])).toThrow(/conflicting --profile/);
    expect(() => parseArgs(["--config", "a.jsonc", "--config", "b.jsonc"])).toThrow(/conflicting --config/);
  });

  it("allows the same selector repeated with the same value, and keeps pass-through after --", () => {
    expect(parseArgs(["--profile", "production", "--profile", "production"]).profile).toBe("production");
    expect(parseArgs(["--", "--profile"])).toMatchObject({ profile: null, passthrough: ["--profile"] });
  });
});
