export interface Env {
  ICLOUD_USER: string;
  ICLOUD_APP_PASSWORD: string;
  API_TOKEN: string;
  ALLOWED_MAILBOXES: string;
  MAX_RESULTS: string;
  MAX_MESSAGE_BYTES: string;
  MAX_SEARCH_DAYS: string;
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
