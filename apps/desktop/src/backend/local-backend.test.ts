import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalBackend } from "./local-backend";

describe("LocalBackend", () => {
  const directories: string[] = [];

  afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

  it("persists the same encrypted records, Memory files and access gate used by Electron", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-local-backend-"));
    directories.push(dataDirectory);
    const original = "Figma key 是 sk-local-backend-secret-123456";
    const first = new LocalBackend({ dataDirectory });
    const analysis = first.analyze(original);
    const receipt = first.save(original, analysis.entities.map(({ start, end, suggestedPolicy: policy }) => ({ start, end, policy })));
    first.memories.apply({
      operation: "create",
      path: "memories/figma.md",
      content: `Figma 凭据 ${receipt.preview.credentials[0]?.ref}\n\n来源：[SOURCE:${receipt.sourceId}]`,
      reason: "integration test"
    });
    first.access.configure(undefined, "persistent-password");
    first.close();

    const reopened = new LocalBackend({ dataDirectory });
    expect(reopened.access.status()).toEqual({ passwordConfigured: true, unlocked: false });
    expect(reopened.search("Figma").sources.map(({ sourceId }) => sourceId)).toContain(receipt.sourceId);
    expect(reopened.memories.list().map(({ path }) => path)).toEqual(["memories/figma.md"]);
    expect(() => reopened.reveal(receipt.sourceId)).toThrow("DATABASE_LOCKED");
    reopened.access.unlock("persistent-password");
    expect(reopened.reveal(receipt.sourceId).originalContent).toBe(original);
    reopened.close();
  });
});
