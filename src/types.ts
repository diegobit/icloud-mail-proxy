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
}

export interface SearchResult {
  mailbox: string;
  uidValidity: number;
  total: number;      // total UIDs matched before limit
  messages: MessageSummary[];
}
