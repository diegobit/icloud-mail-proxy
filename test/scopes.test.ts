import { describe, expect, it } from "vitest";
import { ApiError } from "../src/core";
import { authorityOf, hasScope, requireScope } from "../src/scopes";

describe("authorityOf", () => {
  it("treats the static bearer as the owner, whatever the empty auth scope says", () => {
    const authority = authorityOf({ via: "bearer" }, { scope: [] });
    expect(authority).toEqual({ via: "bearer", scopes: [] });
    expect(hasScope(authority, "mail:read")).toBe(true);
    expect(hasScope(authority, "calendar:write")).toBe(true);
    expect(hasScope(authority, "calendar:delete")).toBe(true);
    expect(hasScope(authority, "mail:modify")).toBe(true);
    expect(hasScope(authority, "mail:trash")).toBe(true);
    expect(hasScope(authority, "mail:send")).toBe(true);
  });

  it("reads the approved scopes of an OAuth grant", () => {
    const authority = authorityOf({ via: "oauth" }, { scope: ["mail:read", "calendar:read"] });
    expect(authority).toEqual({ via: "oauth", scopes: ["mail:read", "calendar:read"] });
  });

  it("treats a missing via as OAuth, not as the bearer", () => {
    expect(authorityOf(undefined, { scope: ["mail:read"] })).toEqual({
      via: "oauth",
      scopes: ["mail:read"],
    });
    expect(hasScope(authorityOf(undefined, { scope: [] }), "calendar:write")).toBe(false);
  });

  it("drops non-string entries and a missing scope array", () => {
    expect(authorityOf({ via: "oauth" }, { scope: ["mail:read", 1, null, {}] })).toEqual({
      via: "oauth",
      scopes: ["mail:read"],
    });
    expect(authorityOf({ via: "oauth" }, undefined)).toEqual({ via: "oauth", scopes: [] });
    expect(authorityOf({ via: "oauth" }, { scope: "mail:read" })).toEqual({
      via: "oauth",
      scopes: [],
    });
  });
});

describe("hasScope", () => {
  const oauth = (scopes: string[]) => authorityOf({ via: "oauth" }, { scope: scopes });

  it("checks the exact scope", () => {
    expect(hasScope(oauth(["mail:read"]), "mail:read")).toBe(true);
    expect(hasScope(oauth(["calendar:read"]), "calendar:read")).toBe(true);
  });

  it("lets write or delete grants read, without granting each other", () => {
    expect(hasScope(oauth(["calendar:write"]), "calendar:read")).toBe(true);
    expect(hasScope(oauth(["calendar:delete"]), "calendar:read")).toBe(true);
    expect(hasScope(oauth(["calendar:read"]), "calendar:write")).toBe(false);
    expect(hasScope(oauth(["calendar:read"]), "calendar:delete")).toBe(false);
    expect(hasScope(oauth(["calendar:write"]), "calendar:delete")).toBe(false);
    expect(hasScope(oauth(["calendar:delete"]), "calendar:write")).toBe(false);
  });

  it("lets each mail write scope read, without granting another write", () => {
    for (const held of ["mail:modify", "mail:trash", "mail:send"]) {
      expect(hasScope(oauth([held]), "mail:read")).toBe(true);
    }
    expect(hasScope(oauth(["mail:modify"]), "mail:trash")).toBe(false);
    expect(hasScope(oauth(["mail:modify"]), "mail:send")).toBe(false);
    expect(hasScope(oauth(["mail:trash"]), "mail:modify")).toBe(false);
    expect(hasScope(oauth(["mail:trash"]), "mail:send")).toBe(false);
    expect(hasScope(oauth(["mail:send"]), "mail:modify")).toBe(false);
    expect(hasScope(oauth(["mail:send"]), "mail:trash")).toBe(false);
  });

  it("no longer lets mail:read write: a grant from before the split only reads", () => {
    const legacy = oauth(["mail:read"]);
    expect(hasScope(legacy, "mail:read")).toBe(true);
    expect(hasScope(legacy, "mail:modify")).toBe(false);
    expect(hasScope(legacy, "mail:trash")).toBe(false);
    expect(hasScope(legacy, "mail:send")).toBe(false);
  });

  it("does not cross domains through an implication", () => {
    expect(hasScope(oauth(["mail:send", "mail:modify", "mail:trash"]), "calendar:read")).toBe(false);
    expect(hasScope(oauth(["calendar:write", "calendar:delete"]), "mail:read")).toBe(false);
  });

  it("does not let mail:read open the calendar domain", () => {
    expect(hasScope(oauth(["mail:read"]), "calendar:read")).toBe(false);
  });
});

describe("requireScope", () => {
  it("throws a 403 insufficient_scope ApiError", () => {
    const authority = authorityOf({ via: "oauth" }, { scope: ["mail:read"] });
    try {
      requireScope(authority, "calendar:read");
      throw new Error("expected requireScope to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: 403, code: "insufficient_scope" });
      expect((error as Error).message).toContain("calendar:read");
    }
  });

  it("allows an approved scope and the write-implies-read case", () => {
    expect(() => requireScope(authorityOf({ via: "oauth" }, { scope: ["calendar:read"] }), "calendar:read")).not.toThrow();
    expect(() =>
      requireScope(authorityOf({ via: "oauth" }, { scope: ["calendar:write"] }), "calendar:read"),
    ).not.toThrow();
    expect(() =>
      requireScope(authorityOf({ via: "oauth" }, { scope: ["calendar:delete"] }), "calendar:read"),
    ).not.toThrow();
  });

  it("requires calendar:delete for delete and rejects a write-only grant", () => {
    expect(() =>
      requireScope(authorityOf({ via: "oauth" }, { scope: ["calendar:delete"] }), "calendar:delete"),
    ).not.toThrow();
    expect(() =>
      requireScope(authorityOf({ via: "oauth" }, { scope: ["calendar:write"] }), "calendar:delete"),
    ).toThrow(/calendar:delete/);
  });

  it("allows everything to the static bearer", () => {
    const bearer = authorityOf({ via: "bearer" }, { scope: [] });
    expect(() => requireScope(bearer, "calendar:write")).not.toThrow();
    expect(() => requireScope(bearer, "calendar:delete")).not.toThrow();
  });
});
