// Scope catalogue and the per-tool authorization check.
//
// The OAuth provider stores the scopes the owner approved on the grant; every
// access token carries them in `ctx.auth.scope`. The static API token takes a
// different path (`resolveExternalToken`): the library sets `ctx.auth.scope`
// to an empty array there, so `props.via === "bearer"` is the owner and holds
// every scope. A naive `scope.includes(...)` would break every bearer client.
//
// `calendar:write` implies `calendar:read`, so a grant widened to write can
// also read. The consent page offers read and write separately; the implication
// only ever widens the check, never the stored grant.

import { ApiError } from "./core";

export const SCOPES = [
  "mail:read",
  "calendar:read",
  "calendar:write",
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

export function hasScope(authority: Authority, scope: ResourceScope): boolean {
  if (authority.via === "bearer") return true;
  if (authority.scopes.includes(scope)) return true;
  if (scope === "calendar:read") return authority.scopes.includes("calendar:write");
  return false;
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
