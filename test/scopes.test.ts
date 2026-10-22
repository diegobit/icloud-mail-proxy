import { describe, expect, it } from "vitest";
import { ApiError } from "../src/core";
import { authorityOf, hasScope, requireScope } from "../src/scopes";

describe("authorityOf", () => {
  it("treats the static bearer as the owner, whatever the empty auth scope says", () => {
    const authority = authorityOf({ via: "bearer" }, { scope: [] });
    expect(authority).toEqual({ via: "bearer", scopes: [] });
    expect(hasScope(authority, "mail:read")).toBe(true);
    expect(hasScope(authority, "calendar:write")).toBe(true);
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

  it("lets a write grant read, and nothing more", () => {
    expect(hasScope(oauth(["calendar:write"]), "calendar:read")).toBe(true);
    expect(hasScope(oauth(["calendar:read"]), "calendar:write")).toBe(false);
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
  });

  it("allows everything to the static bearer", () => {
    const bearer = authorityOf({ via: "bearer" }, { scope: [] });
    expect(() => requireScope(bearer, "calendar:write")).not.toThrow();
  });
});
