import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3-multiple-ciphers";
import type { CipherDatabase } from "better-sqlite3-multiple-ciphers";
import { afterEach, describe, expect, it } from "vitest";
import type { ProtectionPlan } from "@brainbuddy/domain";
import { SqliteSourceStore } from "./sqlite-source-store";

const firstCredentialId = "550e8400-e29b-41d4-a716-446655440000";
const secondCredentialId = "b13e4a19-a239-4a6f-8b1b-7911f90f02a5";
const secret = "sk-secret-value-123456";

function plan(credentialId = firstCredentialId): ProtectionPlan {
  const ref = `[CREDENTIAL:${credentialId}]`;
  return {
    protectedContent: `Figma key 是 ${ref}`,
    credentialDrafts: [{
      credentialId,
      ref,
      start: 13,
      end: 35,
      entityType: "api_key",
      secret,
      maskedValue: "sk-••••••••••••56"
    }],
    safetyChecks: [{
      id: "protected_content_secret_free",
      label: "安全",
      passed: true,
      detail: "已通过"
    }]
  };
}

describe("SqliteSourceStore", () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  });

  it("persists encrypted sources from each submission channel with searchable credential links", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-source-store-"));
    directories.push(directory);
    const databasePath = join(directory, "lookingfor.sqlite");
    const sourceIds = ["SOURCE_00000000-0000-4000-8000-000000000001", "SOURCE_00000000-0000-4000-8000-000000000002"];
    const options = {
      databasePath,
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      sourceIdFactory: () => sourceIds.shift()!
    };
    const store = new SqliteSourceStore(options);
    expect(store.status()).toEqual({ passwordConfigured: false, unlocked: false });
    store.configure(undefined, "portable-password");

    const captureReceipt = store.save(plan(), `原始写入 ${secret}`, "capture");
    const conversationReceipt = store.save(plan(secondCredentialId), `原始对话 ${secret}`, "conversation");
    const result = store.searchOffline("550e8400");

    expect(captureReceipt.kind).toBe("capture");
    expect(conversationReceipt.kind).toBe("conversation");
    expect(conversationReceipt.credentialIds).toEqual([firstCredentialId]);
    expect(result.credentials[0]?.sourceIds).toEqual([captureReceipt.sourceId, conversationReceipt.sourceId]);
    expect(store.searchOffline("Figma").sources).toHaveLength(2);
    expect(store.searchOffline("Figma").credentials).toHaveLength(1);
    const beforeRepeatedSearch = store.searchOffline("");
    store.searchOffline("Figma");
    store.searchOffline("Figma");
    expect(store.searchOffline("")).toEqual(beforeRepeatedSearch);
    expect(store.revealSource(conversationReceipt.sourceId)).toMatchObject({
      kind: "conversation",
      originalContent: `原始对话 ${secret}`
    });
    expect(store.revealCredential(firstCredentialId)).toMatchObject({
      credentialId: firstCredentialId,
      entityType: "api_key",
      value: secret,
      sourceIds: [captureReceipt.sourceId, conversationReceipt.sourceId]
    });
    store.close();

    expect(() => {
      const database = new DatabaseSync(databasePath);
      try { database.prepare("SELECT * FROM sources").all(); } finally { database.close(); }
    }).toThrow();
    const external = openExternalDatabase(databasePath, "portable-password");
    expect(external.prepare("SELECT original_content FROM sources WHERE source_id = ?").get(captureReceipt.sourceId))
      .toEqual({ original_content: `原始写入 ${secret}` });
    expect(external.prepare("SELECT secret FROM credentials WHERE credential_id = ?").get(firstCredentialId))
      .toEqual({ secret });
    expect(external.pragma("user_version", { simple: true })).toBe(1);
    external.close();
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);

    const reopened = new SqliteSourceStore({ ...options, sourceIdFactory: () => sourceIds.shift()! });
    expect(reopened.status()).toEqual({ passwordConfigured: true, unlocked: false });
    expect(() => reopened.unlock("wrong-password")).toThrow("DATABASE_PASSWORD_INVALID");
    reopened.unlock("portable-password");
    expect(reopened.searchOffline("Figma").sources).toHaveLength(2);
    expect(reopened.searchOffline(firstCredentialId).credentials).toHaveLength(1);
    reopened.close();
  });

  it("finds a Source and its Credential by text retained only in encrypted original content", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-source-original-search-"));
    directories.push(directory);
    const store = new SqliteSourceStore({ databasePath: join(directory, "lookingfor.sqlite") });
    store.configure(undefined, "original-search-password");
    const receipt = store.save(plan(), `token.koolcenter.com\n保密信息：${secret}\n备注：6yong`, "capture");

    const result = store.searchOffline("token");

    expect(result.sources.map(({ sourceId }) => sourceId)).toContain(receipt.sourceId);
    expect(result.credentials.map(({ credentialId }) => credentialId)).toContain(firstCredentialId);
    store.close();
  });

  it("links an existing Credential Reference and rejects unknown references", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-source-reference-"));
    directories.push(directory);
    const sourceIds = ["SOURCE_FIRST", "SOURCE_REFERENCE", "SOURCE_UNKNOWN"];
    const store = new SqliteSourceStore({
      databasePath: join(directory, "lookingfor.sqlite"),
      sourceIdFactory: () => sourceIds.shift()!
    });
    store.configure(undefined, "reference-password");
    const first = store.save(plan(), "原始凭据");
    const referencePlan: ProtectionPlan = {
      protectedContent: `密码是 [CREDENTIAL:${firstCredentialId}]`,
      credentialDrafts: [],
      safetyChecks: plan().safetyChecks
    };

    const referenced = store.save(referencePlan, referencePlan.protectedContent, "conversation");
    expect(referenced.credentialIds).toEqual([firstCredentialId]);
    expect(store.searchOffline(firstCredentialId).credentials[0]?.sourceIds).toEqual([
      first.sourceId,
      referenced.sourceId
    ]);
    expect(() => store.save({
      ...referencePlan,
      protectedContent: "密码是 [CREDENTIAL:00e5dcad-aad5-4fe2-a520-3ca35e0d03a8]"
    }, "未知引用")).toThrow("Credential reference does not exist");
    store.close();
  });

  it("rekeys the portable database and invalidates the previous password", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-source-rekey-"));
    directories.push(directory);
    const databasePath = join(directory, "lookingfor.sqlite");
    const store = new SqliteSourceStore({ databasePath });
    store.configure(undefined, "first-password");
    store.save(plan(), "重新加密前的原文");

    expect(() => store.configure("wrong-password", "second-password")).toThrow("DATABASE_PASSWORD_INVALID");
    expect(store.status()).toEqual({ passwordConfigured: true, unlocked: true });
    expect(store.searchOffline("").sources).toHaveLength(1);
    expect(store.configure("first-password", "second-password")).toEqual({ passwordConfigured: true, unlocked: true });
    store.lock();
    expect(() => store.unlock("first-password")).toThrow("DATABASE_PASSWORD_INVALID");
    expect(store.unlock("second-password")).toEqual({ passwordConfigured: true, unlocked: true });
    expect(store.searchOffline("").sources).toHaveLength(1);
    store.close();
  });

  it("atomically resets source, credential, and link records", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-source-reset-"));
    directories.push(directory);
    const store = new SqliteSourceStore({
      databasePath: join(directory, "lookingfor.sqlite"),
      sourceIdFactory: () => "SOURCE_RESET"
    });
    store.configure(undefined, "reset-password");
    const receipt = store.save(plan(), "应被清除的原文");

    expect(store.reset()).toEqual({ deletedSourceCount: 1, deletedCredentialCount: 1 });
    expect(store.searchOffline("")).toEqual({ sources: [], credentials: [] });
    expect(store.hasSource(receipt.sourceId)).toBe(false);
    expect(store.hasCredential(firstCredentialId)).toBe(false);
    expect(() => store.revealSource(receipt.sourceId)).toThrow("Source record not found");
    store.close();
  });
});

function openExternalDatabase(path: string, password: string): CipherDatabase {
  const database = new Database(path, { fileMustExist: true });
  database.pragma("cipher='sqlcipher'");
  database.pragma("legacy=4");
  database.pragma(`key='${password.replaceAll("'", "''")}'`);
  database.prepare("SELECT count(*) FROM sqlite_schema").get();
  return database;
}
