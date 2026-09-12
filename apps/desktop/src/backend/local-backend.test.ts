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
    const apiCredential = receipt.preview.credentials.find(({ entityType }) => entityType === "api_key")!;
    const projectedMemory = first.memories.list()[0]!;
    expect(projectedMemory.path).toContain("memories/manual-captures/");
    expect(projectedMemory.content).toContain(apiCredential.ref);
    expect(projectedMemory.content).not.toContain("sk-local-backend-secret-123456");
    first.access.configure(undefined, "persistent-password");
    first.close();

    const reopened = createBackend(dataDirectory);
    expect(reopened.access.status()).toEqual({ passwordConfigured: true, unlocked: false });
    expect(reopened.search(receipt.sourceId).sources.map(({ sourceId }) => sourceId)).toContain(receipt.sourceId);
    expect(reopened.memories.list().map(({ path }) => path)).toEqual([projectedMemory.path]);
    expect(() => reopened.reveal(receipt.sourceId)).toThrow("DATABASE_LOCKED");
    expect(() => reopened.revealCredential(apiCredential.credentialId)).toThrow("DATABASE_LOCKED");
    reopened.access.unlock("persistent-password");
    expect(reopened.reveal(receipt.sourceId).originalContent).toBe(original);
    expect(reopened.revealCredential(apiCredential.credentialId).value).toBe("sk-local-backend-secret-123456");
    reopened.close();
  });

  it("extracts a mixed-character secret following an account email", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-local-backend-"));
    directories.push(dataDirectory);
    const backend = createBackend(dataDirectory);
    const secret = "demopass2025@";
    const original = `figma 账号： admin@example.com  ${secret}`;

    const receipt = backend.saveSuggested(original);

    expect(receipt.preview.protectedContent).toContain("figma");
    expect(receipt.preview.protectedContent).not.toContain("admin@example.com");
    expect(receipt.preview.protectedContent).not.toContain(secret);
    expect(receipt.preview.credentials.map(({ entityType }) => entityType)).toEqual([
      "email",
      "high_entropy_secret"
    ]);
    expect(receipt.credentialIds.map((credentialId) => backend.revealCredential(credentialId).value)).toEqual([
      "admin@example.com",
      secret
    ]);
    expect(backend.memories.list()).toEqual([]);
    backend.close();
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
    const original = "记录一下服务的密码是 77778888";
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
      `记录一下服务的密码是 [CREDENTIAL:${credentialId}]`
    );
    expect(receipt.preview.protectedContent).toContain(`来源：[SOURCE:${receipt.sourceId}]`);
    expect(receipt.preview.credentials).toEqual([
      expect.objectContaining({ credentialId, maskedValue: "777•••88" })
    ]);
    backend.close();
  });

  it("uses an explicit manual range even when a short secret is not auto-detected", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-local-backend-"));
    directories.push(dataDirectory);
    const backend = createBackend(dataDirectory);
    const original = "路由器\n保密信息：123456\n备注：书房";
    const secret = "123456";
    const start = original.indexOf(secret);

    const receipt = backend.save(original, [{
      start,
      end: start + secret.length,
      policy: "move_to_vault"
    }], "capture", [{
      start,
      end: start + secret.length,
      entityType: "custom"
    }]);

    expect(receipt.preview.protectedContent).not.toContain(secret);
    expect(receipt.preview.credentials).toEqual([
      expect.objectContaining({ entityType: "custom", maskedValue: "••••••" })
    ]);
    const projectedMemory = backend.memories.list()[0]!;
    expect(projectedMemory.content).toContain(receipt.sourceId);
    expect(projectedMemory.content).toContain(receipt.credentialIds[0]!);
    expect(projectedMemory.content).not.toContain(secret);
    backend.close();
  });

  it("lets a manual protection override an automatic detection with user metadata", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-local-backend-"));
    directories.push(dataDirectory);
    const backend = createBackend(dataDirectory);
    const original = "密码是 77778888";
    const secret = "77778888";
    const start = original.indexOf(secret);

    const preview = backend.preview(original, [{
      start,
      end: start + secret.length,
      policy: "move_to_vault"
    }], [{
      start,
      end: start + secret.length,
      entityType: "api_key",
      note: "家庭服务器"
    }]);

    expect(preview.credentials[0]?.entityType).toBe("api_key");
    expect(preview.protectedContent).toContain("备注：家庭服务器");
    expect(preview.protectedContent).not.toContain(secret);
    backend.close();
  });

  it("rejects overlapping manual protection ranges", () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), "brainbuddy-local-backend-"));
    directories.push(dataDirectory);
    const backend = createBackend(dataDirectory);

    expect(() => backend.preview("abcdefgh", [], [
      { start: 0, end: 4, entityType: "custom" },
      { start: 3, end: 6, entityType: "custom" }
    ])).toThrow("Manual protection ranges cannot overlap");
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
