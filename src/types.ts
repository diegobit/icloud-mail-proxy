import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { SendLedger } from "./send-ledger";

export interface Env {
  ICLOUD_USER: string;
  ICLOUD_APP_PASSWORD: string;
  API_TOKEN: string;
  ALLOWED_MAILBOXES: string;
  MAX_RESULTS: string;
  MAX_MESSAGE_BYTES: string;
  MAX_SEARCH_DAYS: string;
  // Comma-separated MIME prefixes an attachment may have to be downloadable.
  // A trailing "/" entry is a type-prefix match (e.g. "image/"); an entry
  // without one matches the full type exactly (e.g. "application/pdf").
  ALLOWED_ATTACHMENT_TYPES: string;
  // Cap on the encoded size of a single downloadable attachment, in bytes.
  MAX_ATTACHMENT_BYTES: string;
  // Mutations (plans/mailbox-mutations.md): the two fixed destinations for
  // archive_mail / delete_mail. Configuration only, never request input; the
  // defaults are "Archive" and "Deleted Messages".
  ALLOWED_ARCHIVE_MAILBOX?: string;
  ALLOWED_TRASH_MAILBOX?: string;
  // OAuth on /mcp (plans/oauth-mcp.md). OAUTH_KV stores grants, tokens and
  // consent handles; the limiters guard the unauthenticated registration and
  // token endpoints; OAUTH_PROVIDER is injected by
  // @cloudflare/workers-oauth-provider into the env of the handlers it calls.
  OAUTH_KV: KVNamespace;
  OAUTH_REGISTER_LIMITER: RateLimit;
  OAUTH_TOKEN_LIMITER: RateLimit;
  OAUTH_PROVIDER: OAuthHelpers;
  // Public origin to advertise when the request URL is not the origin clients
  // reach (tunnels, proxies). Unset in normal deployments.
  PUBLIC_ORIGIN?: string;
  // Outgoing mail (plans/email-send.md). Caps are base vars clamped by
  // send-policy.ts; the From identity is optional; SMTP_HOST/SMTP_PORT are a
  // test-only loopback override that production ignores. SEND_LEDGER holds
  // the UTC quota counters, the duplicate-send window and the audit trail.
  SEND_MAX_PER_DAY: string;
  SEND_MAX_RCPTS_PER_DAY: string;
  SEND_MAX_RCPTS_PER_MESSAGE: string;
  SEND_MAX_BODY_BYTES: string;
  SEND_FROM?: string;
  SEND_FROM_NAME?: string;
  SEND_SENT_COPY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SEND_LEDGER: DurableObjectNamespace<SendLedger>;
}

export interface Address {
  name: string | null;
  address: string | null;
}

export interface MessageSummary {
  mailbox: string;
  uidValidity: number;
  uid: number;
  date: string | null;
  from: Address[];
  to: Address[];
  subject: string | null;
  size: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  // True when the message's BODYSTRUCTURE reports at least one attachment part;
  // false when there are none or the structure could not be parsed.
  hasAttachments: boolean;
}

export interface AttachmentInfo {
  index: number;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
}

export interface MessageDetail {
  id: { mailbox: string; uidValidity: number; uid: number };
  date: string | null;
  from: Address[];
  to: Address[];
  cc: Address[];
  subject: string | null;
  messageId: string | null;
  untrustedEmailContent: { text: string | null; textSource: "text" | "html" | null };
  attachments: AttachmentInfo[];
  // True when the message exceeded MAX_MESSAGE_BYTES and only its first bytes
  // were fetched; body/attachments may be incomplete.
  truncated: boolean;
}

export interface SearchParams {
  mailbox: string;
  after?: string;   // YYYY-MM-DD
  before?: string;  // YYYY-MM-DD
  from?: string;
  subject?: string;
  text?: string;
  limit?: number;
  unseen?: boolean;
  beforeUid?: number; // cursor: only return matches with uid < beforeUid
}

export interface SearchResult {
  mailbox: string;
  uidValidity: number;
  // Total UIDs matched by the date-window/criteria, before the limit and the
  // beforeUid cursor are applied; stable across pages of the same search.
  total: number;
  messages: MessageSummary[];
  // Cursor for the next (older) page: pass as beforeUid to continue, or null
  // when this page reached the oldest match in the window.
  nextBeforeUid: number | null;
}
