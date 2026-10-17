// Scripted stand-ins for the setup flow's adapters. Answers are matched by a
// substring of the question, so a test reads as a transcript.

export function fakePrompts(answers) {
  const asked = [];
  const printed = [];
  const pending = answers.map(([pattern, value]) => [pattern, Array.isArray(value) ? [...value] : value]);

  function take(kind, question, options = {}) {
    asked.push(`${kind}: ${question}`);
    for (const entry of pending) {
      if (!question.includes(entry[0])) continue;
      const value = Array.isArray(entry[1]) ? entry[1].shift() : entry[1];
      if (typeof value === "function") return value(options);
      return value;
    }
    throw new Error(`unscripted ${kind} prompt: ${question}`);
  }

  return {
    asked,
    printed,
    print(text) {
      printed.push(String(text));
    },
    async text(question, options = {}) {
      const value = take("text", question, options);
      return value === "" || value === undefined ? (options.defaultValue ?? "") : value;
    },
    async secret(question) {
      return take("secret", question);
    },
    async confirm(question, options = {}) {
      const value = take("confirm", question, options);
      return value === undefined ? (options.defaultValue ?? false) : value;
    },
    async select(question, choices) {
      const value = take("select", question, { choices });
      return typeof value === "number" ? choices[value].value : value;
    },
    output() {
      return this.printed.join("\n");
    },
  };
}

export function fakeWrangler({
  accounts = [{ id: "acc-1", name: "Personal" }],
  loggedIn = true,
  workers = {},
  deployTargets = ["worker.example.workers.dev"],
  onPutSecrets,
  onDeploy,
} = {}) {
  const calls = [];
  let currentLoggedIn = loggedIn;
  const state = { workers: { ...workers } };
  return {
    calls,
    state,
    async version() {
      return "4.111.0";
    },
    async whoami() {
      calls.push({ command: "whoami" });
      return currentLoggedIn ? { loggedIn: true, accounts, email: "user@example.com" } : { loggedIn: false, accounts: [] };
    },
    async login() {
      calls.push({ command: "login" });
      currentLoggedIn = true;
    },
    async inspectWorker({ name, accountId }) {
      calls.push({ command: "inspectWorker", name, accountId });
      const worker = state.workers[name];
      return worker ? { exists: true, secretNames: [...worker.secretNames] } : { exists: false, secretNames: [] };
    },
    async putSecrets({ name, accountId, values }) {
      calls.push({ command: "putSecrets", name, accountId, values: { ...values } });
      onPutSecrets?.({ name, values });
      state.workers[name] = {
        secretNames: [...new Set([...(state.workers[name]?.secretNames ?? []), ...Object.keys(values)])],
        secrets: { ...(state.workers[name]?.secrets ?? {}), ...values },
      };
      return { uploaded: Object.keys(values) };
    },
    async deploy({ configPath, accountId }) {
      calls.push({ command: "deploy", configPath, accountId });
      onDeploy?.({ configPath });
      return { targets: deployTargets.map((t) => (t.startsWith("http") ? t : `https://${t}`)), versionId: "v1" };
    },
  };
}

export function memoryStore(initial = null) {
  let current = initial;
  const history = [];
  return {
    read: () => (current ? structuredClone(current) : null),
    write(state) {
      current = structuredClone(state);
      history.push(structuredClone(state));
      return current;
    },
    history,
    path: "/tmp/state.json",
  };
}

/** Verification stub: returns a fixed outcome and records what it was asked. */
export function fakeVerify(outcome = { ok: true, checks: [{ name: "all", ok: true, detail: "fine" }] }) {
  const calls = [];
  const fn = async (args) => {
    calls.push(args);
    return typeof outcome === "function" ? outcome(args) : outcome;
  };
  fn.calls = calls;
  return fn;
}

/** Fake fetch driven by a list of [urlSubstringOrMatcher, response(s)] rules. */
export function fakeFetch(rules) {
  const requests = [];
  const queues = rules.map(([match, responses]) => [match, Array.isArray(responses) ? [...responses] : responses]);
  const fn = async (url, options = {}) => {
    requests.push({ url, options });
    for (const [match, responses] of queues) {
      const hit = typeof match === "function" ? match(url, options) : url.includes(match);
      if (!hit) continue;
      const spec = Array.isArray(responses) ? (responses.length > 1 ? responses.shift() : responses[0]) : responses;
      if (spec instanceof Error) throw spec;
      if (spec?.hang) return new Promise(() => {});
      return {
        status: spec.status,
        headers: new Headers(spec.headers ?? { "content-type": "application/json" }),
        text: async () => {
          if (spec.hangBody) return new Promise(() => {});
          if (spec.textError) throw new Error(spec.textError);
          return typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body ?? {});
        },
      };
    }
    throw new Error(`unexpected request: ${url}`);
  };
  fn.requests = requests;
  return fn;
}

/** A JSON-RPC reply as the Worker's MCP transport sends it: one SSE frame. */
export function sseFrame(message) {
  return {
    status: 200,
    headers: { "content-type": "text/event-stream" },
    body: `event: message\ndata: ${JSON.stringify(message)}\n\n`,
  };
}

export const baseConfig = {
  name: "icloud-mail-proxy",
  main: "src/index.ts",
  vars: { ALLOWED_MAILBOXES: "INBOX,Archive,Sent Messages" },
};
