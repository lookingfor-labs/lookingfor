import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseAccessGate } from "./database-access";

describe("DatabaseAccessGate", () => {
  const directories: string[] = [];

  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it("configures, locks and unlocks an in-memory password", () => {
    const gate = new DatabaseAccessGate();
    expect(gate.status()).toEqual({ passwordConfigured: false, unlocked: true });
    expect(gate.configure(undefined, "correct horse battery staple")).toEqual({ passwordConfigured: true, unlocked: true });
    expect(gate.lock()).toEqual({ passwordConfigured: true, unlocked: false });
    expect(() => gate.assertUnlocked()).toThrow("DATABASE_LOCKED");
    expect(() => gate.unlock("wrong password")).toThrow("DATABASE_PASSWORD_INVALID");
    expect(gate.unlock("correct horse battery staple")).toEqual({ passwordConfigured: true, unlocked: true });
  });

  it("persists only a restricted password verifier and requires the current password for changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-access-"));
    directories.push(directory);
    const metadataPath = join(directory, "database-access.json");
    const gate = new DatabaseAccessGate({ metadataPath });
    gate.configure(undefined, "first-password");

    const persisted = readFileSync(metadataPath, "utf8");
    expect(persisted).not.toContain("first-password");
    expect(statSync(metadataPath).mode & 0o777).toBe(0o600);

    const reopened = new DatabaseAccessGate({ metadataPath });
    expect(reopened.status()).toEqual({ passwordConfigured: true, unlocked: false });
    expect(() => reopened.configure("incorrect", "second-password")).toThrow("DATABASE_PASSWORD_INVALID");
    expect(reopened.configure("first-password", "second-password")).toEqual({ passwordConfigured: true, unlocked: true });
    reopened.lock();
    expect(() => reopened.unlock("first-password")).toThrow("DATABASE_PASSWORD_INVALID");
    expect(reopened.unlock("second-password").unlocked).toBe(true);
  });

  it("rejects passwords outside the supported length", () => {
    const gate = new DatabaseAccessGate();
    expect(() => gate.configure(undefined, "short")).toThrow("DATABASE_PASSWORD_WEAK");
    expect(() => gate.configure(undefined, "x".repeat(129))).toThrow("DATABASE_PASSWORD_WEAK");
  });
});
