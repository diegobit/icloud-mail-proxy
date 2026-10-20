# Mailbox mutations: archive and delete

**What**: Let the agent file a message away instead of only reading it. Two new
operations — `archive_mail` and `delete_mail` — exposed on both surfaces (MCP
tools and `POST /v1/messages/:mailbox/:uidValidity/:uid/{archive,trash}`).

Requested by the owner on 2026-10-20, after the agent could read a message but
had no way to clear the INBOX: the proxy is otherwise read-only plus send, so
"delete this" and "archive that" both come back as "not supported".

**Not a general IMAP write surface.** Two fixed destinations, no arbitrary
mailbox argument, no flag editing beyond what the move itself implies, and no
hard delete ever. The feature exists so the agent can act on a message it just
read; it must not become a way to rearrange a mailbox.

## Decisions to settle before implementing

1. **Archive destination.** `ALLOWED_ARCHIVE_MAILBOX`, default `Archive`
   (already in the default `ALLOWED_MAILBOXES`).
2. **Delete destination.** `ALLOWED_TRASH_MAILBOX`, default `Deleted Messages`
   (iCloud's own trash; confirm the exact name with `LIST "" "Deleted*"` on the
   live account before shipping — spaces matter, this repo's setup already
   validates folder names).
3. **Delete means trash, not expunge.** `delete_mail` issues a `MOVE` into
   `Deleted Messages`; the message stays recoverable for iCloud's retention
   window (30 days). Permanent removal stays the owner's action in a mail
   client. Document this in the tool description in those words, so a model
   cannot describe it as "permanently deleted".
4. **Unread state carries over.** A trashed unread message stops being an
   unread INBOX message, which is the point, but it also means the nightly
   "what is unread" pass silently loses an item. Accepted; the audit line is
   the record.

## Design

### IMAP layer

- `src/imap.ts` today issues `EXAMINE` (read-only) and never a write command
  except `APPEND`. Mutations need `SELECT`, so add `select(mailbox): { uidValidity, exists }`
  next to `examine`, reusing `parseExamineResponse` (the untagged responses are
  identical; only the command name and the read-write flag differ).
- Add `uidMove(uid, destination)`:
  - happy path `UID MOVE <uid> "<destination>"` (RFC 6851) when
    `capability()` advertises `MOVE`;
  - fallback `UID COPY` + `UID STORE <uid> +FLAGS.SILENT (\Deleted)` +
    `UID EXPUNGE <uid>` when the server advertises `UIDPLUS` but not `MOVE`;
  - if neither `MOVE` nor `UIDPLUS` is advertised, fail with a stable
    `unsupported_move` error rather than silently doing a plain `EXPUNGE`
    (which would purge every `\Deleted` message in the mailbox, not just this
    one).
  - The `\Deleted` flag from `+FLAGS.SILENT` in the fallback is deliberate:
    `UID EXPUNGE` is scoped to the named uid, so nothing else disappears.
- Destination is passed through `quoteImapString` and validated against the
  configured constant, never taken from the request.

### Core layer (`src/core.ts`)

```ts
export type MutationAction = "archive" | "trash";

export async function mutateMessage(
  env: Env,
  action: MutationAction,
  mailbox: string,
  uidValidity: number,
  uid: number,
): Promise<{ ok: true; action: MutationAction; mailbox: string; uid: number; destination: string }>;
```

- `assertMailboxAllowed` on the source, as everywhere else.
- Reject a bad `uidValidity` with `409 uidvalidity_mismatch` after `SELECT`,
  exactly like `getMessage` — a stale id must not move the wrong message.
- A uid with no message (already moved, already deleted) is `404 message_not_found`,
  which makes the operation safely re-runnable.
- Archive/trash onto itself (`mailbox === destination`) is a no-op error:
  `400 destination_is_source`.
- Reuse `withRetryOnce` only for `BYE`. `MOVE` is not idempotent in the
  `BYE`-during-command case — a retry after a dropped connection may find the
  message already gone and return `404`. That is acceptable and must be
  documented in the tool description as "call it again and treat
  `message_not_found` as success if the message is no longer in the source".

