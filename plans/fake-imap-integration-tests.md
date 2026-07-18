# Fake-IMAP integration tests

**What**: Exercise the `ImapSession` state machine (tagged responses,
literals, timeouts, multi-line FETCH) against a canned-transcript fake IMAP
server, instead of only unit-testing pure parsers.

**Why deferred**: Today's `test/imap-parse.test.ts` covers the pure parsing
functions in `src/imap-parse.ts`; wiring up `@cloudflare/vitest-pool-workers`
with a fake TCP-ish server for `cloudflare:sockets` is a larger setup lift
than the current test needs justified.

**Sketch**:
- Add `@cloudflare/vitest-pool-workers` config (`vitest.config.ts` +
  `wrangler.jsonc` test binding if needed) to run tests inside the
  `workerd` runtime, where `cloudflare:sockets` is available.
- Build a fake socket/server that replays fixed transcripts (LOGIN OK,
  EXAMINE response, UID SEARCH results, UID FETCH with literals) keyed off
  the command it receives, to drive `src/imap.ts`'s `ImapSession` end to end.
- Cover: tagged-response completion detection, continuation (`+`) handling
  if `utf8-search.md` lands, literal byte-counting across TCP chunk
  boundaries, and a connection timeout/abort path.
- Keep these separate from `test/imap-parse.test.ts` (e.g.
  `test/imap-session.test.ts`) since they need the Workers pool, not plain
  vitest.

**Effort**: M
