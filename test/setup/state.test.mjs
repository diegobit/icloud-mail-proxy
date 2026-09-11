import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoSecrets, fileStateStore, readState, writeState } from "../../scripts/lib/state.mjs";

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icloud-mail-state-"));
  return path.join(dir, "state.json");
}

describe("resume state", () => {
  it("round-trips the selected target", () => {
    const file = tempFile();
    const store = fileStateStore(file);
    expect(store.read()).toBe(null);
    store.write({ accountId: "acc-1", workerName: "w", allowedMailboxes: "INBOX", stage: "verified" });
    expect(store.read()).toMatchObject({ version: 1, accountId: "acc-1", workerName: "w", stage: "verified" });
    expect(readState(file).updatedAt).toBeTruthy();
  });

  it("is written only for the owner", () => {
    const file = tempFile();
    writeState({ accountId: "acc-1" }, { file });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("treats unreadable or corrupt state as absent", () => {
    const file = tempFile();
    fs.writeFileSync(file, "{ not json");
    expect(readState(file)).toBe(null);
    expect(readState(path.join(path.dirname(file), "missing.json"))).toBe(null);
  });

  it("refuses to persist a known secret value, wherever it is nested", () => {
    const file = tempFile();
    expect(() => writeState({ accountId: "acc", note: "token is s3cret-value" }, { file, secrets: ["s3cret-value"] })).toThrow(
      /refusing to persist a secret value at state\.note/,
    );
    expect(() =>
      writeState({ history: [{ pasted: "s3cret-value" }] }, { file, secrets: ["s3cret-value"] }),
    ).toThrow(/state\.history\[0\]\.pasted/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses a key that looks like it holds a credential", () => {
    for (const key of ["apiToken", "ICLOUD_APP_PASSWORD", "secretValue", "credentials"]) {
      expect(() => assertNoSecrets({ [key]: "whatever" })).toThrow(/secret-looking key/);
    }
    expect(() => assertNoSecrets({ progress: { uploadedAt: "2026-01-01T00:00:00Z" } })).not.toThrow();
  });
});
