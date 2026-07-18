# Multi-Apple-user proxy — brainstorm

Turning this from a single-account proxy into one serving several Apple
users. Notes, not a commitment.

The one-sentence conclusion up front: **the current code already supports
multi-user with zero code changes** — one wrangler *environment* per user
gives each person their own Worker, secrets, hostname, and token. Everything
below is the reasoning for why that beats the alternatives.

## Account registry options

**(a) Shared Worker, per-account Worker secrets.** `ICLOUD_USER_<name>` /
`ICLOUD_APP_PASSWORD_<name>` pairs plus a token→account registry (see
below). One deployment serves everyone. Requires real code changes: token
lookup, per-account mailbox allowlists, per-account rate limits, audit
logging keyed by account. Fine to ~5 accounts mechanically, but every
account added widens the blast radius of a single Worker compromise.

**(b) Dynamic — encrypted credentials in KV.** A KV record per account
(`{ iCloudUser, encryptedAppPassword, allowedMailboxes, tokenHash }`),
AES-GCM-encrypted under one master-key Worker secret; an admin enrollment
endpoint adds/removes accounts without redeploy. Scales furthest and makes
rotation a data update — but it turns the Worker into a credential store
with a decrypt path. The master key is a single point of compromise for
*every* enrolled user's mail (and app-specific passwords also grant SMTP
send). Rejected below.

**(c) One Worker per user — via wrangler environments, not forks.** This is
the option the original draft undersold by calling it "fork the deploy".
Wrangler supports environments natively: an `env.alice` block in
wrangler.jsonc with its own `name` (`icloud-mail-proxy-alice`), its own
route (`alice-mail.diegobit.com`), and its own secrets
(`wrangler secret put ICLOUD_APP_PASSWORD -e alice`). Deploy is
`wrangler deploy -e alice`. Same repo, same code, N isolated Workers.
Full isolation per user — a leaked secret or runtime compromise in one
environment cannot reach another — at the cost of one config block and one
DNS route per user. **No src/ changes at all.**

## Request → account mapping (only relevant for shared-Worker options)

- **Per-user bearer token → account** is the only acceptable selector.
  Practical shape: a `TOKENS` mapping of SHA-256(token) → account name;
  the existing digest-then-compare auth already hashes the presented token,
  so the lookup slots into the current `src/index.ts` logic naturally.
- **Path prefix `/u/{account}/...` with a shared token**: rejected — any
  caller can address any account by editing the URL. If tokens are already
  per-account, the prefix is redundant anyway; derive the account from the
  token and keep the paths identical for every user.
- **Separate hostnames** come for free with option (c) and are the cleanest
  mental model: each user's config is exactly today's single-user config.

## MCP shape

With account-from-token (or option (c)), **the MCP endpoint stays exactly
`/mcp` for everyone** — each user configures their own URL/token pair and
sees the same three tools. No per-user path needed, no code change.

An `account` tool parameter on a shared `/mcp` stays rejected: it puts the
enrolled-account list into LLM-visible context, where prompt-injected email
content flowing back through tool results could reference and target other
users. Isolation belongs in routing/auth, never in a tool argument.

## Security analysis (the important part)

- **Credential custody.** Running this for others means custody of their
  Apple app-specific passwords — which are not read-only: they grant IMAP,
  SMTP send-as-them, and more. Holding N of them is a materially different
  liability than holding your own. For non-family users this also drifts
  into data-protection territory (you are processing third parties' mail).
- **Blast radius is the deciding axis.** Shared Worker (a/b): one
  compromise exposes everyone. Per-user environments (c): one compromise
  exposes one person. Developer convenience does not outrank this.
- **Per-user rate limits** are only needed in shared-Worker designs — one
  runaway token must not exhaust connection budget or trip Apple-side
  throttling for everyone. With (c), Cloudflare-level limits per hostname
  do the job with no code.
- **Apple-side behavior.** Expect per-account "your Apple ID was used to
  sign in" security notices, and know that Apple can unilaterally revoke
  app-specific passwords on suspicious-activity heuristics. Each user must
  be able to recognize these notices as expected — another argument for
  users who understand what they signed up for, i.e. close-trusted ones.
- **Audit logging without content** (shared designs only): log account,
  mailbox, timestamp — never search terms or content, matching the existing
  no-content-logging rule.
- **Revocation.** (c): revoke their Apple password + delete their
  environment/secrets — clean, infra-level, per-user. (a): delete their
  secret pair + token entry. (b): data-plane delete that silently depends
  on the master key never having leaked beforehand — the weakest story.

## Operational

- **Onboarding (c)**: user creates their own app-specific password at
  appleid.apple.com (never pasted through chat — same rule as this repo's
  DEPLOY.md), enters it via `wrangler secret put ... -e <name>` themselves
  or during a screen-shared setup; you add the env block + DNS route and
  deploy. Minutes per user.
- **Offboarding (c)**: `wrangler delete -e <name>`, remove the route, and
  have the user revoke the Apple password — proxy-side revocation alone is
  insufficient if the password ever leaked elsewhere.
- **Rotation**: identical to today's DEPLOY.md runbook, run per environment.
- **Cost/limits**: N light-traffic Workers is still free-tier territory;
  Workers-per-account and routes-per-zone limits are far above
  personal scale. Secret-count ceilings only bite the shared-Worker options.

## Recommendation

- **2–3 trusted family members**: option (c) via wrangler environments.
  It is *less* total work than (a) — no token registry, no per-account
  code, no new tests — and strictly better isolation. Each person gets
  `<name>-mail.diegobit.com`, their own token, their own revocation story.
- **An actual multi-tenant service** (strangers, self-serve): don't. Not
  (b) — a central store of other people's full-access Apple passwords is a
  multi-victim incident waiting on a single bug — and not (c)-at-scale
  either, because custody itself is the problem, not the architecture.
  Point strangers at the README's "deploy it yourself with an agent" flow:
  the whole value of this design is that the credential never has to leave
  its owner's control.
- **Trigger to revisit**: if Apple ever ships scoped/read-only mail tokens
  or OAuth for IMAP, the custody objection weakens and (b)-style dynamic
  enrollment becomes defensible. Until then, isolation-by-deployment wins.
