import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageSettingsStore } from "./local-storage-settings";

describe("LocalStorageSettingsStore", () => {
  const directories: string[] = [];

  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it("defaults to production-safe paths below the application data directory", () => {
    const applicationDataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-settings-"));
    directories.push(applicationDataDirectory);
    expect(new LocalStorageSettingsStore({ applicationDataDirectory }).get()).toEqual({
      memoryDirectory: join(applicationDataDirectory, "memories"),
      databaseDirectory: applicationDataDirectory
    });
  });

  it("persists editable absolute directories and creates them", () => {
    const applicationDataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-settings-"));
    directories.push(applicationDataDirectory);
    const settings = {
      memoryDirectory: join(applicationDataDirectory, "custom-memory"),
      databaseDirectory: join(applicationDataDirectory, "custom-database")
    };
    const store = new LocalStorageSettingsStore({ applicationDataDirectory });
    expect(store.configure(settings)).toEqual(settings);
    expect(new LocalStorageSettingsStore({ applicationDataDirectory }).get()).toEqual(settings);
    expect(statSync(settings.memoryDirectory).isDirectory()).toBe(true);
    expect(statSync(settings.databaseDirectory).isDirectory()).toBe(true);
    expect(readFileSync(join(applicationDataDirectory, "local-storage-settings.json"), "utf8")).toContain("custom-memory");
  });

  it("rejects relative paths", () => {
    const applicationDataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-settings-"));
    directories.push(applicationDataDirectory);
    const store = new LocalStorageSettingsStore({ applicationDataDirectory });
    expect(() => store.configure({ memoryDirectory: "memories", databaseDirectory: applicationDataDirectory }))
      .toThrow("LOCAL_STORAGE_PATH_NOT_ABSOLUTE");
  });
});
