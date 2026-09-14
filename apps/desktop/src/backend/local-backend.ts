import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProtectedRecordReader } from "@brainbuddy/agent-runtime";
import type {
  DatabaseResetResult,
  DemoCredentialReveal,
  DemoOfflineSearchResult,
  DemoSaveReceipt,
  DemoSourceReveal,
  DetectedEntity,
  ModelConnectionStatus,
  ProtectionDecision,
  ProtectionPreview,
  SourceSubmissionKind
} from "@brainbuddy/domain";
import { FileMemoryStore, type MemoryStore } from "@brainbuddy/memory-engine/memory";
import { SqliteSourceStore } from "@brainbuddy/memory-engine/sqlite";
import { buildProtectionPlan, PrivacyEngine, toProtectionPreview } from "@brainbuddy/privacy-engine";
import { ModelConnectionStore, type ModelConnection } from "./model-connection-store";
import { ManualCaptureMemoryProjector } from "./manual-capture-memory-projector";

export class LocalBackend {
  readonly memories: MemoryStore;
  readonly access: Pick<SqliteSourceStore, "status" | "configure" | "unlock" | "lock" | "assertUnlocked">;
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
  readonly #manualCaptureMemories: ManualCaptureMemoryProjector;

  constructor(options: {
    readonly applicationDataDirectory: string;
    readonly databaseDirectory: string;
    readonly memoryDirectory: string;
    readonly initialModelConnection?: ModelConnection;
  }) {
    mkdirSync(options.applicationDataDirectory, { recursive: true });
    mkdirSync(options.databaseDirectory, { recursive: true });
    mkdirSync(options.memoryDirectory, { recursive: true });
    this.#sources = new SqliteSourceStore({
      databasePath: join(options.databaseDirectory, "lookingfor.sqlite")
    });
    this.#modelConnection = new ModelConnectionStore({
      settings: {
        read: () => this.#sources.getSetting("model.connection"),
        write: (value) => this.#sources.setSetting("model.connection", value)
      },
      ...(options.initialModelConnection ? { initialConnection: options.initialModelConnection } : {})
    });
    this.memories = new FileMemoryStore({ rootDirectory: options.memoryDirectory });
    this.#manualCaptureMemories = new ManualCaptureMemoryProjector(this.memories);
    this.access = this.#sources;
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

  preview(text: string, decisions: readonly ProtectionDecision[], manual: readonly ManualSegmentRange[] = []): ProtectionPreview {
    return toProtectionPreview(this.#plan(text, decisions, manual));
  }

  save(text: string, decisions: readonly ProtectionDecision[], kind: SourceSubmissionKind = "capture", manual: readonly ManualSegmentRange[] = []): DemoSaveReceipt {
    const receipt = this.#sources.save(this.#plan(text, decisions, manual), text, kind);
    if (kind === "capture") this.#manualCaptureMemories.project(receipt);
    return receipt;
  }

  saveSuggested(text: string, kind: SourceSubmissionKind = "conversation"): DemoSaveReceipt {
    const analysis = this.#privacy.analyze(text);
    return this.save(text, analysis.entities.map(({ start, end, suggestedPolicy: policy }) => ({ start, end, policy })), kind);
  }

  search(query: string, excludeSourceId?: string): DemoOfflineSearchResult {
    return this.#sources.searchOffline(query, excludeSourceId);
  }

  reveal(sourceId: string): DemoSourceReveal {
    return this.#sources.revealSource(sourceId);
  }

  revealCredential(credentialId: string): DemoCredentialReveal {
    return this.#sources.revealCredential(credentialId);
  }

  resetDatabase(): DatabaseResetResult {
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

  #plan(text: string, decisions: readonly ProtectionDecision[], manual: readonly ManualSegmentRange[] = []) {
    const analysis = this.#privacy.analyze(text);
    const entities = mergeManualEntities(text, analysis.entities, manual);
    return buildProtectionPlan({ text, entities, decisions, credentialIdFactory: randomUUID });
  }
}

export interface ManualSegmentRange {
  readonly start: number;
  readonly end: number;
  readonly entityType: DetectedEntity["type"];
  readonly note?: string | undefined;
}

function mergeManualEntities(text: string, detected: readonly DetectedEntity[], manual: readonly ManualSegmentRange[]): readonly DetectedEntity[] {
  if (!manual.length) return detected;
  const sorted = [...manual].sort((left, right) => left.start - right.start);
  sorted.forEach(({ start, end }, index) => {
    if (end <= start || end > text.length) throw new Error("Manual protection range is invalid");
    const previous = sorted[index - 1];
    if (previous && previous.end > start) throw new Error("Manual protection ranges cannot overlap");
  });
  const manualEntities: DetectedEntity[] = sorted
    .map(({ start, end, entityType, note }) => ({
      text: text.slice(start, end),
      start,
      end,
      type: entityType,
      risk: "high" as const,
      reason: note ? ["用户手动划词选择加密", note] : ["用户手动划词选择加密"],
      suggestedPolicy: "move_to_vault" as const,
      recognizerId: "manual-selection",
      ...(note ? { note } : {})
    }));
  const resolvedDetected = detected.filter((entity) => !manualEntities.some((manualEntity) => rangesOverlap(entity.start, entity.end, manualEntity.start, manualEntity.end)));
  return [...resolvedDetected, ...manualEntities].sort((left, right) => left.start - right.start);
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}
