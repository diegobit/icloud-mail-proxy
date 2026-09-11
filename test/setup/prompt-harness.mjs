#!/usr/bin/env node
// Real-TTY harness for prompt-adapter tests. Writes JSON to $HARNESS_OUT so the
// driver can assert on answers without putting secrets on the PTY.

import fs from "node:fs";
import { spawn } from "node:child_process";
import { AbortedError, createPrompts } from "../../scripts/lib/prompts.mjs";

const mode = process.argv[2];
const outFile = process.env.HARNESS_OUT;
if (!outFile) {
  console.error("HARNESS_OUT is required");
  process.exit(2);
}

function writeResult(obj) {
  fs.writeFileSync(outFile, `${JSON.stringify(obj)}\n`);
}

const prompts = createPrompts();

try {
  if (mode === "text") {
    const answer = await prompts.text("Your name");
    writeResult({ answer });
  } else if (mode === "secret") {
    const answer = await prompts.secret("Password");
    writeResult({ answer });
  } else if (mode === "handoff") {
    const answer = await prompts.text("Worker name");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `let s=""; process.stdin.setEncoding("utf8");
         process.stdin.on("data", c => { s += c; if (/[\\n\\r]/.test(s)) { process.stdout.write("CHILD:"+JSON.stringify(s)+"\\n"); process.exit(0); } });
         setTimeout(() => { process.stdout.write("CHILD_TIMEOUT:"+JSON.stringify(s)+"\\n"); process.exit(2); }, 5000);`,
      ],
      { stdio: ["inherit", "pipe", "inherit"] },
    );
    process.stderr.write("READY_FOR_CHILD\n");
    const childOut = await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => (buf += c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, buf }));
    });
    writeResult({ answer, child: childOut });
  } else {
    writeResult({ error: `unknown mode ${mode}` });
    process.exit(2);
  }
} catch (error) {
  if (error instanceof AbortedError) {
    writeResult({ aborted: true, message: error.message });
    process.exit(130);
  }
  writeResult({ error: error instanceof Error ? error.stack : String(error) });
  process.exit(1);
}
