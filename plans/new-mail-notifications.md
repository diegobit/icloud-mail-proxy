# New-mail notifications

**What**: Periodically poll INBOX and push a notification when new mail
arrives, instead of requiring an agent to poll `/v1/search`.

**Why deferred**: Needs a KV namespace for the watermark and a decision on
notification target (webhook URL? ntfy.sh topic? Both are new attack surface
and new secrets to manage).

**Sketch**:
- `wrangler.jsonc`: add a `triggers.crons` entry (e.g. every 5 min) and a KV
  namespace binding for the watermark.
- New `src/cron.ts` (or a scheduled handler in `src/index.ts`): EXAMINE INBOX,
  `UID SEARCH UID <last-seen+1>:*`, compare against KV-stored
  `(uidValidity, lastUid)`, POST a summary (no body content) to a configured
  webhook for anything newer, then update the KV watermark.
- Handle `UIDVALIDITY` change by resetting the watermark (treat as "unseen
  history", don't backfill-notify).
- New Worker secret for the webhook URL/token; reuse `MessageSummary` shape
  from `src/types.ts` for the payload, still gated by `ALLOWED_MAILBOXES`.

**Effort**: M
