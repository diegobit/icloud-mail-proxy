import { describe, expect, it } from "vitest";
import { runSetup } from "../../scripts/lib/setup.mjs";
import { AbortedError } from "../../scripts/lib/prompts.mjs";
import { WranglerError } from "../../scripts/lib/wrangler.mjs";
import { assertNoSecrets } from "../../scripts/lib/state.mjs";
import { baseConfig, fakeDiscover, fakePrompts, fakeVerify, fakeWrangler, memoryStore } from "./helpers.mjs";

const PASSWORD = "abcd-efgh-ijkl-mnop";
const TOKEN = "generated-token-0123456789";

function harness({
  prompts,
  wrangler,
  discover = fakeDiscover(),
  store = memoryStore(),
  verify = fakeVerify(),
  token = TOKEN,
  ...rest
}) {
  const configs = [];
  const secrets = [];
  return {
    configs,
    secrets,
    store,
    verify,
    discover,
    run: () =>
      runSetup({
        prompts,
        wrangler,
        state: store,
        verify,
        discover,
        writeConfig: (fragment) => {
          configs.push(fragment);
          return "/tmp/wrangler.local.jsonc";
        },
        baseConfig,
        generateToken: () => token,
        registerSecret: (secret) => secrets.push(secret),
        log: (text) => prompts.print(text),
        ...rest,
      }),
  };
}

describe("first deployment", () => {
  it("selects an account, creates the Worker, uploads secrets before deploying, and verifies", async () => {
    const prompts = fakePrompts([
      ["Which Cloudflare account", 1],
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", true],
      ["Press Enter", ""],
    ]);
    const wrangler = fakeWrangler({
      accounts: [
        { id: "acc-1", name: "Work" },
        { id: "acc-2", name: "Personal" },
      ],
      deployTargets: ["icloud-mail-proxy.personal.workers.dev"],
    });
    const h = harness({ prompts, wrangler });

    const result = await h.run();

    expect(result.code).toBe(0);
    expect(result.verified).toBe(true);
    expect(result.url).toBe("https://icloud-mail-proxy.personal.workers.dev");

    const commands = wrangler.calls.map((call) => call.command);
    expect(commands).toEqual(["whoami", "inspectWorker", "putSecrets", "deploy"]);

    const put = wrangler.calls.find((call) => call.command === "putSecrets");
    expect(put.accountId).toBe("acc-2");
    expect(Object.keys(put.values).sort()).toEqual(["API_TOKEN", "ICLOUD_APP_PASSWORD", "ICLOUD_USER"]);
    expect(put.values.API_TOKEN).toBe(TOKEN);

    expect(h.configs).toHaveLength(1);
    expect(h.configs[0]).toMatchObject({
      label: "local",
      name: "icloud-mail-proxy",
      account_id: "acc-2",
      workers_dev: true,
      vars: { ALLOWED_MAILBOXES: "INBOX,Archive,Sent Messages" },
    });

    const finalState = h.store.history.at(-1);
    expect(finalState.stage).toBe("verified");
    expect(finalState.progress.uploadedAt).toBeTruthy();
    expect(finalState.progress.verifiedAt).toBeTruthy();
  });

  it("shows a newly generated token exactly once and never echoes the Apple password", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", true],
      ["Press Enter", ""],
    ]);
    const h = harness({ prompts, wrangler: fakeWrangler() });

    await h.run();

    const output = prompts.output();
    expect(output.split(TOKEN)).toHaveLength(2);
    expect(output).not.toContain(PASSWORD);
    expect(h.secrets).toContain(PASSWORD);
    expect(h.secrets).toContain(TOKEN);
  });

  it("keeps the generated token out of persisted state", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", "INBOX, Archive ,, "],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const h = harness({ prompts, wrangler: fakeWrangler() });

    await h.run();

    for (const record of h.store.history) {
      expect(() => assertNoSecrets(record, [PASSWORD, TOKEN])).not.toThrow();
    }
    expect(h.store.history.at(-1).allowedMailboxes).toBe("INBOX,Archive");
    expect(prompts.output()).not.toContain(TOKEN);
  });
});

