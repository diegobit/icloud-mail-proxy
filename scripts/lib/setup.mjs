// Guided-setup orchestration. Everything that touches the outside world —
// prompts, Wrangler, HTTP, the state file, the generated config — arrives as a
// dependency, so every branch here (including the failure and resume paths) is
// exercised in test/setup/*.test.mjs without Cloudflare or iCloud.

import { WranglerError } from "./wrangler.mjs";

export const WORKER_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,53}$/;

const APPLE_PASSWORD_HELP = [
  "The Worker signs in to iCloud with an app-specific password, not your Apple",
  "account password — a regular Apple password will not work here (Apple requires",
  "an app-specific one for IMAP, and it would also hand over far more access).",
  "Create one at https://appleid.apple.com → Sign-In and Security →",
  "App-Specific Passwords, and don't reuse it anywhere else.",
].join("\n");

export const NONINTERACTIVE_HELP = [
  "`npm run setup` is an interactive terminal flow: it asks for your iCloud",
  "address, an app-specific password, the folders to expose, and (after the",
  "first deploy) which calendars and reminder lists to allow, so it needs a",
  "terminal it can prompt on.",
  "",
  "Run it directly in a terminal:  npm run setup",
  "",
  "To deploy without prompts, follow the manual path in README.md (wrangler",
  "login, `npx wrangler secret bulk`, then `npm run deploy -- --profile <name>`).",
].join("\n");

const RESUME_HINT =
  "Nothing is lost if you stop: press Ctrl-C at any point and run `npm run setup` again — " +
  "it picks up the same account and Worker, keeps the secrets already uploaded, and only " +
  "changes credentials, the API token, folders, or calendar/reminder access if you ask it to. " +
  "A run that discovers calendars deploys once to learn the names, then redeploys with your choice before verifying.";

function pickUrl(targets) {
  if (!targets || targets.length === 0) {
    throw new WranglerError("the deploy succeeded but Wrangler reported no URL for it", {
      kind: "deploy",
      hint: "Run `npx wrangler deployments list` to inspect the Worker, then re-run `npm run setup`.",
    });
  }
  return targets.find((target) => /\.workers\.dev(\/|$)/.test(target)) ?? targets[0];
}

function connectionInstructions(url, { tokenEnvVar = "ICLOUD_MAIL_TOKEN" } = {}) {
  return [
    "",
    `Endpoint: ${url}`,
    "",
    `Keep the bearer token in an environment variable (${tokenEnvVar}) rather than in a config file:`,
    "",
    `  export ${tokenEnvVar}='…'   # the API token for this Worker`,
    `  curl -H "Authorization: Bearer $${tokenEnvVar}" ${url}/v1/mailboxes`,
    "",
    "Claude Code (single-quote the header so the shell does not expand the token;",
    "some CLIs store the expanded header value, not an environment-variable reference):",
    `  claude mcp add --transport http icloud-mail ${url}/mcp \\`,
    `    --header 'Authorization: Bearer $${tokenEnvVar}'`,
    "",
    "opencode (~/.config/opencode/opencode.json):",
    '  { "mcp": { "icloud-mail": { "type": "remote", "url": ' +
      `"${url}/mcp", "enabled": true, "oauth": false,`,
    '      "headers": { "Authorization": "Bearer {env:' + tokenEnvVar + '}" } } } }',
    "",
    "Codex CLI (~/.codex/config.toml):",
    "  [mcp_servers.icloud_mail]",
    `  url = "${url}/mcp"`,
    `  bearer_token_env_var = "${tokenEnvVar}"`,
    "",
    "ChatGPT (developer mode) and claude.ai connect over OAuth instead:",
    `  ChatGPT: Settings → Connectors, add a custom connector with URL ${url}/mcp`,
    `  claude.ai: Settings → Connectors, add a custom connector with URL ${url}/mcp`,
    "Both ask for the API token once on the Worker's sign-in page, then hold their own OAuth grant.",
  ].join("\n");
}

