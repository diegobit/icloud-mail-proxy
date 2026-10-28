# Left out of the feature-gap roadmap

**Status (2026-10-28):** nothing here is scheduled. This is the companion to
[feature-gap-roadmap.md](feature-gap-roadmap.md): the things OpenAI's iCloud
plugins do that this proxy deliberately does not, and the ones deferred. Each
entry says why and what would reopen it. Baseline `origin/main` at `8d2d9b8`.

Opus 5.5 and GPT Astra were asked independently. Where both advised against
something it is under "Rejected"; where the owner decided to wait it is under
"Deferred by decision"; where only a sequencing question remains it is under
"Later".

## Rejected (both reviewers advised against)

**Invitations, attendees and `respond_event`.** iCloud advertises
`calendar-auto-schedule` (seen in the CalDAV probe), so a `PUT` carrying
`ATTENDEE`, or a changed `PARTSTAT`, probably makes the server email third
parties, outside the send caps, the duplicate window and the `SendLedger` audit.
No Apple document found confirms or rules this out, so treat it as unsafe.
Reopen only with a probe that uses addresses the owner controls and proves the
behaviour, plus a way to bring those messages under the send limits.
Related: RFC 6638, [calendar-delete-event.md](calendar-delete-event.md) (scheduling
resources stay read-only).

**Permanent delete and emptying the Trash.** Irreversible. `delete_mail` moving
to Trash with Apple's retention (about 30 days) is the safety net, and it turns
an injected "delete this" into a recoverable mistake. No reopening condition; the
owner empties the Trash in a mail client.

**`create_folder` and move or copy to arbitrary folders.** The proxy's model is
two fixed destinations chosen by configuration, never by the caller
([mailbox-mutations.md](mailbox-mutations.md)). Arbitrary targets undo that for
little gain. If filing into more places is ever wanted, add named, configured
destinations (a small allowlist like `ALLOWED_ARCHIVE_MAILBOX`), not caller-chosen
names.

**HTML bodies in outgoing mail.** The reasons in [email-send.md](email-send.md)
stand: the preview an agent reasons about differs from what is sent, and HTML
adds tracking URLs and rendering risk. Reading HTML is unaffected (it is already
converted to text).

**`send_draft`.** A draft is where the human reviews. Letting the agent send an
existing draft removes that checkpoint, and the proxy cannot tell a draft the
owner wrote from one an injected agent wrote. Reopen only with a dedicated scope
and a way to restrict it to drafts the owner marked ready.

**Event attachments.** Low value, and iCloud support for managed attachments
(RFC 8607) is not verified. Reopen only if an `OPTIONS` probe shows the
capability and a concrete need appears.

## Deferred by decision (2026-10-28)

**Bulk operations on several messages** (archive, trash, read, flag).
Sketch if reopened: at most about 20 UIDs per call, destinations stay fixed, one
audit line per message, and a per-message result because the `UID COPY` +
`\Deleted` + `UID EXPUNGE` fallback is not atomic on iCloud (no `MOVE`, probed
2026-10-20): the "state unknown" outcome must be reported per UID, never blindly
retried. Reopen when single-message calls are a real bottleneck. Prerequisite:
the scope split in the roadmap.

**Outgoing attachments, and forwarding with the original attachments.** Both
reviewers called this the strongest exfiltration path: an injected agent could
mail out invoices or documents. Sketch if reopened:

- a new scope `mail:attach` on top of `mail:send`, not folded into it;
- the caller names which attachments to carry (by `index` from
  `get_mail_message`); never "all";
- size limits far below Apple's 20 MB message ceiling, counting base64
  expansion; allowed types reuse `ALLOWED_ATTACHMENT_TYPES`;
- no fetching content from URLs; the `SendLedger` duplicate hash includes the
  file contents;
- `multipart/mixed` in `src/mime-build.ts`; the send recipient caps stay.
One reviewer preferred allowing attachments only through `save_draft` so a human
sends. Prerequisite: the scope split in the roadmap.

## Later (sequencing only)

**Editing one occurrence, "this and following", `EXDATE`/`RDATE`.** Effort L.
`RECURRENCE-ID` overrides and series surgery are where calendar writers corrupt
data; iCloud also ignores `expand` in `calendar-query`, so the proxy expands
itself. Roadmap unit 7 only creates simple series and manages them whole.
Reopen when whole-series management proves insufficient.

**Scoping the static bearer per token or per mailbox.**
[token-scoping.md](token-scoping.md) stays deferred. Note the interaction: the
roadmap's scope split narrows OAuth grants, but the static bearer is still the
owner and holds every scope, so a leaked bearer is not narrowed by it.

**Apple Reminders.** Not reachable over CalDAV (CloudKit); already removed, see
the README "Reminders" section and [calendar-reminders.md](calendar-reminders.md).
A different design (EventKit on a Mac) would be needed.

**Writing contacts.** Contacts are read-only in the roadmap; creating or editing
them has no current need.