describe("existing Worker at the chosen name", () => {
  it("does not touch an unrecognized Worker unless the user adopts it", async () => {
    const prompts = fakePrompts([
      ["Worker name", ["", "my-mail-proxy"]],
      ["Adopt it?", false],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const wrangler = fakeWrangler({
      workers: { "icloud-mail-proxy": { secretNames: ["API_TOKEN", "ICLOUD_USER", "ICLOUD_APP_PASSWORD"] } },
    });
    const h = harness({ prompts, wrangler });

    const result = await h.run();

    expect(result.code).toBe(0);
    const inspected = wrangler.calls.filter((call) => call.command === "inspectWorker").map((call) => call.name);
    expect(inspected).toEqual(["icloud-mail-proxy", "my-mail-proxy"]);
    expect(wrangler.calls.find((call) => call.command === "putSecrets").name).toBe("my-mail-proxy");
    expect(h.store.history.at(-1).workerName).toBe("my-mail-proxy");
  });

  it("adopts an existing Worker when the user says so, and keeps its secrets", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["Adopt it?", true],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", false],
      ["Paste the current API token", "live-token"],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
    ]);
    const wrangler = fakeWrangler({
      workers: { "icloud-mail-proxy": { secretNames: ["API_TOKEN", "ICLOUD_USER", "ICLOUD_APP_PASSWORD"] } },
    });
    const h = harness({ prompts, wrangler });

    const result = await h.run();

    expect(result.code).toBe(0);
    expect(wrangler.calls.some((call) => call.command === "putSecrets")).toBe(false);
    expect(h.verify.calls[0].token).toBe("live-token");
  });
});

describe("reruns", () => {
  const priorState = {
    accountId: "acc-1",
    accountName: "Personal",
    workerName: "icloud-mail-proxy",
    allowedMailboxes: "INBOX",
    stage: "verified",
  };
  const configured = {
    workers: { "icloud-mail-proxy": { secretNames: ["API_TOKEN", "ICLOUD_USER", "ICLOUD_APP_PASSWORD"] } },
  };

  it("changes nothing when the user declines replacement and rotation", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", false],
      ["Paste the current API token", "live-token"],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
    ]);
    const h = harness({ prompts, wrangler: fakeWrangler(configured), store: memoryStore(priorState) });

    const result = await h.run();

    expect(result.code).toBe(0);
    expect(h.verify.calls[0].token).toBe("live-token");
    expect(h.verify.calls[0].mailbox).toBe("INBOX");
    expect(prompts.asked.some((question) => question.includes("Adopt it?"))).toBe(false);
    expect(h.configs[0].vars.ALLOWED_MAILBOXES).toBe("INBOX");
  });

  it("deploys but reports unverified when the existing token is not supplied", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", false],
      ["Paste the current API token", ""],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
    ]);
    const verify = fakeVerify({
      ok: false,
      skippedForToken: true,
      checks: [{ name: "authenticated /healthz", ok: false, skipped: true, detail: "no API token available in this run" }],
    });
    const h = harness({ prompts, wrangler: fakeWrangler(configured), store: memoryStore(priorState), verify });

    const result = await h.run();

    expect(result.code).toBe(1);
    expect(result.verified).toBe(false);
    expect(h.verify.calls[0].token).toBe(null);
    expect(prompts.output()).toContain("Deployed, but not verified");
    expect(h.store.history.at(-1).stage).toBe("deployed_unverified");
  });

  it("rotates the token only on request, uploading nothing else", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", true],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", true],
      ["Press Enter", ""],
    ]);
    const wrangler = fakeWrangler(configured);
    const h = harness({ prompts, wrangler, store: memoryStore(priorState), token: "rotated-token-9876543210" });

    const result = await h.run();

    expect(result.code).toBe(0);
    const put = wrangler.calls.find((call) => call.command === "putSecrets");
    expect(Object.keys(put.values)).toEqual(["API_TOKEN"]);
    expect(put.values.API_TOKEN).toBe("rotated-token-9876543210");
    expect(prompts.output()).toContain("rotated-token-9876543210");
    expect(h.verify.calls[0].token).toBe("rotated-token-9876543210");
  });

  it("reports a failed rotation as a failure and does not deploy", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", true],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
    ]);
    const wrangler = fakeWrangler(configured);
    wrangler.putSecrets = async () => {
      throw new WranglerError("upload rejected", { kind: "secret_upload" });
    };
    const h = harness({ prompts, wrangler, store: memoryStore(priorState) });

    await expect(h.run()).rejects.toThrow("upload rejected");
    expect(wrangler.calls.some((call) => call.command === "deploy")).toBe(false);
    expect(h.store.history.at(-1).stage).toBe("selected");
  });
});

