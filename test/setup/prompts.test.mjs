// Real prompt-adapter tests: not fakePrompts. Covers per-question readline
// lifecycle, EOF/cancellation, secret non-echo, and child terminal handoff
// (the bug where a held readline stole Wrangler's inherited stdin).

import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AbortedError, createPrompts } from "../../scripts/lib/prompts.mjs";

const harness = fileURLToPath(new URL("./prompt-harness.mjs", import.meta.url));
const driver = fileURLToPath(new URL("./pty-driver.py", import.meta.url));

function ttyPair() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  input.setRawMode = () => true;
  let captured = "";
  output.on("data", (chunk) => {
    captured += chunk.toString();
  });
  return {
    input,
    output,
    captured: () => captured,
    type(text) {
      input.write(text);
    },
  };
}

const tmpDirs = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function resultFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prompt-harness-"));
  tmpDirs.push(dir);
  return path.join(dir, "out.json");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function runPty(mode, payload) {
  const out = resultFile();
  const args = [driver, process.execPath, harness, mode];
  if (payload !== undefined) args.push(payload);
  const result = spawnSync("python3", args, {
    encoding: "utf8",
    env: { ...process.env, HARNESS_OUT: out },
    timeout: 15_000,
  });
  return { ...result, out, parsed: fs.existsSync(out) ? readJson(out) : null };
}

describe("per-question readline", () => {
  it("answers a text prompt and releases stdin listeners", async () => {
    const tty = ttyPair();
    const prompts = createPrompts({ input: tty.input, output: tty.output });
    const pending = prompts.text("Worker name");
    await new Promise((resolve) => setImmediate(resolve));
    tty.type("my-mail\r");
    await expect(pending).resolves.toBe("my-mail");
    expect(tty.input.listenerCount("keypress")).toBe(0);
    expect(tty.input.isPaused()).toBe(true);
    expect(tty.captured()).toContain("Worker name");
  });

  it("does not echo a secret", async () => {
    const tty = ttyPair();
    const prompts = createPrompts({ input: tty.input, output: tty.output });
    const pending = prompts.secret("Apple app-specific password");
    await new Promise((resolve) => setImmediate(resolve));
    tty.type("abcd-efgh-ijkl-mnop\r");
    await expect(pending).resolves.toBe("abcd-efgh-ijkl-mnop");
    expect(tty.captured()).toContain("Apple app-specific password");
    expect(tty.captured()).not.toContain("abcd-efgh-ijkl-mnop");
  });

  it("cancels on EOF", async () => {
    const tty = ttyPair();
    const prompts = createPrompts({ input: tty.input, output: tty.output });
    const pending = prompts.text("Your name");
    await new Promise((resolve) => setImmediate(resolve));
    tty.input.end();
    await expect(pending).rejects.toBeInstanceOf(AbortedError);
  });

  it("cancels on Ctrl-C", async () => {
    const tty = ttyPair();
    const prompts = createPrompts({ input: tty.input, output: tty.output });
    const pending = prompts.text("Your name");
    await new Promise((resolve) => setImmediate(resolve));
    tty.type("\x03");
    await expect(pending).rejects.toBeInstanceOf(AbortedError);
  });

  it("does not consume input after the prompt closes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    input.isTTY = true;
    output.isTTY = true;
    input.setRawMode = () => true;
    const prompts = createPrompts({ input, output });
    const pending = prompts.text("Worker name");
    await new Promise((resolve) => setImmediate(resolve));
    input.write("alpha\r");
    await expect(pending).resolves.toBe("alpha");
    expect(input.listenerCount("keypress")).toBe(0);
    expect(input.isPaused()).toBe(true);

    const got = await new Promise((resolve) => {
      input.once("data", resolve);
      input.resume();
      input.write("beta\n");
    });
    expect(got.toString()).toContain("beta");
  });
});

describe("scripts/setup wiring", () => {
  it("uses createPrompts and does not hold a readline interface of its own", () => {
    const src = fs.readFileSync(new URL("../../scripts/setup.mjs", import.meta.url), "utf8");
    expect(src).toContain("createPrompts()");
    expect(src).not.toContain("createInterface");
    const wrangler = fs.readFileSync(new URL("../../scripts/lib/wrangler.mjs", import.meta.url), "utf8");
    expect(wrangler).toMatch(/run\(\["login"\], \{ inherit: true \}\)/);
    expect(wrangler).toMatch(/inherit: true/);
  });
});

describe("real PTY (scripts/setup wiring)", () => {
  it("answers a text prompt", () => {
    const result = runPty("text", "hello\r");
    expect(result.status, result.stderr).toBe(0);
    expect(result.parsed.answer).toBe("hello");
  });

  it("does not echo a secret on the PTY", () => {
    const result = runPty("secret", "s3cret-pass\r");
    expect(result.status, result.stderr).toBe(0);
    expect(result.parsed.answer).toBe("s3cret-pass");
    expect(result.stdout).toContain("Password");
    expect(result.stdout).not.toContain("s3cret-pass");
  });

  it("treats EOF as cancellation", () => {
    const result = runPty("eof");
    expect(result.status).toBe(130);
    expect(result.parsed.aborted).toBe(true);
  });

  it("treats Ctrl-C as cancellation", () => {
    const result = runPty("cancel");
    expect(result.status).toBe(130);
    expect(result.parsed.aborted).toBe(true);
  });

  it("lets an inherited child read stdin after the prompt closes", () => {
    const result = runPty("handoff");
    expect(result.status, `${result.stderr}\n${result.stdout}\n${JSON.stringify(result.parsed)}`).toBe(0);
    expect(result.parsed.answer).toBe("alpha");
    expect(result.parsed.child.code).toBe(0);
    expect(result.parsed.child.buf).toMatch(/CHILD:.*beta/);
  });
});
