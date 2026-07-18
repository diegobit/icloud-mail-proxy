# KV message cache

**Status: REJECTED, not just deferred.**

**What**: Cache fetched message bodies in Workers KV, keyed by
`(mailbox, uidValidity, uid)`, to speed up repeated fetches of the same
message.

**Why rejected**: It copies mail content off Apple's servers and into
Cloudflare storage, permanently, outside the "no caching, no content
logging" guarantee this proxy currently makes (README Security model:
`Cache-Control: private, no-store`, no content ever persisted). That's a
real privacy regression for a latency problem that doesn't actually exist —
each request already opens one IMAP connection and fetches on demand, and
there's no evidence repeat-fetch latency is a problem worth trading privacy
for.

**Sketch (not to be built)**:
- Would add a KV namespace, cache-key by identity tuple, TTL, and a place in
  `src/core.ts`'s fetch path to check/populate it.

**Effort**: S (but don't)