function describeChecks(checks) {
  return checks
    .map((check) => {
      const mark = check.ok ? "ok  " : check.skipped ? "skip" : check.advisory ? "warn" : "FAIL";
      return `  [${mark}] ${check.name}: ${check.detail}`;
    })
    .join("\n");
}

/** Resume instruction tailored to how verification failed. */
function verificationHint(checks) {
  const failed = checks.find((check) => !check.ok && !check.skipped && !check.advisory);
  switch (failed?.kind) {
    case "propagation":
      return "The deployment exists but was not reachable yet. Wait a minute and run `npm run setup` again — it keeps the same Worker and secrets, deploys again, then re-checks.";
    case "authorization":
      return "The API token used for verification is not the one stored in the Worker. Run `npm run setup` again and either paste the current token or choose to rotate it. Setup always deploys before it verifies.";
    case "configuration":
      return "The Worker has no API_TOKEN secret (HTTP 500, closed). Run `npm run setup` again and let it generate one.";
    case "upstream_timeout":
      return "The Worker is up but iCloud timed out. Wait a minute and run `npm run setup` again (it will deploy again, then re-check). A timeout is not a reason to rotate the app-specific password.";
    case "upstream":
      return "Cloudflare is fine; iCloud rejected or failed the IMAP login. The mail server does not distinguish a wrong or revoked app-specific password from other failures. If you recently changed the password and are sure it is correct, wait and retry; otherwise create a fresh app-specific password at appleid.apple.com, then run `npm run setup` again and choose to replace the credentials.";
    case "mailbox":
      return "The first configured folder could not be read. Folder names must match iCloud exactly; re-run `npm run setup` to correct them. Setup always deploys again, then verifies.";
    case "calendar":
      return "The mail side works, but iCloud CalDAV failed or a configured calendar/reminder list could not be read. Check the allowlists against `?all=1`, or wait and retry if iCloud is slow. Re-run `npm run setup` after correcting the configuration; mail is unaffected.";
    case "protocol":
      return "REST worked but the MCP tool list did not match the configured domains. Redeploy this checkout (`npm run setup`) and check `npx wrangler tail` while a client connects; the write tools must be absent while their flags are `0`.";
    case "oauth":
      return "OAuth discovery is broken on the deployed Worker; bearer clients keep working. Check that the deploy came from this checkout (the global_fetch_strictly_public flag and the OAUTH_KV binding appear in the deploy output), then run `npm run setup` again — it deploys before it verifies.";
    default:
      return "Run `npm run setup` again to deploy and re-check; the Worker and its secrets are left as they are.";
  }
}

async function askWorkerTarget({ prompts, wrangler, log, account, prior, defaultName }) {
  let candidate = prior.workerName ?? defaultName;
  for (;;) {
    const name = await prompts.text("Worker name", { defaultValue: candidate });
    if (!WORKER_NAME_PATTERN.test(name)) {
      log("Worker names use lowercase letters, digits and hyphens, and start with a letter or digit.");
      candidate = defaultName;
      continue;
    }
    const info = await wrangler.inspectWorker({ name, accountId: account.id });
    if (!info.exists) return { name, operation: "create", secretNames: [] };
    if (prior.workerName === name && prior.accountId === account.id) {
      return { name, operation: "update", secretNames: info.secretNames };
    }
    log(
      `A Worker named "${name}" already exists in ${account.name}, and this checkout has no ` +
        "setup state for it (a different machine, or a Worker you created another way).",
    );
    if (await prompts.confirm("Adopt it? Its code will be replaced by this repository's Worker", { defaultValue: false })) {
      return { name, operation: "adopt", secretNames: info.secretNames };
    }
    log("Choose a different Worker name, or press Ctrl-C to stop.");
    candidate = `${defaultName}-2`;
  }
}

