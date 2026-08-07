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

  it("persists encrypted write and query sources with searchable credential links", () => {
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

    const writeReceipt = store.save(plan(), `原始写入 ${secret}`, "write");
    const queryReceipt = store.save(plan(secondCredentialId), `原始查询 ${secret}`, "query");
    const result = store.searchOffline("550e8400");

    expect(writeReceipt.kind).toBe("write");
    expect(queryReceipt.kind).toBe("query");
    expect(queryReceipt.credentialIds).toEqual([firstCredentialId]);
    expect(result.credentials[0]?.sourceIds).toEqual([writeReceipt.sourceId, queryReceipt.sourceId]);
    expect(store.searchOffline("Figma").sources).toHaveLength(2);
    expect(store.searchOffline("Figma").credentials).toHaveLength(1);
    expect(store.revealSource(queryReceipt.sourceId)).toMatchObject({
      kind: "query",
      originalContent: `原始查询 ${secret}`
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
});
