# UTF-8 search terms

**What**: Allow non-ASCII `from`/`subject`/`text` search values in `/v1/search`
and `search_mail`, instead of rejecting them with `invalid_criteria`.

**Why deferred**: No current need (owner's mail traffic is ASCII), and it
requires implementing IMAP literal continuation handling, which today's
minimal client doesn't do.

**Sketch**:
- `src/imap.ts`: implement literal syntax for SEARCH string args
  (`{N}\r\n<N bytes>`) and handle the server's `+ ` continuation-request line
  before sending the literal bytes. Currently the client only builds
  quoted-string commands via `quoteImapString`.
- Send `SEARCH CHARSET UTF-8 ...` instead of plain `SEARCH`; confirm
  `imap.mail.me.com` accepts `UTF-8` charset (most servers do).
- `src/rest.ts` / `src/mcp.ts` / validation layer: remove the ASCII-only
  rejection for `from`/`subject`/`text`, encode the literal as UTF-8 bytes.
- Add parser tests for literal framing in `test/imap-parse.test.ts`.
- Update README "Limitations" section to drop the ASCII-only line.

**Effort**: M
