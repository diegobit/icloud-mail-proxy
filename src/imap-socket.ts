// The Cloudflare socket transport for src/imap.ts. Kept apart so imap.ts
// itself stays importable under Node for the append/exchange unit tests: this
// is the only IMAP file that needs `cloudflare:sockets`.

import { connect } from "cloudflare:sockets";
import type { ImapSocketFactory, ImapSocketLike } from "./imap";

/** Implicit TLS to the iCloud IMAP endpoint. */
export const defaultImapSocketFactory: ImapSocketFactory = (address) =>
  connect(address, { secureTransport: "on", allowHalfOpen: false }) as unknown as ImapSocketLike;
