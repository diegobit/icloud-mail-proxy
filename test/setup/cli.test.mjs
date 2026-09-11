// The two entry points, run as real processes: exit codes and the help they
// print. None of these reach Cloudflare.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../../scripts/lib/paths.mjs";

const run = async (script, args = []) => {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [path.join(repoRoot, "scripts", script), ...args], {
      cwd: repoRoot,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

describe("npm run setup", () => {
  it("exits with actionable help when stdin is not a terminal", async () => {
    const result = await run("setup.mjs");
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("interactive terminal flow");
    expect(result.stderr).toContain("npm run setup");
    expect(result.stdout).toBe("");
  });
});

describe("npm run deploy", () => {
  it("refuses an unknown profile and names the ones that exist", async () => {
    const result = await run("deploy.mjs", ["--profile", "nope"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/unknown deployment profile "nope".*production/);
  });

  it("uses an explicit config path verbatim, without composing one", async () => {
    const result = await run("deploy.mjs", ["--config", "some/wrangler.jsonc", "--print-config"]);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("Config: some/wrangler.jsonc");
  });

  it("rejects a missing --profile value before writing or deploying", async () => {
    const result = await run("deploy.mjs", ["--profile"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--profile requires a value");
    expect(result.stdout).toBe("");
  });

  it("rejects --profile and --config together", async () => {
    const result = await run("deploy.mjs", ["--profile", "production", "--config", "x.jsonc"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("either --profile or --config");
    expect(result.stdout).toBe("");
  });
});