describe("interrupted operations", () => {
  it("records the uploaded secrets when the deploy fails, and resumes without asking to adopt", async () => {
    const first = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const wrangler = fakeWrangler();
    wrangler.deploy = async () => {
      wrangler.calls.push({ command: "deploy" });
      throw new WranglerError("deploy exploded", { kind: "deploy" });
    };
    const store = memoryStore();
    const h = harness({ prompts: first, wrangler, store });

    await expect(h.run()).rejects.toThrow("deploy exploded");
    const afterFailure = store.history.at(-1);
    expect(afterFailure.stage).toBe("secrets_uploaded");
    expect(afterFailure.progress.uploadedAt).toBeTruthy();
    expect(afterFailure.progress.deployedAt).toBeUndefined();

    // Resume: the Worker now exists with its secrets, and the state recognizes it.
    const second = fakePrompts([
      ["Worker name", ""],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", false],
      ["Paste the current API token", "live-token"],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
    ]);
    const resumed = harness({ prompts: second, wrangler: fakeWrangler(wrangler.state), store });
    const result = await resumed.run();

    expect(result.code).toBe(0);
    expect(second.asked.some((question) => question.includes("Adopt it?"))).toBe(false);
    expect(store.history.at(-1).stage).toBe("verified");
  });

  it("changes nothing when the user cancels at the confirmation", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      [
        "Proceed?",
        () => {
          throw new AbortedError();
        },
      ],
    ]);
    const wrangler = fakeWrangler();
    const h = harness({ prompts, wrangler });

    await expect(h.run()).rejects.toBeInstanceOf(AbortedError);
    expect(wrangler.calls.map((call) => call.command)).toEqual(["whoami", "inspectWorker"]);
    expect(h.store.history).toHaveLength(0);
    expect(h.configs).toHaveLength(0);
  });

  it("declining the confirmation leaves Cloudflare untouched", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", false],
    ]);
    const wrangler = fakeWrangler();
    const h = harness({ prompts, wrangler });

    const result = await h.run();

    expect(result.code).toBe(130);
    expect(result.message).toContain("Nothing was changed");
    expect(wrangler.calls.some((call) => call.command === "putSecrets")).toBe(false);
  });
});