async function askMailboxes({ prompts, log, defaultValue }) {
  for (;;) {
    const answer = await prompts.text(
      "Folders the proxy may read (comma-separated, exactly as iCloud spells them)",
      { defaultValue },
    );
    const list = answer
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (list.length === 0) {
      log("At least one folder is required.");
      continue;
    }
    return list.join(",");
  }
}

function accessLabel(value, fallback = "not configured") {
  if (value === undefined || value === null) return fallback;
  return value === "" ? "disabled" : value;
}

function printCollections(log, heading, entries) {
  log(heading);
  if (entries.length === 0) {
    log("  (none)");
    return;
  }
  for (const entry of entries) {
    const kind = entry.kind === "reminders" ? "reminder list" : "calendar";
    log(`  - ${entry.name} (${kind}${entry.readOnly ? ", read-only" : ""})`);
  }
}

/**
 * Read an allowlist answer. `*` means every discovered collection; `none`
 * disables the domain. A mixed `*,name` is refused here because the Worker
 * treats it as a configuration error rather than a superset.
 */
async function askAccess({ prompts, log, label, names, defaultValue }) {
  const known = new Set(names);
  for (;;) {
    const answer = await prompts.text(
      `${label} the proxy may use (comma-separated names, * for all, none to disable)`,
      { defaultValue: defaultValue === "" ? "none" : defaultValue },
    );
    const entries = answer
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length === 1 && /^(none|-)$/i.test(entries[0])) return "";
    if (entries.includes("*")) {
      if (entries.length > 1) {
        log("Use * on its own, or list names explicitly.");
        continue;
      }
      return "*";
    }
    const unknown = entries.filter((name) => !known.has(name));
    if (unknown.length > 0) {
      log(`Not in the discovery result: ${unknown.join(", ")}. These will fail closed until they exist.`);
    }
    return entries.join(",");
  }
}

function preferredCalendar(allowlist, calendars) {
  if (!allowlist) return undefined;
  if (allowlist === "*") return calendars[0]?.name;
  return allowlist.split(",")[0]?.trim() || undefined;
}

async function askCredentials({ prompts, log }) {
  log("");
  log(APPLE_PASSWORD_HELP);
  let email = "";
  while (!/^[^@\s]+@[^@\s]+$/.test(email)) {
    email = (await prompts.text("Your full iCloud email address")).trim();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) log("That doesn't look like an email address.");
  }
  let password = "";
  while (password.length === 0) {
    password = await prompts.secret("Apple app-specific password (not shown as you type)");
    if (password.length === 0) log("The app-specific password cannot be empty.");
  }
  return { ICLOUD_USER: email, ICLOUD_APP_PASSWORD: password };
}

async function offerTokenReveal({ prompts, log, token }) {
  log("");
  log(
    "A new API bearer token was generated and stored as a Worker secret. Nothing on this " +
      "machine keeps a copy of it, and Cloudflare's API cannot return a secret's value.",
  );
  if (await prompts.confirm("Show it once now, so you can save it in your password manager?", { defaultValue: true })) {
    log("");
    log(`  API token: ${token}`);
    log("");
    await prompts.text("Press Enter once you have stored it", { defaultValue: " " });
  } else {
    log("Not shown. If you lose it, run `npm run setup` again and choose to rotate the token.");
  }
}

/**
 * Run the guided setup. Returns `{ code, url?, checks? }` and never calls
 * process.exit, so tests can assert on the outcome.
 */
