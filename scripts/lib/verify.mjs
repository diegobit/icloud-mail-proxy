// Post-deploy verification against the live endpoint, with bounded retries for
// DNS/route propagation. Distinguishes three failure worlds: the endpoint is
// not reachable yet, the bearer token is wrong, or the Worker reached iCloud
// and the mail server failed.

/** Error codes this Worker returns itself: a real answer, not a retry signal. */
const WORKER_ERROR_CODES = new Set([
  "not_configured",
  "unauthorized",
  "not_found",
  "invalid_request",
  "invalid_json",
  "mailbox_not_allowed",
  "message_too_large",
  "upstream_imap_error",
  "upstream_timeout",
  "internal_error",
]);

/** `/healthz` IMAP failures: HTTP 503 `{ ok:false, error:{ code, message } }`. */
const HEALTHZ_UPSTREAM_CODES = new Set(["NO", "BAD", "BYE", "TIMEOUT", "PARSE", "LIMIT"]);

const MCP_PROTOCOL_VERSION = "2025-06-18";
const ATTEMPT_TIMEOUT_MESSAGE = "timed out waiting for the endpoint";

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reject if `promise` has not settled within `ms`. */
export function withDeadline(promise, ms, message = ATTEMPT_TIMEOUT_MESSAGE) {
  const budget = Number(ms);
  if (!Number.isFinite(budget) || budget <= 0) {
    return Promise.reject(new Error(message));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), budget);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isTimeoutError(error) {
  if (!error) return false;
  const name = error.name ?? "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    name === "AbortError" ||
    name === "TimeoutError" ||
    message === ATTEMPT_TIMEOUT_MESSAGE ||
    /timed out/i.test(message)
  );
}

