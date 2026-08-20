import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    const databasePath = join(directory, "brainbuddy.sqlite");
    const sourceIds = ["SOURCE_00000000-0000-4000-8000-000000000001", "SOURCE_00000000-0000-4000-8000-000000000002"];
    const options = {
      databasePath,
      encryptionKey: Buffer.alloc(32, 7),
      now: () => new Date("2026-08-07T00:00:00.000Z"),
      sourceIdFactory: () => sourceIds.shift()!
    };
    const store = new SqliteSourceStore(options);

    const captureReceipt = store.save(plan(), `原始写入 ${secret}`, "capture");
    const conversationReceipt = store.save(plan(secondCredentialId), `原始对话 ${secret}`, "conversation");
    const result = store.searchOffline("550e8400");

    expect(captureReceipt.kind).toBe("capture");
    expect(conversationReceipt.kind).toBe("conversation");
    expect(conversationReceipt.credentialIds).toEqual([firstCredentialId]);
    expect(result.credentials[0]?.sourceIds).toEqual([captureReceipt.sourceId, conversationReceipt.sourceId]);
    expect(store.searchOffline("Figma").sources).toHaveLength(2);
    expect(store.searchOffline("Figma").credentials).toHaveLength(1);
    expect(store.revealSource(conversationReceipt.sourceId)).toMatchObject({
      kind: "conversation",
      originalContent: `原始对话 ${secret}`
    });
    store.close();

    const database = new DatabaseSync(databasePath);
    expect(JSON.stringify(database.prepare("SELECT * FROM sources").all())).not.toContain(secret);
    expect(JSON.stringify(database.prepare("SELECT * FROM credentials").all())).not.toContain(secret);
    database.close();

    const reopened = new SqliteSourceStore({ ...options, sourceIdFactory: () => sourceIds.shift()! });
    expect(reopened.searchOffline("Figma").sources).toHaveLength(2);
    expect(reopened.searchOffline(firstCredentialId).credentials).toHaveLength(1);
    reopened.close();
  });

  it("links an existing Credential Reference and rejects unknown references", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-source-reference-"));
    directories.push(directory);
    const sourceIds = ["SOURCE_FIRST", "SOURCE_REFERENCE", "SOURCE_UNKNOWN"];
    const store = new SqliteSourceStore({
      databasePath: join(directory, "brainbuddy.sqlite"),
      encryptionKey: Buffer.alloc(32, 7),
      sourceIdFactory: () => sourceIds.shift()!
    });
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

  it("migrates legacy write and query source kinds to submission channels", () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-source-migration-"));
    directories.push(directory);
    const databasePath = join(directory, "brainbuddy.sqlite");
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE sources (
        source_id TEXT PRIMARY KEY,
        submission_kind TEXT NOT NULL CHECK (submission_kind IN ('write', 'query')),
        protected_content TEXT NOT NULL,
        original_ciphertext TEXT NOT NULL,
        original_iv TEXT NOT NULL,
        original_tag TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE credentials (
        credential_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        masked_value TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        secret_ciphertext TEXT NOT NULL,
        secret_iv TEXT NOT NULL,
        secret_tag TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE credential_sources (
        credential_id TEXT NOT NULL REFERENCES credentials(credential_id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        PRIMARY KEY (credential_id, source_id)
      );
      INSERT INTO sources VALUES
        ('SOURCE_OLD_WRITE', 'write', '旧写入', '', '', '', '2026-08-07T00:00:00.000Z'),
        ('SOURCE_OLD_QUERY', 'query', '旧查询', '', '', '', '2026-08-07T00:01:00.000Z');
    `);
    database.close();

    const store = new SqliteSourceStore({ databasePath, encryptionKey: Buffer.alloc(32, 7) });
    expect(store.searchOffline("").sources.map(({ kind }) => kind)).toEqual(["local_search", "capture"]);
    store.close();
  });
});