export async function runSetup({
  prompts,
  wrangler,
  state: store,
  verify,
  discover,
  writeConfig,
  baseConfig,
  generateToken,
  registerSecret = () => {},
  interactive = true,
  log = (text) => prompts.print(text),
  now = () => new Date().toISOString(),
}) {
  if (!interactive) return { code: 2, message: NONINTERACTIVE_HELP };

  log(`Setting up your own deployment of icloud-mail-proxy (wrangler ${await wrangler.version()}).`);
  log(RESUME_HINT);
  log("");

  // Cloudflare authentication.
  let who = await wrangler.whoami();
  if (!who.loggedIn) {
    log("You are not logged in to Cloudflare.");
    if (!(await prompts.confirm("Run `wrangler login` now? It opens a browser", { defaultValue: true }))) {
      return { code: 130, message: "Nothing was changed. Run `npm run setup` again when you are ready to log in." };
    }
    await wrangler.login();
    who = await wrangler.whoami();
    if (!who.loggedIn) {
      return { code: 1, message: "Cloudflare login did not complete. Run `npx wrangler login`, then `npm run setup` again." };
    }
  }
  if (who.accounts.length === 0) {
    return { code: 1, message: "This Cloudflare login has no accounts. Check `npx wrangler whoami`." };
  }

  // Account selection, remembered across runs.
  const prior = store.read() ?? {};
  const baseVars = baseConfig.vars ?? {};
  const baseCalendars = typeof baseVars.ALLOWED_CALENDARS === "string" ? baseVars.ALLOWED_CALENDARS : "";
  const baseReminderLists = typeof baseVars.ALLOWED_REMINDER_LISTS === "string" ? baseVars.ALLOWED_REMINDER_LISTS : "";
  const priorCalendars = typeof prior.allowedCalendars === "string" ? prior.allowedCalendars : undefined;
  const priorReminderLists =
    typeof prior.allowedReminderLists === "string" ? prior.allowedReminderLists : undefined;
  let allowedCalendars = priorCalendars;
  let allowedReminderLists = priorReminderLists;
  let preferredCalendarName;
  let account = who.accounts.find((candidate) => candidate.id === prior.accountId) ?? null;
  if (account && who.accounts.length > 1) {
    const keep = await prompts.confirm(`Keep deploying to the account "${account.name}"?`, { defaultValue: true });
    if (!keep) account = null;
  }
  if (!account) {
    account =
      who.accounts.length === 1
        ? who.accounts[0]
        : await prompts.select(
            "Which Cloudflare account should host the Worker?",
            who.accounts.map((candidate) => ({ label: `${candidate.name} (${candidate.id})`, value: candidate })),
          );
  }
  log(`Cloudflare account: ${account.name} (${account.id})`);

  // Worker target.
  const target = await askWorkerTarget({
    prompts,
    wrangler,
    log,
    account,
    prior,
    defaultName: baseConfig.name,
  });
  const existing = new Set(target.secretNames);

  // Credentials and token, as explicit operations.
  const secretsToUpload = {};
  let generatedToken = null;
  let verificationToken = null;

  const credentialsPresent = existing.has("ICLOUD_USER") && existing.has("ICLOUD_APP_PASSWORD");
  const replaceCredentials = credentialsPresent
    ? await prompts.confirm("Replace the stored iCloud address and app-specific password?", { defaultValue: false })
    : true;
  if (replaceCredentials) {
    const credentials = await askCredentials({ prompts, log });
    Object.assign(secretsToUpload, credentials);
    registerSecret(credentials.ICLOUD_APP_PASSWORD);
  } else {
    log("Keeping the iCloud credentials already stored in the Worker.");
  }

  if (!existing.has("API_TOKEN")) {
    generatedToken = generateToken();
    secretsToUpload.API_TOKEN = generatedToken;
    verificationToken = generatedToken;
    registerSecret(generatedToken);
  } else {
    const rotate = await prompts.confirm(
      "Rotate the API bearer token? Every client (MCP config, scripts) must then be updated",
      { defaultValue: false },
    );
    if (rotate) {
      generatedToken = generateToken();
      secretsToUpload.API_TOKEN = generatedToken;
      verificationToken = generatedToken;
      registerSecret(generatedToken);
    } else {
      log("Keeping the existing API token. Cloudflare's API cannot return a secret's value, so verification needs it from you.");
      const pasted = await prompts.secret(
        "Paste the current API token to verify the deployment (leave empty to skip the token checks)",
      );
      verificationToken = pasted.length > 0 ? pasted : null;
      if (verificationToken) registerSecret(verificationToken);
    }
  }

  const allowedMailboxes = await askMailboxes({
    prompts,
    log,
    defaultValue: prior.allowedMailboxes ?? baseVars.ALLOWED_MAILBOXES,
  });

  const setupConfigVars = () => {
    const vars = { ALLOWED_MAILBOXES: allowedMailboxes };
    // An absent value inherits the base config. A persisted empty string means
    // the owner explicitly disabled the domain and must override a non-empty
    // base.
    if (allowedCalendars !== undefined) vars.ALLOWED_CALENDARS = allowedCalendars;
    if (allowedReminderLists !== undefined) vars.ALLOWED_REMINDER_LISTS = allowedReminderLists;
    return vars;
  };

  // Confirm before anything is created or changed.
  const operationLabel = target.operation === "create" ? "create a new Worker" : "update the existing Worker";
  log("");
  log("About to:");
  log(`  ${operationLabel} "${target.name}" in ${account.name} (${account.id})`);
  log(`  folders: ${allowedMailboxes}`);
  log(`  calendars: ${accessLabel(allowedCalendars ?? (baseCalendars.trim() ? baseCalendars : undefined))}`);
  log(
    `  reminder lists: ${accessLabel(
      allowedReminderLists ?? (baseReminderLists.trim() ? baseReminderLists : undefined),
    )}`,
  );
  log(
    `  secrets: ${
      Object.keys(secretsToUpload).length === 0
        ? "unchanged"
        : Object.keys(secretsToUpload)
            .map((key) => (key === "API_TOKEN" ? (existing.has("API_TOKEN") ? "API_TOKEN (rotated)" : "API_TOKEN (new)") : key))
            .join(", ")
    }`,
  );
  log("  URL: https://<worker>.<your-subdomain>.workers.dev (no custom domain)");
  log("  OAuth: the first deploy creates the OAUTH_KV namespace for connector sign-ins (nothing to configure)");
  log(
    verificationToken
      ? "  calendars and reminder lists are discovered after the first deploy, then the Worker is redeployed with your choice"
      : "  calendar and reminder discovery is skipped: no API token is available in this run",
  );
  if (!(await prompts.confirm("Proceed?", { defaultValue: true }))) {
    return { code: 130, message: "Nothing was changed. Run `npm run setup` again when you are ready." };
  }

  let configPath = writeConfig({
    label: "local",
    description: `guided setup for ${target.name}`,
    name: target.name,
    account_id: account.id,
    workers_dev: true,
    vars: setupConfigVars(),
  });

  const progress = { ...(prior.progress ?? {}) };
  let url = prior.url ?? null;
  const persist = (stage) =>
    store.write({
      accountId: account.id,
      accountName: account.name,
      workerName: target.name,
      allowedMailboxes,
      ...(allowedCalendars !== undefined ? { allowedCalendars } : {}),
      ...(allowedReminderLists !== undefined ? { allowedReminderLists } : {}),
      url,
      configPath,
      stage,
      progress,
    });

  // Record the intended target before the first mutation, so an interrupted
  // run is recognized as ours on the next attempt instead of asking to adopt.
  persist("selected");

  if (Object.keys(secretsToUpload).length > 0) {
    log("");
    log("Uploading secrets (sent to Wrangler on stdin, never as arguments)…");
    await wrangler.putSecrets({ name: target.name, accountId: account.id, values: secretsToUpload });
    progress.uploadedAt = now();
    persist("secrets_uploaded");
    log(`Uploaded: ${Object.keys(secretsToUpload).join(", ")}`);
    if (generatedToken) await offerTokenReveal({ prompts, log, token: generatedToken });
  }

  log("");
  log("Deploying the Worker…");
  const deployed = await wrangler.deploy({ configPath, accountId: account.id });
  url = pickUrl(deployed.targets);
  progress.bootstrapDeployedAt = now();
  progress.deployedAt = progress.bootstrapDeployedAt;
  persist("deployed");
  log(`Deployed: ${url}`);

  if (verificationToken) {
    log("");
    log("Discovering calendars and reminder lists through the deployed Worker…");
    let discovered = null;
    try {
      discovered = await discover({ url, token: verificationToken });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Could not discover calendars and reminder lists: ${message}`);
      log("Leaving calendar and reminder access as configured; mail setup continues.");
    }
    if (discovered) {
      progress.calendarsDiscoveredAt = now();
      persist("deployed");
      printCollections(log, "Calendars reported by iCloud:", discovered.calendars);
      printCollections(log, "Reminder lists reported by iCloud:", discovered.reminderLists);

      let asked = false;
      if (discovered.calendars.length > 0) {
        const fallback = allowedCalendars ?? (baseCalendars.trim() ? baseCalendars : "*");
        allowedCalendars = await askAccess({
          prompts,
          log,
          label: "Calendars",
          names: discovered.calendars.map((entry) => entry.name),
          defaultValue: fallback,
        });
        preferredCalendarName = preferredCalendar(allowedCalendars, discovered.calendars);
        asked = true;
      }
      if (discovered.reminderLists.length > 0) {
        const fallback = allowedReminderLists ?? (baseReminderLists.trim() ? baseReminderLists : "*");
        allowedReminderLists = await askAccess({
          prompts,
          log,
          label: "Reminder lists",
          names: discovered.reminderLists.map((entry) => entry.name),
          defaultValue: fallback,
        });
        asked = true;
      }

      if (asked) {
        configPath = writeConfig({
          label: "local",
          description: `guided setup for ${target.name}`,
          name: target.name,
          account_id: account.id,
          workers_dev: true,
          vars: setupConfigVars(),
        });
        progress.calendarsSelectedAt = now();
        persist("calendars_selected");
        log("");
        log("Redeploying with the calendar and reminder choices…");
        const redeployed = await wrangler.deploy({ configPath, accountId: account.id });
        url = pickUrl(redeployed.targets);
        progress.deployedAt = now();
        persist("deployed");
        log(`Deployed: ${url}`);
      }
    }
  } else {
    log("");
    log("No API token is available in this run, so calendar and reminder discovery is skipped.");
  }

  log("");
  log("Verifying the live endpoint…");
  const result = await verify({
    url,
    token: verificationToken,
    mailbox: allowedMailboxes.split(",")[0],
    calendars: allowedCalendars ?? baseCalendars,
    reminderLists: allowedReminderLists ?? baseReminderLists,
    calendarWrite: baseVars.CALENDAR_WRITE === "1",
    reminderWrite: baseVars.REMINDERS_WRITE === "1",
    calendar: preferredCalendarName,
  });
  log(describeChecks(result.checks));

  if (result.skippedForToken) {
    progress.verifiedAt = null;
    persist("deployed_unverified");
    log("");
    log(
      "Deployed, but not verified: no API token was available in this run. Verify with " +
        `curl -H "Authorization: Bearer <token>" ${url}/healthz, or run \`npm run setup\` again and paste the token. ` +
        "Each setup run deploys the Worker again, then verifies.",
    );
    log(connectionInstructions(url));
    return { code: 1, url, checks: result.checks, verified: false };
  }

  if (!result.ok) {
    persist("verification_failed");
    return {
      code: 1,
      url,
      checks: result.checks,
      message: `Deployed, but verification failed.\n${verificationHint(result.checks)}`,
    };
  }

  progress.verifiedAt = now();
  persist("verified");
  log("");
  log("Setup complete and verified.");
  log(connectionInstructions(url));
  return { code: 0, url, checks: result.checks, verified: true };
}