/** One HTTP attempt, reduced to what the checks reason about. */
async function attempt(fetchImpl, url, options, deadlineMs) {
  const controller = new AbortController();
  const started = Date.now();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const response = await withDeadline(
      fetchImpl(url, { ...options, signal: controller.signal }),
      deadlineMs,
      ATTEMPT_TIMEOUT_MESSAGE,
    );
    const remaining = Math.max(1, deadlineMs - (Date.now() - started));
    const text = await withDeadline(Promise.resolve(response.text()), remaining, ATTEMPT_TIMEOUT_MESSAGE);
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      status: response.status,
      headers: response.headers,
      text,
      body,
      contentType: response.headers?.get?.("content-type") ?? "",
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { networkError: isTimeoutError(e) ? ATTEMPT_TIMEOUT_MESSAGE : message };
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(result) {
  return result.body?.error?.code;
}

function isTerminalWorkerError(result) {
  const code = errorCode(result);
  return WORKER_ERROR_CODES.has(code) || HEALTHZ_UPSTREAM_CODES.has(code);
}

/** True while the endpoint looks like it is still coming up. */
function isPropagating(result) {
  if (result.networkError) return true;
  if (result.status === 404 && !result.body?.error) return true;
  if (result.status >= 500 && !isTerminalWorkerError(result)) return true;
  return false;
}

async function withRetries(run, { attempts, sleep, delayMs, shouldRetry = isPropagating }) {
  let last;
  for (let i = 0; i < attempts; i++) {
    last = await run();
    if (!shouldRetry(last)) return last;
    if (i < attempts - 1) await sleep(Math.min(delayMs * 2 ** i, 8000));
  }
  return last;
}

function propagationDetail(result, url) {
  return result.networkError
    ? `${url} is not reachable yet (${result.networkError})`
    : `${url} answered HTTP ${result.status} while the deployment was still propagating`;
}

/** Read a JSON-RPC message out of a JSON or SSE response body. */
export function parseJsonRpc(contentType, text) {
  if (/text\/event-stream/i.test(contentType)) {
    const dataLines = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    for (const line of dataLines.reverse()) {
      try {
        return JSON.parse(line);
      } catch {
        /* keep looking */
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Run the acceptance checks against a deployed Worker.
 * `token` may be null: token-dependent checks are then reported as skipped.
 */
export async function verifyDeployment({
  url,
  token,
  mailbox,
  fetchImpl = fetch,
  sleep = defaultSleep,
  attempts = 6,
  delayMs = 1000,
  deadlineMs = 10_000,
}) {
  const base = url.replace(/\/+$/, "");
  const checks = [];
  const retry = (run) => withRetries(run, { attempts, sleep, delayMs });
  // The metadata URLs answer 200 on a healthy Worker; a 401 right after a
  // deploy can be the previous (pre-OAuth) version still serving, so retry it
  // before reporting the deployment as too old.
  const retryMetadata = (run) =>
    withRetries(run, { attempts, sleep, delayMs, shouldRetry: (result) => isPropagating(result) || result.status === 401 });
  const get = (path, options) => retry(() => attempt(fetchImpl, `${base}${path}`, options, deadlineMs));

  // 1. The endpoint exists and refuses unauthenticated callers.
  const anonymous = await get("/healthz", { method: "GET" });
  if (isPropagating(anonymous)) {
    checks.push({ name: "unauthenticated request is rejected", ok: false, kind: "propagation", detail: propagationDetail(anonymous, base) });
    return { ok: false, checks };
  }
  if (anonymous.status === 500 && errorCode(anonymous) === "not_configured") {
    checks.push({
      name: "unauthenticated request is rejected",
      ok: false,
      kind: "configuration",
      detail: "the Worker has no API_TOKEN secret yet (HTTP 500 not_configured)",
    });
    return { ok: false, checks };
  }
  if (anonymous.status !== 401) {
    checks.push({
      name: "unauthenticated request is rejected",
      ok: false,
      kind: "authorization",
      detail: `expected HTTP 401 without a token, got HTTP ${anonymous.status}`,
    });
    return { ok: false, checks };
  }
  checks.push({ name: "unauthenticated request is rejected", ok: true, detail: "HTTP 401 without a bearer token" });

  // 1b. OAuth discovery: needs no token, so these also run in token-skipped runs.
  checks.push(...(await checkOAuthDiscovery({ base, fetchImpl, retry, retryMetadata, deadlineMs })));

  // 2. The token works and the Worker can log in to iCloud.
  if (!token) {
    checks.push({ name: "authenticated /healthz", ok: false, skipped: true, kind: "no_token", detail: "no API token available in this run" });
    checks.push({ name: "MCP initialize and tools/list", ok: false, skipped: true, kind: "no_token", detail: "no API token available in this run" });
    return { ok: false, checks, skippedForToken: true };
  }
  const authHeaders = { Authorization: `Bearer ${token}` };
  const health = await get("/healthz", { method: "GET", headers: authHeaders });
  const healthCheck = describeHealth(health, base);
  checks.push(healthCheck);
  if (!healthCheck.ok) return { ok: false, checks };

  // 3. MCP over the same endpoint and token.
  checks.push(await checkMcp({ base, token, fetchImpl, retry, deadlineMs }));

  // 4. Optional: the configured folder really exists upstream.
  if (mailbox) checks.push(await checkMailbox({ base, authHeaders, mailbox, fetchImpl, retry, deadlineMs }));

  const ok = checks.every((check) => check.ok);
  return { ok, checks };
}

/**
 * OAuth discovery checks: the Worker serves the provider metadata and
 * challenges anonymous /mcp callers with it. A 401 on the metadata URLs,
 * still there after the bounded retries, means the deployed code predates
 * OAuth (see retryMetadata in verifyDeployment).
 */
async function checkOAuthDiscovery({ base, fetchImpl, retry, retryMetadata, deadlineMs }) {
  const origin = new URL(base).origin;
  const resource = await retryMetadata(() =>
    attempt(fetchImpl, `${origin}/.well-known/oauth-protected-resource/mcp`, { method: "GET" }, deadlineMs),
  );
  const authorization = await retryMetadata(() =>
    attempt(fetchImpl, `${origin}/.well-known/oauth-authorization-server`, { method: "GET" }, deadlineMs),
  );
  const challenge = await retry(() =>
    attempt(
      fetchImpl,
      `${origin}/mcp`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: "{}",
      },
      deadlineMs,
    ),
  );
  return [
    describeResourceMetadata(resource, origin),
    describeAuthorizationServer(authorization, origin),
    describeMcpChallenge(challenge, origin),
  ];
}

function describeResourceMetadata(result, origin) {
  const name = "OAuth protected-resource metadata";
  const url = `${origin}/.well-known/oauth-protected-resource/mcp`;
  if (isPropagating(result)) {
    return { name, ok: false, kind: "propagation", detail: propagationDetail(result, url) };
  }
  if (result.status === 401) {
    return {
      name,
      ok: false,
      kind: "oauth",
      detail: `HTTP 401 on ${url}: the deployed Worker predates OAuth. Deploy this checkout (\`npm run setup\`), then re-check.`,
    };
  }
  if (result.status !== 200) {
    return { name, ok: false, kind: "oauth", detail: `HTTP ${result.status} on ${url}: ${result.text?.slice(0, 200) ?? ""}` };
  }
  if (result.body?.resource !== `${origin}/mcp`) {
    return { name, ok: false, kind: "oauth", detail: `resource is "${result.body?.resource}", expected "${origin}/mcp"` };
  }
  const servers = Array.isArray(result.body.authorization_servers) ? result.body.authorization_servers : [];
  if (!servers.includes(origin)) {
    return {
      name,
      ok: false,
      kind: "oauth",
      detail: `authorization_servers is ${JSON.stringify(servers)}, expected to include "${origin}"`,
    };
  }
  return { name, ok: true, detail: `resource ${origin}/mcp, authorization server ${origin}` };
}

function describeAuthorizationServer(result, origin) {
  const name = "OAuth authorization-server metadata";
  const url = `${origin}/.well-known/oauth-authorization-server`;
  if (isPropagating(result)) {
    return { name, ok: false, kind: "propagation", detail: propagationDetail(result, url) };
  }
  if (result.status === 401) {
    return {
      name,
      ok: false,
      kind: "oauth",
      detail: `HTTP 401 on ${url}: the deployed Worker predates OAuth. Deploy this checkout (\`npm run setup\`), then re-check.`,
    };
  }
  if (result.status !== 200) {
    return { name, ok: false, kind: "oauth", detail: `HTTP ${result.status} on ${url}: ${result.text?.slice(0, 200) ?? ""}` };
  }
  if (result.body?.issuer !== origin) {
    return { name, ok: false, kind: "oauth", detail: `issuer is "${result.body?.issuer}", expected "${origin}"` };
  }
  if (result.body.client_id_metadata_document_supported !== true) {
    return {
      name,
      ok: false,
      kind: "oauth",
      detail:
        "client_id_metadata_document_supported is not true: the global_fetch_strictly_public " +
        "compatibility flag is probably missing from the deploy.",
    };
  }
  return { name, ok: true, detail: `issuer ${origin}, client_id_metadata_document_supported: true` };
}

function describeMcpChallenge(result, origin) {
  const name = "OAuth challenge on anonymous /mcp";
  const url = `${origin}/mcp`;
  if (isPropagating(result)) {
    return { name, ok: false, kind: "propagation", detail: propagationDetail(result, url) };
  }
  if (result.status !== 401) {
    return { name, ok: false, kind: "oauth", detail: `expected HTTP 401 without a token, got HTTP ${result.status}` };
  }
  const challenge = result.headers?.get?.("www-authenticate") ?? "";
  const metadataRef = `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`;
  // Calendars and reminders add their read scopes to the challenge when the
  // deployment enables them, so check that mail:read is among the named
  // scopes rather than expecting the whole string to be exactly mail:read.
  const scopeMatch = /scope="([^"]*)"/.exec(challenge);
  const scopes = scopeMatch ? scopeMatch[1].split(/\s+/).filter(Boolean) : [];
  if (!challenge.includes(metadataRef) || !scopes.includes("mail:read")) {
    return {
      name,
      ok: false,
      kind: "oauth",
      detail: `WWW-Authenticate was "${challenge}", expected resource_metadata and a scope list including mail:read`,
    };
  }
  return { name, ok: true, detail: `HTTP 401 pointing at the OAuth metadata, scopes ${scopes.join(" ")}` };
}

function describeHealth(result, base) {
  const name = "authenticated /healthz";
  if (isPropagating(result)) {
    return { name, ok: false, kind: "propagation", detail: propagationDetail(result, base) };
  }
  if (result.status === 401 || result.status === 403) {
    return { name, ok: false, kind: "authorization", detail: `HTTP ${result.status}: the Worker rejected this API token` };
  }
  if (result.status === 500 && errorCode(result) === "not_configured") {
    return { name, ok: false, kind: "configuration", detail: "the Worker has no API_TOKEN secret yet (HTTP 500 not_configured)" };
  }
  const code = errorCode(result);
  if (result.status === 503 && HEALTHZ_UPSTREAM_CODES.has(code)) {
    return describeUpstreamHealth(name, code, result.body.error.message);
  }
  if (result.status === 200 && result.body?.ok === true) {
    return { name, ok: true, detail: `HTTP 200, ok: true (IMAP login in ${result.body.imapLatencyMs ?? "?"} ms)` };
  }
  return { name, ok: false, kind: "http", detail: `HTTP ${result.status}: ${result.text?.slice(0, 200) ?? ""}` };
}

function describeUpstreamHealth(name, code, message) {
  const reported = message ? `${code}: ${message}` : code;
  if (code === "TIMEOUT") {
    return {
      name,
      ok: false,
      kind: "upstream_timeout",
      detail:
        `iCloud did not answer the IMAP login in time (${reported}). ` +
        "This may be a network or mail-server delay; it does not by itself mean the app-specific password is wrong.",
    };
  }
  if (code === "LIMIT") {
    return {
      name,
      ok: false,
      kind: "limit",
      detail:
        `The Worker stopped on IMAP LIMIT (${reported}): a proxy response-size cap, not an iCloud rate limit. ` +
        "This is not a reason to rotate the app-specific password.",
    };
  }
  return {
    name,
    ok: false,
    kind: "upstream",
    detail:
      `iCloud IMAP ${reported}. The Worker cannot tell whether this is a wrong or revoked ` +
      "app-specific password or another mail-server failure.",
  };
}

async function checkMcp({ base, token, fetchImpl, retry, deadlineMs }) {
  const name = "MCP initialize and tools/list";
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  const post = (body, extraHeaders = {}) =>
    attempt(
      fetchImpl,
      `${base}/mcp`,
      {
        method: "POST",
        headers: { ...headers, ...extraHeaders },
        body: JSON.stringify(body),
      },
      deadlineMs,
    );

  const init = await retry(() =>
    post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "icloud-mail-proxy-setup", version: "1" },
      },
    }),
  );
  if (init.status !== 200) {
    return { name, ok: false, kind: init.status === 401 ? "authorization" : "protocol", detail: `initialize returned HTTP ${init.status}` };
  }
  const initMessage = parseJsonRpc(init.contentType, init.text);
  if (!initMessage?.result?.protocolVersion) {
    return { name, ok: false, kind: "protocol", detail: "initialize did not return a protocol version" };
  }
  const sessionId = init.headers?.get?.("mcp-session-id");
  const versionHeaders = {
    "MCP-Protocol-Version": initMessage.result.protocolVersion,
    ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
  };
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, versionHeaders);
  if (list.status !== 200) {
    return { name, ok: false, kind: "protocol", detail: `tools/list returned HTTP ${list.status}` };
  }
  const listMessage = parseJsonRpc(list.contentType, list.text);
  const tools = listMessage?.result?.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return { name, ok: false, kind: "protocol", detail: "tools/list returned no tools" };
  }
  return { name, ok: true, detail: `${tools.length} tools: ${tools.map((t) => t.name).join(", ")}` };
}

