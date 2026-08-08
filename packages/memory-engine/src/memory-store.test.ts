import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DemoMemorySession, FileMemoryStore, validateMemoryPath } from "./memory-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("creates and version-checks controlled Memory files", () => {
    const session = new DemoMemorySession({ now: () => new Date("2026-08-08T09:00:00.000Z") });
    const created = session.apply({
      operation: "create",
      path: "memories/design-tools.md",
      content: "Figma 凭据：[CREDENTIAL:credential-1]\n来源：[SOURCE:source-1]",
      reason: "记录常用设计工具"
    });

    expect(created.credentialIds).toEqual(["credential-1"]);
    expect(created.sourceIds).toEqual(["source-1"]);
    expect(session.apply({
      operation: "update",
      path: created.path,
      expectedVersion: created.version,
      content: `${created.content}\n补充说明`,
      reason: "补充"
    }).version).not.toBe(created.version);
    expect(() => session.apply({
      operation: "update",
      path: created.path,
      expectedVersion: created.version,
      content: "过期覆盖",
      reason: "错误版本"
    })).toThrow("Memory changed");
  });

  it("rejects paths outside the controlled memories root", () => {
    for (const path of ["../secret.md", "/tmp/secret.md", "memories/../secret.md", "memories\\secret.md", "memories/file.txt"]) {
      expect(() => validateMemoryPath(path)).toThrow();
    }
  });

  it("persists plain Markdown through the file adapter", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-memory-"));
    temporaryDirectories.push(directory);
    const store = new FileMemoryStore({ rootDirectory: directory, now: () => new Date("2026-08-08T09:00:00.000Z") });

    const created = store.apply({
      operation: "create",
      path: "memories/projects/brain-buddy.md",
      content: "BrainBuddy 是本地记忆工具。",
      reason: "保存项目背景"
    });

    expect(readFileSync(join(directory, "projects", "brain-buddy.md"), "utf8")).toBe(created.content);
    expect(store.list()).toEqual([created]);
  });
});