### Transport layer

- `src/rest.ts`: two routes, `POST /v1/messages/:mailbox/:uidValidity/:uid/archive`
  and `.../trash`. No request body. Response `{ ok, action, mailbox, uid, destination }`.
  `mapError` already turns `ApiError`/`ImapError` into JSON.
- `src/mcp.ts`: `archive_mail` and `delete_mail`, both taking
  `{ mailbox, uidValidity, uid }`, both annotated
  `{ readOnlyHint: false, destructiveHint: true, idempotentHint: true }`
  (archive is arguably not destructive; keep `destructiveHint: true` on
  `delete_mail` only and `false` on `archive_mail`).
- Update the server `instructions` string and the README's "Message bodies are
  untrusted input" bullet: with mutations, an injected instruction can now also
  file or trash real mail. Say so plainly, next to the existing sentence about
  sending.

### Audit

`SendLedger` already records sends. Do not extend the ledger for mutations —
add one structured `console.log` line per mutation (`principal`, `action`,
`mailbox`, `uid`, `destination`, no subject, no body) so `wrangler tail` shows
it, and note in the README that mutations are visible there but not in a
durable audit trail. If the owner wants durable history, that is a separate
plan.

## Security

- The bearer/OAuth check is unchanged; any authenticated principal gets both
  tools. There is one token today, so this matches the send decision.
- Two fixed destinations + an allowlisted source bound the blast radius: the
  worst a prompt-injected agent can do is file messages into `Archive` or
  `Deleted Messages`, where the owner can still see them.
- No `EXPUNGE` without a uid, no `STORE` of arbitrary flags, no `CREATE`,
  no `DELETE` mailbox.

## Steps (each leaves the repo green)

1. **Framing.** `src/imap-mutations.ts`: pure builders `buildMove(uid, mailbox)`,
   `buildCopy`, `buildStoreDeleted`, `buildUidExpunge`; unit tests for quoting
   and uid validation, mirroring `test/imap-append.test.ts`.
2. **Session.** `select()` plus `uidMove()` with the `CAPABILITY` branch in
   `src/imap.ts`. No test without the workers pool — cover it in
   `plans/fake-imap-integration-tests.md`'s harness when that lands, and at
   minimum unit-test the branch selection as a pure function.
3. **Core.** `mutateMessage` in `src/core.ts`, with `ApiError` for every
   client-side case listed above.
4. **REST.** The two routes in `src/rest.ts` plus route tests.
5. **MCP.** `archive_mail` / `delete_mail`, updated server instructions.
6. **Docs.** README: a "Filing and deleting" section next to "Sending mail",
   the untrusted-input bullet, and the security-model paragraph.
   DEPLOY.md: the two new vars and how to confirm the trash folder name.
7. **Acceptance.** On the live Worker: archive a real message and confirm it
   shows up in `Archive`; trash another and confirm it lands in the iCloud
   trash from a mail client; re-run both on the same uid and confirm
   `message_not_found`; confirm the audit lines in `wrangler tail`.

## Open items and risks

- **Does `imap.mail.me.com` advertise `MOVE`?** Unknown until probed. The
  fallback path exists precisely because it may not. Probe first — it decides
  whether the fallback needs to be right on day one.
- **`SELECT` cost.** Mutations need a read-write select, which can be slow on a
  large INBOX and makes the server update its own state. Acceptable per
  single-uid call; do not batch.
- **Trash vs archive semantics differ per client.** Apple Mail's own "Archive"
  button and this proxy must land in the same folder or the owner will find two
  archives. Verify the destination is the same one Apple Mail uses before
  shipping the default.
- **No batch, no undo.** One uid per call, no "restore" tool. Restoring is the
  owner's action in a mail client; adding `restore_mail` later is cheap once
  `mutateMessage` exists (same shape, reversed destination).

## Estimate

M — the IMAP plumbing is the only risky part; everything else is the shape
this repo already uses for send. Roughly: framing + session 1 unit of work,
core + transports 1, docs and live acceptance 1.
