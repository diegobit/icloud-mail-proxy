// Stands in for the wrangler CLI in wrangler-adapter.test.mjs. Records how it
// was invoked (argv, stdin, relevant env) into $FAKE_WRANGLER_LOG so the test
// can prove secrets travel on stdin and never as arguments.

import fs from "node:fs";

const args = process.argv.slice(2);

function record(stdin) {
  if (process.env.FAKE_WRANGLER_LOG) {
    fs.appendFileSync(
      process.env.FAKE_WRANGLER_LOG,
      `${JSON.stringify({
        argv: args,
        stdin,
        accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? null,
        outputFile: process.env.WRANGLER_OUTPUT_FILE_PATH ?? null,
      })}\n`,
    );
  }
}

function writeOutput(entry) {
  const file = process.env.WRANGLER_OUTPUT_FILE_PATH;
  if (file) fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

function handle(stdin) {
  record(stdin);
  const [command, subcommand] = args;
  const name = args[args.indexOf("--name") + 1];

  if (command === "--version") {
    process.stdout.write("4.111.0\n");
    return 0;
  }
  if (command === "whoami") {
    // Wrangler prints a telemetry notice before the JSON payload.
    process.stdout.write("Cloudflare collects anonymous telemetry about your usage of Wrangler.\n");
    if (process.env.FAKE_WRANGLER_LOGGED_OUT === "expired") {
      process.stderr.write("✘ [ERROR] Not logged in. Your auth token has expired and could not be refreshed.\n");
      return 1;
    }
    if (process.env.FAKE_WRANGLER_LOGGED_OUT === "never") {
      // How wrangler reports "no credentials at all" for `whoami --json`.
      process.stdout.write('{"loggedIn":false}\n');
      return 1;
    }
    process.stdout.write(
      `${JSON.stringify({
        loggedIn: true,
        authType: "OAuth Token",
        email: "user@example.com",
        accounts: [
          { id: "acc-1", name: "Work" },
          { id: "acc-2", name: "Personal" },
        ],
      })}\n`,
    );
    return 0;
  }
  if (command === "secret" && subcommand === "list") {
    if (name === "missing") {
      process.stderr.write(
        `✘ [ERROR] Worker "${name}" not found.\n\nIf this is a new Worker, run \`wrangler deploy\` first to create it.\n`,
      );
      return 1;
    }
    if (name === "authfail") {
      process.stderr.write("✘ [ERROR] Authentication error [code: 10000]\n");
      return 1;
    }
    if (name === "notjson") {
      process.stdout.write("this is not json\n");
      return 0;
    }
    if (name === "notarray") {
      process.stdout.write(`${JSON.stringify({ name: "API_TOKEN", type: "secret_text" })}\n`);
      return 0;
    }
    if (name === "badentry") {
      process.stdout.write(`${JSON.stringify([{ type: "secret_text" }])}\n`);
      return 0;
    }
    if (name === "emptysecrets") {
      process.stdout.write("[]\n");
      return 0;
    }
    process.stdout.write(`${JSON.stringify([{ name: "API_TOKEN", type: "secret_text" }])}\n`);
    return 0;
  }
  if (command === "secret" && subcommand === "bulk") {
    if (name === "boom") {
      // Wrangler would not do this, but if any tool ever echoes a secret back
      // the adapter must redact it before the user sees it.
      const values = JSON.parse(stdin);
      process.stderr.write(`✘ [ERROR] rejected value ${values.API_TOKEN}\n`);
      return 1;
    }
    process.stdout.write("✨ Successfully created secret\n");
    return 0;
  }
  if (command === "deploy") {
    const configPath = args[args.indexOf("-c") + 1] ?? "";
    writeOutput({ type: "wrangler-session", version: 1, wrangler_version: "4.111.0" });
    if (configPath.includes("no-subdomain")) {
      writeOutput({
        type: "command-failed",
        version: 1,
        message:
          "You can either deploy your worker to one or more routes by specifying them in your wrangler.jsonc file, or register a workers.dev subdomain here:\nhttps://dash.cloudflare.com/acc-1/workers/onboarding",
      });
      return 1;
    }
    if (args.includes("--dry-run")) return 0;
    if (configPath.includes("no-output")) return 0;
    if (configPath.includes("bad-targets")) {
      writeOutput({ type: "deploy", version: 1, worker_name: "w", version_id: "ver-1", targets: "w.example.workers.dev" });
      return 0;
    }
    writeOutput({
      type: "deploy",
      version: 1,
      worker_name: name ?? "icloud-mail-proxy",
      version_id: "ver-1",
      targets: configPath.includes("production") ? ["icloud-mail.diegobit.com (custom domain)"] : ["w.personal.workers.dev"],
    });
    return 0;
  }
  process.stderr.write(`fake wrangler: unhandled ${args.join(" ")}\n`);
  return 1;
}

// Only `secret bulk` reads stdin; `deploy` inherits the terminal so wrangler
// can prompt, and must not wait for stdin to close.
if (args[0] === "secret" && args[1] === "bulk") {
  let stdin = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => (stdin += chunk));
  process.stdin.on("end", () => {
    process.exitCode = handle(stdin);
  });
} else {
  process.exitCode = handle("");
}
