#!/usr/bin/env node
// Read-only iCloud IMAP probe for UTF-8 search (plans/utf8-search.md,
// plans/feature-gap-roadmap.md unit 4b).
//
// Answers: which capabilities imap.mail.me.com advertises (UTF8=ACCEPT,
// LITERAL+, LITERAL-), whether `SEARCH CHARSET UTF-8` is accepted with a
// quoted ASCII term and with a synchronizing literal carrying non-ASCII bytes,
// and how the server answers the `+` continuation.
//
// Only LOGIN, CAPABILITY, EXAMINE (read-only), SEARCH and LOGOUT are ever
// sent; the command helper refuses anything else. Nothing is printed except
// capabilities, status lines with the server text, and result counts: no
// message ids, subjects or addresses.
//
// Usage: node scripts/probe-imap-search.mjs [--env-file .dev.vars] [--mailbox Archive]
//
// iCloud omits the untagged `* SEARCH` line when nothing matches, so a
// missing line is reported as zero matches.

import fs from "node:fs";
import tls from "node:tls";

const ALLOWED = new Set(["LOGIN", "CAPABILITY", "EXAMINE", "SEARCH", "LOGOUT"]);

function parseArgs(argv) {
  const options = { envFile: ".dev.vars", json: false, mailbox: "Archive" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env-file") options.envFile = argv[++i];
    else if (argv[i] === "--mailbox") options.mailbox = argv[++i];
    else if (argv[i] === "--json") options.json = true;
  }
  return options;
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

const options = parseArgs(process.argv.slice(2));
const fileEnv = readEnvFile(options.envFile);
const user = process.env.ICLOUD_USER ?? fileEnv.ICLOUD_USER;
const password = process.env.ICLOUD_APP_PASSWORD ?? fileEnv.ICLOUD_APP_PASSWORD;
if (!user || !password) {
  console.error("Missing ICLOUD_USER / ICLOUD_APP_PASSWORD (environment or --env-file).");
  process.exit(2);
}

function quote(value) {
  if (/[\r\n\0]/.test(value) || /[^\x20-\x7e]/.test(value)) throw new Error("refusing to quote a non-ASCII value");
  return `"${value.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

const socket = tls.connect({ host: "imap.mail.me.com", port: 993, servername: "imap.mail.me.com" });
socket.setTimeout(20_000, () => socket.destroy(new Error("timeout")));
let buffer = Buffer.alloc(0);
const waiters = [];
socket.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  pump();
});
socket.on("error", (error) => {
  for (const waiter of waiters.splice(0)) waiter.reject(error);
});

function pump() {
  for (;;) {
    const index = buffer.indexOf("\r\n");
    if (index < 0 || waiters.length === 0) return;
    const line = buffer.subarray(0, index).toString("utf8");
    buffer = buffer.subarray(index + 2);
    waiters[0].onLine(line);
  }
}

function nextLines(until) {
  return new Promise((resolve, reject) => {
    const lines = [];
    const waiter = {
      reject,
      onLine(line) {
        lines.push(line);
        if (until(line)) {
          waiters.shift();
          resolve(lines);
        }
      },
    };
    waiters.push(waiter);
    pump();
  });
}

let counter = 0;

/**
 * Send one command. `parts` alternates text and literals: a literal is sent
 * as {N}\r\n, then (after the server's "+") its bytes.
 */
async function command(verb, parts = []) {
  if (!ALLOWED.has(verb)) throw new Error(`refusing ${verb}: this probe is read-only`);
  const tag = `p${++counter}`;
  const transcript = { continuation: null };
  let pending = `${tag} ${verb}`;
  for (const part of parts) {
    if (typeof part === "string") {
      pending += ` ${part}`;
      continue;
    }
    const bytes = Buffer.from(part.literal, "utf8");
    socket.write(`${pending} {${bytes.length}}\r\n`);
    const reply = await nextLines((line) => line.startsWith("+") || line.startsWith(`${tag} `));
    const last = reply.at(-1);
    if (!last.startsWith("+")) return { tag, lines: reply, ...transcript };
    transcript.continuation = last;
    socket.write(bytes);
    pending = "";
  }
  socket.write(`${pending}\r\n`);
  const lines = await nextLines((line) => line.startsWith(`${tag} `));
  return { tag, lines, ...transcript };
}

function summarize(result) {
  const status = result.lines.at(-1);
  const counts = result.lines
    .filter((line) => line.startsWith("* SEARCH"))
    .map((line) => line.slice("* SEARCH".length).trim().split(/\s+/).filter(Boolean).length);
  return {
    status: status.replace(/^\S+ /, ""),
    untagged: [...new Set(result.lines.slice(0, -1).map((line) => line.split(" ").slice(0, 2).join(" ")))],
    matches: counts.reduce((a, b) => a + b, 0),
    continuation: result.continuation,
  };
}

const report = {};
try {
  const greeting = await nextLines(() => true);
  report.greeting = greeting[0].replace(/\[.*?\]/, "[…]").slice(0, 80);
  const before = await command("CAPABILITY");
  report.capabilitiesBeforeLogin = before.lines.find((line) => line.startsWith("* CAPABILITY")) ?? null;
  const login = await command("LOGIN", [quote(user), quote(password)]);
  report.login = /^\S+ (OK|NO|BAD)\b/.exec(login.lines.at(-1))?.[1] ?? "unknown";
  const capability = await command("CAPABILITY");
  const caps = (capability.lines.find((line) => line.startsWith("* CAPABILITY")) ?? "").split(" ").slice(2);
  report.capabilities = caps;
  report.utf8Accept = caps.includes("UTF8=ACCEPT");
  report.literalPlus = caps.includes("LITERAL+");
  report.literalMinus = caps.includes("LITERAL-");
  const examine = await command("EXAMINE", [quote(options.mailbox)]);
  report.examine = examine.lines.at(-1).replace(/^\S+ /, "");

  const since = "SINCE 01-Jan-2026";
  report.mailbox = options.mailbox;
  report.baselineSince = summarize(await command("SEARCH", [since]));
  report.searchAsciiNoCharset = summarize(await command("SEARCH", [since, "SUBJECT", quote("the")]));
  report.searchAsciiCharsetUtf8 = summarize(await command("SEARCH", ["CHARSET", "UTF-8", since, "SUBJECT", quote("the")]));
  report.searchLiteralAsciiCharsetUtf8 = summarize(
    await command("SEARCH", ["CHARSET", "UTF-8", since, "SUBJECT", { literal: "the" }]),
  );
  report.searchLiteralNonAscii = summarize(
    await command("SEARCH", ["CHARSET", "UTF-8", since, "TEXT", { literal: "perché" }]),
  );
  report.searchLiteralNonAsciiSubject = summarize(
    await command("SEARCH", ["CHARSET", "UTF-8", since, "SUBJECT", { literal: "è" }]),
  );
  report.searchLiteralNonAsciiText = summarize(
    await command("SEARCH", ["CHARSET", "UTF-8", since, "TEXT", { literal: "è" }]),
  );
  report.searchLiteralNonAsciiFrom = summarize(
    await command("SEARCH", ["CHARSET", "UTF-8", since, "FROM", { literal: "ü" }]),
  );
  report.searchLiteralNonAsciiNoMatch = summarize(
    await command("SEARCH", ["CHARSET", "UTF-8", since, "SUBJECT", { literal: "zzqxjvé€" }]),
  );
  report.searchLiteralNoCharset = summarize(await command("SEARCH", [since, "TEXT", { literal: "è" }]));
  report.searchUnknownCharset = summarize(
    await command("SEARCH", ["CHARSET", "X-NO-SUCH-CHARSET", since, "SUBJECT", quote("the")]),
  );
  report.searchLiteralNonAsciiWithoutCharset = summarize(await command("SEARCH", [since, "TEXT", { literal: "perché" }]));
  // OR / NOT consistency: |A or B| = |A| + |B| - |A and B|, |not A| = total - |A|.
  const a = ["FROM", quote("apple")];
  const b = ["FROM", quote("amazon")];
  report.boolean = {
    a: summarize(await command("SEARCH", [since, ...a])).matches,
    b: summarize(await command("SEARCH", [since, ...b])).matches,
    both: summarize(await command("SEARCH", [since, ...a, ...b])).matches,
    either: summarize(await command("SEARCH", [since, "OR", ...a, ...b])).matches,
    notA: summarize(await command("SEARCH", [since, "NOT", ...a])).matches,
    substringFromApp: summarize(await command("SEARCH", [since, "FROM", quote("appl")])).matches,
  };
  report.searchFlaggedUnflagged = {
    flagged: summarize(await command("SEARCH", [since, "FLAGGED"])).status,
    unflagged: summarize(await command("SEARCH", [since, "UNFLAGGED"])).status,
  };
  await command("LOGOUT");
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  socket.end();
}

console.log(JSON.stringify(report, null, 2));
process.exit(report.error ? 1 : 0);
