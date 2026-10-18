// Bearer-token primitives and the OAuth grant epoch. Shared by the Worker
// entry point and the OAuth handlers (plans/oauth-mcp.md, step 2).

const encoder = new TextEncoder();

export function json(body: unknown, status: number, extraHeaders?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

/** Attach the no-store cache directive to any response. */
export function withNoStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "private, no-store");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

async function sha256(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", encoder.encode(value));
}

/** Constant-time comparison of two digests. */
function digestsEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  return crypto.subtle.timingSafeEqual(a, b);
}

/** The bearer token of an Authorization header, or null when absent or malformed. */
export function extractBearer(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m ? m[1] : null;
}

/**
 * Whether `presented` matches the deployment's API token. Both values are
 * SHA-256 hashed first so the constant-time compare works on equal-length
 * inputs and never branches on the secret's length. An empty `apiToken`
 * (server not configured) never matches.
 */
export async function tokenMatches(presented: string, apiToken: string): Promise<boolean> {
  if (!apiToken) return false;
  const [a, b] = await Promise.all([sha256(presented), sha256(apiToken)]);
  return digestsEqual(a, b);
}

/** Verify the request's bearer token against the deployment's API token. */
export async function isAuthorized(request: Request, apiToken: string): Promise<boolean> {
  const presented = extractBearer(request);
  if (presented === null) return false;
  return tokenMatches(presented, apiToken);
}

const GRANT_EPOCH_MESSAGE = "grant-epoch-v1";
let cachedEpoch: { token: string; epoch: Promise<string> } | null = null;

/**
 * A stable, non-reversible tag of the current API token, bound into every
 * OAuth grant. Rotating API_TOKEN changes the epoch, so existing grants stop
 * matching and are revoked (plans/oauth-mcp.md, step 5). Memoized per isolate
 * on the token value: it can only change by redeploy.
 */
export function grantEpoch(apiToken: string): Promise<string> {
  if (!cachedEpoch || cachedEpoch.token !== apiToken) {
    cachedEpoch = { token: apiToken, epoch: computeEpoch(apiToken) };
  }
  return cachedEpoch.epoch;
}

async function computeEpoch(apiToken: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(GRANT_EPOCH_MESSAGE));
  return base64Url(new Uint8Array(signature));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Whether a grant's stored epoch still matches the current API token. */
export async function epochMatches(epoch: unknown, apiToken: string): Promise<boolean> {
  if (typeof epoch !== "string" || epoch === "") return false;
  return tokenMatches(epoch, await grantEpoch(apiToken));
}

/**
 * Whether a grant was minted by the consent flow that enforces S256 PKCE
 * (the `pkce` prop it stamps). Checked at every authorization-code exchange
 * and refresh, so an upgrade cannot be bridged with a code or refresh token
 * minted under the previous policy: those grants are refused and revoked,
 * and the client reconnects (plans/oauth-mcp.md, review round 4).
 */
export function hasPkcePolicy(props: Record<string, unknown> | undefined): boolean {
  return props?.pkce === true;
}

// ---- owner approval session cookie (plans/email-send.md, step 6) ----------

export const SEND_COOKIE_NAME = "__Host-send";
export const SEND_COOKIE_MAX_AGE_SECONDS = 900;

const SEND_COOKIE_MESSAGE = "send-approval-v1";

/** What the approval page accepts, and can mint sessions with. */
export interface ApprovalEnv {
  API_TOKEN: string;
  SEND_APPROVAL_TOKEN?: string;
}

/**
 * The credential the approval page asks for: `SEND_APPROVAL_TOKEN` when the
 * owner set one, else `API_TOKEN`. A deployment where agents hold `API_TOKEN`
 * (they all do — it is the MCP bearer) should set the dedicated secret, or a
 * shell-capable agent could approve its own drafts and the human gate would
 * be decorative.
 */
export function approvalSecret(env: ApprovalEnv): string {
  return (env.SEND_APPROVAL_TOKEN ?? "").trim() || env.API_TOKEN;
}

/**
 * The cookie value for a sign-in that expires at `expiry` (epoch ms):
 * `<expiry>.<HMAC(secret, "send-approval-v1|<API_TOKEN>|<expiry>")>`. The
 * message carries the API token too, so rotating either credential
 * invalidates every live approval session.
 */
export async function sendCookieValue(secret: string, apiToken: string, expiry: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${SEND_COOKIE_MESSAGE}|${apiToken}|${expiry}`),
  );
  return `${expiry}.${base64Url(new Uint8Array(signature))}`;
}

/** The raw `__Host-send` cookie from a Cookie header, or null. */
export function sendCookieFrom(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SEND_COOKIE_NAME && rest.length > 0) return rest.join("=");
  }
  return null;
}

/**
 * Whether a request carries a valid, unexpired approval session. The
 * signature is compared in constant time against a fresh HMAC, so a tampered
 * or expired value fails without revealing which part was wrong.
 */
export async function hasSendSession(request: Request, env: ApprovalEnv, now = Date.now()): Promise<boolean> {
  const value = sendCookieFrom(request.headers.get("Cookie"));
  if (!value) return false;
  const dot = value.indexOf(".");
  if (dot <= 0) return false;
  const expiry = Number(value.slice(0, dot));
  if (!Number.isSafeInteger(expiry) || now >= expiry) return false;
  const expected = await sendCookieValue(approvalSecret(env), env.API_TOKEN, expiry);
  return tokenMatches(value, expected);
}

/** The Set-Cookie header value for a fresh approval session. */
export async function sendSessionCookie(env: ApprovalEnv, now = Date.now()): Promise<string> {
  const expiry = now + SEND_COOKIE_MAX_AGE_SECONDS * 1000;
  const value = await sendCookieValue(approvalSecret(env), env.API_TOKEN, expiry);
  return `${SEND_COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${SEND_COOKIE_MAX_AGE_SECONDS}`;
}
