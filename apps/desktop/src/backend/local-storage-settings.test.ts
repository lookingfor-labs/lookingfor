import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, parse } from "node:path";
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
      databaseDirectory: join(applicationDataDirectory, "database"),
      memoryWritePolicy: "auto_apply"
    });
  });

  it("persists editable absolute directories and creates them", () => {
    const applicationDataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-settings-"));
    directories.push(applicationDataDirectory);
    const settings = {
      memoryDirectory: join(applicationDataDirectory, "custom-memory"),
      databaseDirectory: join(applicationDataDirectory, "custom-database"),
      memoryWritePolicy: "auto_apply" as const
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
    expect(() => store.configure({ memoryDirectory: "memories", databaseDirectory: applicationDataDirectory, memoryWritePolicy: "require_approval" }))
      .toThrow("LOCAL_STORAGE_PATH_NOT_ABSOLUTE");
  });

  it("rejects identical or nested Memory and database directories", () => {
    const applicationDataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-settings-"));
    directories.push(applicationDataDirectory);
    const store = new LocalStorageSettingsStore({ applicationDataDirectory });
    expect(() => store.configure({ memoryDirectory: applicationDataDirectory, databaseDirectory: applicationDataDirectory, memoryWritePolicy: "auto_apply" }))
      .toThrow("LOCAL_STORAGE_PATHS_OVERLAP");
    expect(() => store.configure({ memoryDirectory: join(applicationDataDirectory, "memory"), databaseDirectory: join(applicationDataDirectory, "memory", "database"), memoryWritePolicy: "auto_apply" }))
      .toThrow("LOCAL_STORAGE_PATHS_OVERLAP");
    expect(() => store.configure({ memoryDirectory: join(applicationDataDirectory, "memory"), databaseDirectory: join(applicationDataDirectory, "memory-revisions"), memoryWritePolicy: "auto_apply" }))
      .toThrow("LOCAL_STORAGE_PATHS_OVERLAP");
  });

  it("rejects filesystem roots, the home directory, files, and symbolic-link targets", () => {
    const applicationDataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-settings-"));
    directories.push(applicationDataDirectory);
    const store = new LocalStorageSettingsStore({ applicationDataDirectory });
    const databaseDirectory = join(applicationDataDirectory, "database");
    expect(() => store.configure({ memoryDirectory: parse(applicationDataDirectory).root, databaseDirectory, memoryWritePolicy: "auto_apply" }))
      .toThrow("LOCAL_STORAGE_PATH_TOO_BROAD");
    expect(() => store.configure({ memoryDirectory: homedir(), databaseDirectory, memoryWritePolicy: "auto_apply" }))
      .toThrow("LOCAL_STORAGE_PATH_TOO_BROAD");

    const filePath = join(applicationDataDirectory, "not-a-directory");
    writeFileSync(filePath, "file");
    expect(() => store.configure({ memoryDirectory: filePath, databaseDirectory, memoryWritePolicy: "auto_apply" }))
      .toThrow("LOCAL_STORAGE_PATH_NOT_DIRECTORY");
    expect(() => store.configure({ memoryDirectory: join(filePath, "memory"), databaseDirectory, memoryWritePolicy: "auto_apply" }))
      .toThrow("LOCAL_STORAGE_PATH_NOT_DIRECTORY");

    const link = join(applicationDataDirectory, "memory-link");
    symlinkSync(applicationDataDirectory, link, process.platform === "win32" ? "junction" : "dir");
    expect(() => store.configure({ memoryDirectory: link, databaseDirectory, memoryWritePolicy: "auto_apply" }))
      .toThrow("LOCAL_STORAGE_PATH_SYMLINK");
  });
});
