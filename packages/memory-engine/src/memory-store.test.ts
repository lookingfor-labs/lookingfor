import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DemoMemorySession, FileMemoryStore, validateMemoryPath } from "./memory-store";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("prepares, commits, and reverts an exact Memory edit", () => {
    const session = new DemoMemorySession({ now: () => new Date("2026-08-08T09:00:00.000Z") });
    const created = session.apply({
      operation: "create",
      path: "memories/design-tools.md",
      content: "- Figma account: old@example.com\n- Status: active",
      reason: "Create the Memory"
    });

    const prepared = session.prepare({
      operation: "edit",
      path: created.path,
      expectedVersion: created.version,
      edits: [{ type: "replace", oldText: "old@example.com", newText: "new@example.com" }],
      reason: "Update the account"
    });

    expect(prepared.resultingContent).toBe("- Figma account: new@example.com\n- Status: active");
    expect(prepared.diff).toContain("-- Figma account: old@example.com");
    expect(prepared.diff).toContain("+- Figma account: new@example.com");

    const committed = session.commit(prepared, { runId: "run-1", toolCallId: "tool-1", writePolicy: "require_approval" });
    expect(committed.memory.content).toBe(prepared.resultingContent);
    expect(committed.memory.version).toMatch(/^2:[0-9a-f]{64}$/u);
    expect(committed.revision.status).toBe("applied");

    const reverted = session.revert(committed.revision.revisionId);
    expect(reverted.memory?.content).toBe(created.content);
    expect(reverted.memory?.version).toMatch(/^3:[0-9a-f]{64}$/u);
    expect(session.listRevisions().map(({ status }) => status)).toEqual(["applied", "reverted", "applied"]);
  });

  it("reverts a created Memory by deleting the file", () => {
    const session = new DemoMemorySession();
    const prepared = session.prepare({ operation: "create", path: "memories/new.md", content: "new", reason: "Create" });
    const committed = session.commit(prepared, { runId: "run-create", toolCallId: "tool-create", writePolicy: "auto_apply" });

    expect(session.revert(committed.revision.revisionId)).toEqual({ path: "memories/new.md", deleted: true, memory: null });
    expect(session.list()).toEqual([]);
  });

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

  it("rejects ambiguous edits without changing Memory", () => {
    const session = new DemoMemorySession();
    const created = session.apply({
      operation: "create",
      path: "memories/duplicates.md",
      content: "same\nsame",
      reason: "Create duplicates"
    });

    expect(() => session.prepare({
      operation: "edit",
      path: created.path,
      expectedVersion: created.version,
      edits: [{ type: "replace", oldText: "same", newText: "changed" }],
      reason: "Ambiguous change"
    })).toThrow("ambiguous");
    expect(session.list()[0]).toEqual(created);
  });

  it("rejects a stale write after Memory changes from A to B to A", () => {
    const session = new DemoMemorySession();
    const firstA = session.apply({ operation: "create", path: "memories/aba.md", content: "A", reason: "A" });
    const stale = session.prepare({
      operation: "edit",
      path: firstA.path,
      expectedVersion: firstA.version,
      edits: [{ type: "append", content: " stale" }],
      reason: "Stale change"
    });
    const b = session.apply({ operation: "update", path: firstA.path, expectedVersion: firstA.version, content: "B", reason: "B" });
    session.apply({ operation: "update", path: b.path, expectedVersion: b.version, content: "A", reason: "A again" });

    expect(() => session.commit(stale, { runId: "run-aba", toolCallId: "tool-aba", writePolicy: "auto_apply" }))
      .toThrow("Memory changed");
  });

  it("resets all in-memory files and Revisions", () => {
    const session = new DemoMemorySession();
    session.apply({ operation: "create", path: "memories/one.md", content: "One", reason: "Create one" });
    session.apply({ operation: "create", path: "memories/two.md", content: "Two", reason: "Create two" });

    expect(session.reset()).toEqual({ deletedMemoryCount: 2, deletedRevisionCount: 2 });
    expect(session.list()).toEqual([]);
    expect(session.listRevisions()).toEqual([]);

    const recreated = session.apply({ operation: "create", path: "memories/one.md", content: "Fresh", reason: "Recreate" });
    expect(recreated.version).toMatch(/^1:/u);
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

  it("keeps opaque versions and Revisions across file adapter restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-memory-"));
    const revisionDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-revisions-"));
    temporaryDirectories.push(directory, revisionDirectory);
    const options = {
      rootDirectory: directory,
      revisionDirectory,
      now: () => new Date("2026-08-08T09:00:00.000Z")
    };
    const store = new FileMemoryStore(options);
    const created = store.apply({
      operation: "create",
      path: "memories/profile.md",
      content: "Name: Ada",
      reason: "Create profile"
    });
    const prepared = store.prepare({
      operation: "edit",
      path: created.path,
      expectedVersion: created.version,
      edits: [{ type: "insert_after", anchor: "Name: Ada", content: "\nTool: Figma" }],
      reason: "Add tool"
    });
    const committed = store.commit(prepared, { runId: "run-2", toolCallId: "tool-2", writePolicy: "auto_apply" });

    const reopened = new FileMemoryStore(options);
    expect(reopened.list()).toEqual([committed.memory]);
    expect(reopened.listRevisions().map(({ status }) => status)).toEqual(["applied", "applied"]);

    writeFileSync(join(directory, "profile.md"), "Name: Grace\nTool: Figma", "utf8");
    expect(() => reopened.commit(reopened.prepare({
      operation: "edit",
      path: committed.memory.path,
      expectedVersion: committed.memory.version,
      edits: [{ type: "replace", oldText: "Figma", newText: "Penpot" }],
      reason: "Use current content"
    }), { runId: "run-3", toolCallId: "tool-3", writePolicy: "auto_apply" })).toThrow("Memory changed");
  });

  it("resets persisted Markdown files and the Revision ledger", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-memory-"));
    const revisionDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-revisions-"));
    temporaryDirectories.push(directory, revisionDirectory);
    const options = { rootDirectory: directory, revisionDirectory };
    const store = new FileMemoryStore(options);
    store.apply({ operation: "create", path: "memories/one.md", content: "One", reason: "Create one" });
    store.apply({ operation: "create", path: "memories/nested/two.md", content: "Two", reason: "Create two" });

    expect(store.reset()).toEqual({ deletedMemoryCount: 2, deletedRevisionCount: 2 });
    expect(store.list()).toEqual([]);
    expect(store.listRevisions()).toEqual([]);

    const reopened = new FileMemoryStore(options);
    expect(reopened.list()).toEqual([]);
    expect(reopened.listRevisions()).toEqual([]);
    expect(reopened.apply({ operation: "create", path: "memories/one.md", content: "Fresh", reason: "Recreate" }).version)
      .toMatch(/^1:/u);
  });

  it("rejects Memory paths whose parent is a symbolic link", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-memory-"));
    const outside = mkdtempSync(join(tmpdir(), "brainbuddy-outside-"));
    temporaryDirectories.push(directory, outside);
    symlinkSync(outside, join(directory, "escape"));
    const store = new FileMemoryStore({ rootDirectory: directory });

    expect(() => store.prepare({
      operation: "create",
      path: "memories/escape/leak.md",
      content: "must stay inside",
      reason: "Invalid path"
    })).toThrow("symbolic link");
  });
});