describe("preflight and login", () => {
  it("exits with actionable help when there is no terminal", async () => {
    const h = harness({ prompts: fakePrompts([]), wrangler: fakeWrangler(), interactive: false });

    const result = await h.run();

    expect(result.code).toBe(2);
    expect(result.message).toContain("interactive terminal flow");
    expect(result.message).toContain("npm run setup");
  });

  it("logs in first when Wrangler is not authenticated", async () => {
    const prompts = fakePrompts([
      ["Run `wrangler login` now?", true],
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const wrangler = fakeWrangler({ loggedIn: false });
    const h = harness({ prompts, wrangler });

    const result = await h.run();

    expect(result.code).toBe(0);
    expect(wrangler.calls.map((call) => call.command).slice(0, 3)).toEqual(["whoami", "login", "whoami"]);
  });

  it("stops without deploying when the user declines to log in", async () => {
    const prompts = fakePrompts([["Run `wrangler login` now?", false]]);
    const wrangler = fakeWrangler({ loggedIn: false });
    const h = harness({ prompts, wrangler });

    const result = await h.run();

    expect(result.code).toBe(130);
    expect(wrangler.calls.map((call) => call.command)).toEqual(["whoami"]);
  });
});

describe("verification outcomes", () => {
  it("fails with a targeted resume instruction when iCloud rejects the login", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const verify = fakeVerify({
      ok: false,
      checks: [
        { name: "unauthenticated request is rejected", ok: true, detail: "HTTP 401" },
        { name: "authenticated /healthz", ok: false, kind: "upstream", detail: "iCloud rejected the login" },
      ],
    });
    const h = harness({ prompts, wrangler: fakeWrangler(), verify });

    const result = await h.run();

    expect(result.code).toBe(1);
    expect(result.message).toContain("verification failed");
    expect(result.message).toContain("app-specific password");
    expect(result.message).toMatch(/does not distinguish/);
    expect(h.store.history.at(-1).stage).toBe("verification_failed");
  });

  it("does not tell the user to rotate the password after an IMAP timeout", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const verify = fakeVerify({
      ok: false,
      checks: [
        { name: "unauthenticated request is rejected", ok: true, detail: "HTTP 401" },
        { name: "authenticated /healthz", ok: false, kind: "upstream_timeout", detail: "iCloud timed out" },
      ],
    });
    const h = harness({ prompts, wrangler: fakeWrangler(), verify });

    const result = await h.run();

    expect(result.code).toBe(1);
    expect(result.message).toContain("timed out");
    expect(result.message).toMatch(/not a reason to rotate/);
    expect(result.message).not.toMatch(/create a fresh app-specific password/i);
  });

  it("fails when the first folder cannot be read", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const verify = fakeVerify({
      ok: false,
      checks: [
        { name: "authenticated /healthz", ok: true, detail: "HTTP 200" },
        { name: 'folder "Archive" is readable', ok: false, kind: "mailbox", detail: "no such folder" },
      ],
    });
    const h = harness({ prompts, wrangler: fakeWrangler(), verify });

    const result = await h.run();

    expect(result.code).toBe(1);
    expect(result.message).toContain("Folder names must match iCloud exactly");
    expect(h.store.history.at(-1).stage).toBe("verification_failed");
  });

  it("points at the deploy flags when OAuth discovery is broken", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
    ]);
    const verify = fakeVerify({
      ok: false,
      checks: [
        { name: "unauthenticated request is rejected", ok: true, detail: "HTTP 401" },
        { name: "OAuth protected-resource metadata", ok: false, kind: "oauth", detail: "HTTP 401 on the metadata URL" },
      ],
    });
    const h = harness({ prompts, wrangler: fakeWrangler(), verify });

    const result = await h.run();

    expect(result.code).toBe(1);
    expect(result.message).toContain("verification failed");
    expect(result.message).toContain("global_fetch_strictly_public");
    expect(result.message).toContain("OAUTH_KV");
    expect(result.message).toMatch(/deploys before it verifies/);
    expect(h.store.history.at(-1).stage).toBe("verification_failed");
  });
});