/**
 * Bounded read-only search (limit 1, metadata only) proving the first allowed
 * folder exists upstream — /v1/mailboxes only echoes configuration.
 */
async function checkMailbox({ base, authHeaders, mailbox, fetchImpl, retry, deadlineMs }) {
  const name = `folder "${mailbox}" is readable`;
  const result = await retry(() =>
    attempt(
      fetchImpl,
      `${base}/v1/search`,
      {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ mailbox, limit: 1 }),
      },
      deadlineMs,
    ),
  );
  if (result.status === 200 && result.body && typeof result.body.total === "number") {
    return { name, ok: true, detail: `${result.body.total} message(s) match the default look-back window` };
  }
  if (isPropagating(result)) {
    return { name, ok: false, kind: "propagation", detail: propagationDetail(result, base) };
  }
  if (result.status === 401 || (result.status === 403 && errorCode(result) === "unauthorized")) {
    return { name, ok: false, kind: "authorization", detail: `HTTP ${result.status}: the Worker rejected this API token` };
  }
  if (errorCode(result) === "not_configured") {
    return { name, ok: false, kind: "configuration", detail: "the Worker has no API_TOKEN secret yet (HTTP 500 not_configured)" };
  }
  if (errorCode(result) === "mailbox_not_allowed") {
    return {
      name,
      ok: false,
      kind: "mailbox",
      detail: `folder "${mailbox}" is not in ALLOWED_MAILBOXES. Folder names must match the configured list exactly.`,
    };
  }
  const code = errorCode(result);
  if (result.status === 503 && code === "TIMEOUT") {
    return {
      name,
      ok: false,
      kind: "upstream_timeout",
      detail:
        `iCloud timed out while reading "${mailbox}". This may be a network or mail-server delay; ` +
        "it does not by itself mean the folder name is wrong.",
    };
  }
  if ((result.status === 503 && HEALTHZ_UPSTREAM_CODES.has(code)) || code === "upstream_imap_error") {
    const message = result.body?.error?.message ?? code;
    if (/mailbox|folder|does not exist|unknown mailbox/i.test(message) || code === "NO") {
      return {
        name,
        ok: false,
        kind: "mailbox",
        detail:
          `HTTP ${result.status}: ${message}. This often means the folder name does not match iCloud exactly, ` +
          "but the mail server does not always distinguish that from other failures. Re-run `npm run setup` to correct the list.",
      };
    }
    return {
      name,
      ok: false,
      kind: "upstream",
      detail: `HTTP ${result.status}: ${message}. The mail server did not complete the search; this is not specifically a folder-name mismatch.`,
    };
  }
  return {
    name,
    ok: false,
    kind: "http",
    detail: `HTTP ${result.status ?? "-"}: ${result.body?.error?.message ?? result.networkError ?? "unexpected response"}`,
  };
}
