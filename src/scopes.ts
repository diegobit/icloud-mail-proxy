// Scope catalogue and the per-tool authorization check.
//
// The OAuth provider stores the scopes the owner approved on the grant; every
// access token carries them in `ctx.auth.scope`. The static API token takes a
// different path (`resolveExternalToken`): the library sets `ctx.auth.scope`
// to an empty array there, so `props.via === "bearer"` is the owner and holds
// every scope. A naive `scope.includes(...)` would break every bearer client.
//
// Every write scope implies the read scope of its domain, so a grant can read
// what it acts on (the ids a mutation takes, the parent a reply quotes, the
// ETag an update needs). Write scopes never imply each other: a connector that
// approved create/update before delete existed cannot delete until it
// reconnects and the owner approves `calendar:delete`, and a grant that
// predates the mail split holds only `mail:read`, which no longer reaches the
// mail write tools.

import { ApiError } from "./core";

export const SCOPES = [
  "mail:read",
  "mail:modify",
  "mail:trash",
  "mail:send",
  "calendar:read",
  "calendar:write",
  "calendar:delete",
  "contacts:read",
  "offline_access",
] as const;

export type Scope = (typeof SCOPES)[number];
export type ResourceScope = Exclude<Scope, "offline_access">;

export interface Authority {
  via: "bearer" | "oauth";
  scopes: readonly string[];
}

/** The props the library puts on ctx for grant tokens and the static bearer. */
export interface AuthorityProps {
  via?: unknown;
}

export function authorityOf(
  props: AuthorityProps | undefined,
  auth: { scope?: unknown } | undefined,
): Authority {
  if (props?.via === "bearer") return { via: "bearer", scopes: [] };
  const scopes = Array.isArray(auth?.scope)
    ? auth.scope.filter((scope): scope is string => typeof scope === "string")
    : [];
  return { via: "oauth", scopes };
}

/** The scopes that also grant a read scope; nothing else is implied. */
const IMPLIES_READ: Partial<Record<ResourceScope, readonly ResourceScope[]>> = {
  "mail:read": ["mail:modify", "mail:trash", "mail:send"],
  "calendar:read": ["calendar:write", "calendar:delete"],
};

export function hasScope(authority: Authority, scope: ResourceScope): boolean {
  if (authority.via === "bearer") return true;
  if (authority.scopes.includes(scope)) return true;
  return (IMPLIES_READ[scope] ?? []).some((implying) => authority.scopes.includes(implying));
}

/** Throws the ApiError both surfaces report as `insufficient_scope`. */
export function requireScope(authority: Authority, scope: ResourceScope): void {
  if (hasScope(authority, scope)) return;
  throw new ApiError(
    403,
    "insufficient_scope",
    `this operation requires the ${scope} scope; reconnect and approve it`,
  );
}
