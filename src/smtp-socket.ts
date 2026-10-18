// The Cloudflare socket transport for src/smtp.ts (plans/email-send.md,
// step 3). Kept apart so smtp.ts itself stays Node-testable: this is the only
// SMTP file that needs `cloudflare:sockets`.

import { connect } from "cloudflare:sockets";
import type { SmtpSocket, SmtpSocketFactory } from "./smtp";
import { socketOptionsFor } from "./smtp";

/**
 * Plain `connect` with TLS left off at the socket level: the SMTP client
 * issues STARTTLS explicitly after EHLO, so the upgrade is part of the
 * protocol state machine. The loopback test override (resolveSmtpTarget)
 * simply never sends STARTTLS.
 */
export const cloudflareSocketFactory: SmtpSocketFactory = (target) =>
  connect(
    { hostname: target.host, port: target.port },
    socketOptionsFor(target),
  ) as unknown as SmtpSocket;
