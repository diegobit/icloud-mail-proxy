# Security policy

This repository is a gateway to a live mailbox and calendar. The deployed
instance at `https://icloud-mail.diegobit.com` is one person's iCloud account:
**do not test against it.** Deploy your own Worker to reproduce anything.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting — **Security → Report a
vulnerability** on this repository. Please do not open a public issue.

Include the commit you tested, what an attacker gains, and the smallest
reproduction you have. This is a personal project maintained in spare time:
expect an acknowledgement, not a fix deadline, and no bounty.

## Scope

In scope: anything that lets a caller act beyond the credentials it holds.
That includes authentication and token-handling bugs, scope checks that can be
bypassed, `ALLOWED_MAILBOXES` / `ALLOWED_CALENDARS` / send caps that can be
exceeded, server-side request forgery, injection through MCP or REST input, and
any path that shows message or calendar content to a principal that did not ask
for it.

Out of scope: findings that require the owner's own bearer token; the
documented design decisions (sending is direct, `delete_mail` moves to the
trash instead of expunging); rate-limit and denial-of-service noise; and
anything that only works against a deployment whose secrets were already
disclosed.

## What the project already promises

The README's [Security model](README.md#security-model) lists the guarantees
this code intends to make, and the ones it explicitly does not, including the
residual risk of a prompt-injected model sending mail.
