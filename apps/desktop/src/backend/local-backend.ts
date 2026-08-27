import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProtectedRecordReader } from "@brainbuddy/agent-runtime";
import type {
  DatabaseResetResult,
  DemoOfflineSearchResult,
  DemoSaveReceipt,
  DemoSourceReveal,
  ModelConnectionStatus,
  ProtectionDecision,
  ProtectionPreview,
  SourceSubmissionKind
} from "@brainbuddy/domain";
import { DatabaseAccessGate } from "@brainbuddy/memory-engine/access";
import { FileMemoryStore, type MemoryStore } from "@brainbuddy/memory-engine/memory";
import { SqliteSourceStore } from "@brainbuddy/memory-engine/sqlite";
import { buildProtectionPlan, PrivacyEngine, toProtectionPreview } from "@brainbuddy/privacy-engine";
import { ModelConnectionStore, type ModelConnection } from "./model-connection-store";

export class LocalBackend {
  readonly memories: MemoryStore;
  readonly access: DatabaseAccessGate;
  readonly records: ProtectedRecordReader;
  readonly #privacy = new PrivacyEngine({
    knownEntities: [{
      id: "demo-person-zhang-wei",
      canonicalName: "张伟",
      entityType: "person",
      token: "[PERSON_A]",
      aliases: [],
      defaultPolicy: "keep_original"
    }]
  });
  readonly #sources: SqliteSourceStore;
  readonly #modelConnection: ModelConnectionStore;

  constructor(options: {
    readonly applicationDataDirectory: string;
    readonly databaseDirectory: string;
    readonly memoryDirectory: string;
    readonly initialModelConnection?: ModelConnection;
  }) {
    mkdirSync(options.applicationDataDirectory, { recursive: true });
    mkdirSync(options.databaseDirectory, { recursive: true });
    mkdirSync(options.memoryDirectory, { recursive: true });
    const encryptionKey = loadEncryptionKey(options.applicationDataDirectory);
    this.#sources = new SqliteSourceStore({
      databasePath: join(options.databaseDirectory, "brainbuddy.sqlite"),
      encryptionKey
    });
    this.#modelConnection = new ModelConnectionStore({
      metadataPath: join(options.applicationDataDirectory, "model-connection.json"),
      encryptionKey,
      ...(options.initialModelConnection ? { initialConnection: options.initialModelConnection } : {})
    });
    this.memories = new FileMemoryStore({ rootDirectory: options.memoryDirectory });
    this.access = new DatabaseAccessGate({ metadataPath: join(options.applicationDataDirectory, "database-access.json") });
    this.records = {
      search: (query, limit) => {
        const result = this.#sources.searchOffline(query);
        const sources = result.sources.slice(0, limit);
        const credentials = result.credentials.slice(0, limit);
        return {
          sources,
          credentials,
          total: result.sources.length + result.credentials.length,
          truncated: sources.length < result.sources.length || credentials.length < result.credentials.length
        };
      },
      sourceExists: (sourceId) => this.#sources.hasSource(sourceId),
      credentialExists: (credentialId) => this.#sources.hasCredential(credentialId)
    };
  }

  analyze(text: string) {
    return this.#privacy.analyze(text);
  }

  preview(text: string, decisions: readonly ProtectionDecision[]): ProtectionPreview {
    return toProtectionPreview(this.#plan(text, decisions));
  }

  save(text: string, decisions: readonly ProtectionDecision[], kind: SourceSubmissionKind = "capture"): DemoSaveReceipt {
    return this.#sources.save(this.#plan(text, decisions), text, kind);
  }

  saveSuggested(text: string, kind: SourceSubmissionKind = "conversation"): DemoSaveReceipt {
    const analysis = this.#privacy.analyze(text);
    return this.save(text, analysis.entities.map(({ start, end, suggestedPolicy: policy }) => ({ start, end, policy })), kind);
  }

  search(query: string, excludeSourceId?: string): DemoOfflineSearchResult {
    return this.#sources.searchOffline(query, excludeSourceId);
  }

  reveal(sourceId: string): DemoSourceReveal {
    this.access.assertUnlocked();
    return this.#sources.revealSource(sourceId);
  }

  resetDatabase(): DatabaseResetResult {
    this.access.assertUnlocked();
    return this.#sources.reset();
  }

  modelConnectionStatus(): ModelConnectionStatus {
    return this.#modelConnection.status();
  }

  configureModelConnection(apiKey: string, baseUrl: string, modelId?: string): ModelConnectionStatus {
    return this.#modelConnection.configure(apiKey, baseUrl, modelId);
  }

  requireModelConnection(): ModelConnection {
    return this.#modelConnection.requireConnection();
  }

  close(): void {
    this.#sources.close();
  }

  #plan(text: string, decisions: readonly ProtectionDecision[]) {
    const analysis = this.#privacy.analyze(text);
    return buildProtectionPlan({ text, entities: analysis.entities, decisions, credentialIdFactory: randomUUID });
  }
}

function loadEncryptionKey(dataDirectory: string): Buffer {
  const keyPath = join(dataDirectory, "brainbuddy.key");
  try {
    const key = readFileSync(keyPath);
    if (key.byteLength !== 32) throw new Error("Stored BrainBuddy key is invalid");
    chmodSync(keyPath, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
    return key;
  }
}
