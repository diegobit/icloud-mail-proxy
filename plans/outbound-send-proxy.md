# Outbound send proxy

> **Superseded 2026-10-18 by [`plans/email-send.md`](email-send.md).** The
> owner decided to build sending into this Worker, always on for
> authenticated callers, with a draft-first flow where only the owner's
> approval on the Worker's own page can send. The separate-Worker,
> separate-password, allowlist sketch below is kept as history: the
> guarantee it protected ("cannot send even if compromised") is knowingly
> dropped, and the approval page replaces the allowlist as the safety
> control.

**What**: A way for an agent to send mail through the same iCloud account.

**Why deferred**: Deliberately, not just for lack of time. This repo's core
security property is "zero SMTP code, cannot send mail even if compromised."
Adding send capability here would erase that guarantee for the read proxy too.

**Sketch** (if ever built, as a *separate* project):
- A second, separate Worker (separate deployment, separate `wrangler.jsonc`),
  so a compromise of the read proxy still cannot send mail.
- A separate Apple app-specific password dedicated to sending (never reuse
  the read-proxy's password), so revoking one doesn't affect the other.
- New minimal SMTP client over `cloudflare:sockets` to `smtp.mail.me.com:587`
  (STARTTLS, AUTH LOGIN/PLAIN) — mirrors `src/imap.ts` in spirit but is new
  code, not an extension of it.
- Recipient allowlist hard-coded server-side (e.g. only the owner's own
  address, or a short fixed list) — never let the caller specify an arbitrary
  `To:`.
- Its own bearer token, independent of the read proxy's `API_TOKEN`.

**Effort**: L (and should stay a separate repo/Worker if built)