describe("calendar and reminder discovery", () => {
  const discovered = {
    calendars: [
      { name: "Lavoro", kind: "calendar", readOnly: false },
      { name: "Casa SP⚠️", kind: "calendar", readOnly: true },
    ],
    reminderLists: [{ name: "Reminders", kind: "reminders", readOnly: false }],
  };

  it("deploys, discovers, asks for both allowlists, and redeploys before verifying", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
      ["Calendars the proxy may use", ""],
      ["Reminder lists the proxy may use", ""],
    ]);
    const discover = fakeDiscover(discovered);
    const wrangler = fakeWrangler();
    const h = harness({ prompts, wrangler, discover });

    const result = await h.run();

    expect(result.code).toBe(0);
    expect(wrangler.calls.filter((call) => call.command === "deploy")).toHaveLength(2);
    expect(h.configs).toHaveLength(2);
    expect(h.configs[0].vars).toEqual({ ALLOWED_MAILBOXES: "INBOX,Archive,Sent Messages" });
    expect(h.configs[1].vars).toMatchObject({
      ALLOWED_MAILBOXES: "INBOX,Archive,Sent Messages",
      ALLOWED_CALENDARS: "*",
      ALLOWED_REMINDER_LISTS: "*",
    });

    const selected = h.store.history.find((record) => record.stage === "calendars_selected");
    expect(selected).toMatchObject({ allowedCalendars: "*", allowedReminderLists: "*" });
    expect(discover.calls).toHaveLength(1);

    expect(h.verify.calls[0]).toMatchObject({
      calendars: "*",
      reminderLists: "*",
      calendar: "Lavoro",
    });
    expect(prompts.output()).toContain("Lavoro (calendar)");
    expect(prompts.output()).toContain("Casa SP⚠️ (calendar, read-only)");
    expect(prompts.output()).toContain("Reminders (reminder list)");
  });

  it("persists named allowlists and gives the first allowed calendar to verification", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
      ["Calendars the proxy may use", "Casa SP⚠️,Lavoro"],
      ["Reminder lists the proxy may use", "Reminders"],
    ]);
    const h = harness({ prompts, wrangler: fakeWrangler(), discover: fakeDiscover(discovered) });

    await h.run();

    expect(h.configs.at(-1).vars.ALLOWED_CALENDARS).toBe("Casa SP⚠️,Lavoro");
    expect(h.configs.at(-1).vars.ALLOWED_REMINDER_LISTS).toBe("Reminders");
    expect(h.store.history.at(-1)).toMatchObject({
      allowedCalendars: "Casa SP⚠️,Lavoro",
      allowedReminderLists: "Reminders",
    });
    expect(h.verify.calls[0].calendar).toBe("Casa SP⚠️");
  });

  it("still redeploys when the existing configuration already allows everything", async () => {
    const priorState = {
      accountId: "acc-1",
      accountName: "Personal",
      workerName: "icloud-mail-proxy",
      allowedMailboxes: "INBOX",
      allowedCalendars: "*",
      allowedReminderLists: "*",
      stage: "verified",
    };
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", false],
      ["Paste the current API token", "live-token"],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Calendars the proxy may use", ""],
      ["Reminder lists the proxy may use", ""],
    ]);
    const wrangler = fakeWrangler({
      workers: { "icloud-mail-proxy": { secretNames: ["API_TOKEN", "ICLOUD_USER", "ICLOUD_APP_PASSWORD"] } },
    });
    const h = harness({
      prompts,
      wrangler,
      store: memoryStore(priorState),
      discover: fakeDiscover(discovered),
    });

    await h.run();

    expect(wrangler.calls.filter((call) => call.command === "deploy")).toHaveLength(2);
    expect(h.configs.at(-1).vars).toMatchObject({ ALLOWED_CALENDARS: "*", ALLOWED_REMINDER_LISTS: "*" });
    expect(h.store.history.at(-1)).toMatchObject({ allowedCalendars: "*", allowedReminderLists: "*" });
  });

  it("skips discovery when no API token is available and deploys once", async () => {
    const priorState = {
      accountId: "acc-1",
      accountName: "Personal",
      workerName: "icloud-mail-proxy",
      allowedMailboxes: "INBOX",
      stage: "verified",
    };
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", false],
      ["Paste the current API token", ""],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
    ]);
    const wrangler = fakeWrangler({
      workers: { "icloud-mail-proxy": { secretNames: ["API_TOKEN", "ICLOUD_USER", "ICLOUD_APP_PASSWORD"] } },
    });
    const discover = fakeDiscover(discovered);
    const verify = fakeVerify({
      ok: false,
      skippedForToken: true,
      checks: [{ name: "authenticated /healthz", ok: false, skipped: true, detail: "no token" }],
    });
    const h = harness({ prompts, wrangler, store: memoryStore(priorState), discover, verify });

    const result = await h.run();

    expect(result.code).toBe(1);
    expect(wrangler.calls.filter((call) => call.command === "deploy")).toHaveLength(1);
    expect(discover.calls).toHaveLength(0);
    expect(prompts.asked.some((question) => question.includes("Calendars the proxy may use"))).toBe(false);
    expect(h.store.history.at(-1).stage).toBe("deployed_unverified");
    expect(h.store.history.at(-1)).not.toHaveProperty("allowedCalendars");
  });

  it("keeps the configured allowlists when discovery fails, and still verifies mail", async () => {
    const priorState = {
      accountId: "acc-1",
      accountName: "Personal",
      workerName: "icloud-mail-proxy",
      allowedMailboxes: "INBOX",
      allowedCalendars: "Lavoro",
      allowedReminderLists: "Reminders",
      stage: "verified",
    };
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["Replace the stored iCloud", false],
      ["Rotate the API bearer token?", false],
      ["Paste the current API token", "live-token"],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
    ]);
    const discover = fakeDiscover(() => {
      throw new Error("HTTP 502: CalDAV unavailable");
    });
    const wrangler = fakeWrangler({
      workers: { "icloud-mail-proxy": { secretNames: ["API_TOKEN", "ICLOUD_USER", "ICLOUD_APP_PASSWORD"] } },
    });
    const h = harness({ prompts, wrangler, store: memoryStore(priorState), discover });

    const result = await h.run();

    expect(result.code).toBe(0);
    expect(wrangler.calls.filter((call) => call.command === "deploy")).toHaveLength(1);
    expect(prompts.output()).toContain("Could not discover calendars and reminder lists");
    expect(h.verify.calls[0]).toMatchObject({
      calendars: "Lavoro",
      reminderLists: "Reminders",
    });
    expect(h.store.history.at(-1)).toMatchObject({
      allowedCalendars: "Lavoro",
      allowedReminderLists: "Reminders",
      stage: "verified",
    });
  });

  it("records an explicit empty answer so the domains stay disabled", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
      ["Calendars the proxy may use", "none"],
      ["Reminder lists the proxy may use", "none"],
    ]);
    const h = harness({ prompts, wrangler: fakeWrangler(), discover: fakeDiscover(discovered) });

    await h.run();

    expect(h.configs.at(-1).vars).toMatchObject({ ALLOWED_CALENDARS: "", ALLOWED_REMINDER_LISTS: "" });
    expect(h.store.history.at(-1)).toMatchObject({ allowedCalendars: "", allowedReminderLists: "" });
    expect(h.verify.calls[0]).toMatchObject({ calendars: "", reminderLists: "", calendar: undefined });
  });

  it("refuses a mixed * and name list instead of treating it as a superset", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
      ["Calendars the proxy may use", ["*,Lavoro", "*"]],
      ["Reminder lists the proxy may use", "none"],
    ]);
    const h = harness({ prompts, wrangler: fakeWrangler(), discover: fakeDiscover(discovered) });

    await h.run();

    expect(prompts.output()).toContain("Use * on its own");
    expect(h.configs.at(-1).vars.ALLOWED_CALENDARS).toBe("*");
  });

  it("persists the choices even when the second deploy fails, so a rerun starts from them", async () => {
    const prompts = fakePrompts([
      ["Worker name", ""],
      ["iCloud email address", "me@icloud.com"],
      ["app-specific password", PASSWORD],
      ["Folders the proxy may read", ""],
      ["Proceed?", true],
      ["Show it once now", false],
      ["Calendars the proxy may use", ""],
      ["Reminder lists the proxy may use", ""],
    ]);
    const wrangler = fakeWrangler();
    let deploys = 0;
    wrangler.deploy = async ({ configPath, accountId }) => {
      wrangler.calls.push({ command: "deploy", configPath, accountId });
      deploys += 1;
      if (deploys === 2) throw new WranglerError("second deploy failed", { kind: "deploy" });
      return { targets: ["https://icloud-mail-proxy.personal.workers.dev"], versionId: "v1" };
    };
    const h = harness({ prompts, wrangler, discover: fakeDiscover(discovered) });

    await expect(h.run()).rejects.toThrow("second deploy failed");

    const afterFailure = h.store.history.at(-1);
    expect(afterFailure.stage).toBe("calendars_selected");
    expect(afterFailure).toMatchObject({ allowedCalendars: "*", allowedReminderLists: "*" });
    expect(h.configs).toHaveLength(2);
  });
});
