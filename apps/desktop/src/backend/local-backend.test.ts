import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
    const first = createBackend(dataDirectory);
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

    const reopened = createBackend(dataDirectory);
    expect(reopened.access.status()).toEqual({ passwordConfigured: true, unlocked: false });
    expect(reopened.search("Figma").sources.map(({ sourceId }) => sourceId)).toContain(receipt.sourceId);
    expect(reopened.memories.list().map(({ path }) => path)).toEqual(["memories/figma.md"]);
    expect(() => reopened.reveal(receipt.sourceId)).toThrow("DATABASE_LOCKED");
    expect(() => reopened.revealCredential(receipt.credentialIds[0]!)).toThrow("DATABASE_LOCKED");
    reopened.access.unlock("persistent-password");
    expect(reopened.reveal(receipt.sourceId).originalContent).toBe(original);
    expect(reopened.revealCredential(receipt.credentialIds[0]!).value).toBe("sk-local-backend-secret-123456");
    reopened.close();
  });

  it("imports, encrypts and persists the model connection behind a safe status", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-local-backend-"));
    directories.push(dataDirectory);
    const importedKey = "sk-imported-deepseek-key-123456";
    const replacementKey = "sk-replacement-deepseek-key-654321";
    const first = createBackend(dataDirectory, {
      apiKey: importedKey,
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-v4-flash"
    });

    expect(first.modelConnectionStatus()).toEqual({
      provider: "deepseek",
      configured: true,
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-v4-flash",
      maskedApiKey: "sk-••••3456"
    });
    expect(first.requireModelConnection()).toEqual({ apiKey: importedKey, baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash" });
    first.configureModelConnection(replacementKey, "https://proxy.example.com/v1", "custom-model");
    first.close();

    const metadataPath = join(dataDirectory, "model-connection.json");
    const stored = readFileSync(metadataPath, "utf8");
    expect(stored).not.toContain(importedKey);
    expect(stored).not.toContain(replacementKey);
    expect(statSync(metadataPath).mode & 0o777).toBe(0o600);

    const reopened = createBackend(dataDirectory, {
      apiKey: importedKey,
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-v4-flash"
    });
    expect(reopened.requireModelConnection()).toEqual({ apiKey: replacementKey, baseUrl: "https://proxy.example.com/v1", modelId: "custom-model" });
    reopened.close();
  });

  it("uses the reviewed Credential ID when saving a protected conversation", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-local-backend-"));
    directories.push(dataDirectory);
    const backend = createBackend(dataDirectory);
    const original = "记录一下 agentflow 的密码是 77778888";
    const secret = "77778888";
    const start = original.indexOf(secret);
    const credentialId = "00e5dcad-aad5-4fe2-a520-3ca35e0d03a8";

    const receipt = backend.save(original, [{
      start,
      end: start + secret.length,
      policy: "move_to_vault",
      credentialId
    }], "conversation");

    expect(receipt.preview.protectedContent).toContain(
      `记录一下 agentflow 的密码是 [CREDENTIAL:${credentialId}]`
    );
    expect(receipt.preview.protectedContent).toContain(`来源：[SOURCE:${receipt.sourceId}]`);
    expect(receipt.preview.credentials).toEqual([
      expect.objectContaining({ credentialId, maskedValue: "777•••88" })
    ]);
    backend.close();
  });
});

function createBackend(dataDirectory: string, initialModelConnection?: {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
}): LocalBackend {
  return new LocalBackend({
    applicationDataDirectory: dataDirectory,
    databaseDirectory: dataDirectory,
    memoryDirectory: join(dataDirectory, "memories"),
    ...(initialModelConnection ? { initialModelConnection } : {})
  });
}
