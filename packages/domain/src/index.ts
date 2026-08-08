export type EntityType =
  | "password"
  | "api_key"
  | "email"
  | "private_key"
  | "github_token"
  | "jwt"
  | "high_entropy_secret"
  | "person"
  | "company"
  | "project";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type ProtectionPolicy =
  | "keep_original"
  | "move_to_vault";

export type SourceSubmissionKind = "capture" | "local_search" | "conversation";

export interface DetectedEntity {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly type: EntityType;
  readonly risk: RiskLevel;
  readonly reason: readonly string[];
  readonly suggestedPolicy: ProtectionPolicy;
  readonly recognizerId: string;
  readonly replacementToken?: string;
}

export interface PrivacyAnalysis {
  readonly inputLength: number;
  readonly entities: readonly DetectedEntity[];
  readonly analyzedAt: string;
}

export interface ProtectionDecision {
  readonly start: number;
  readonly end: number;
  readonly policy: ProtectionPolicy;
  readonly credentialId?: string | undefined;
}

export interface CredentialDraft {
  readonly credentialId: string;
  readonly ref: string;
  readonly start: number;
  readonly end: number;
  readonly entityType: EntityType;
  readonly secret: string;
  readonly maskedValue: string;
}

export interface SafetyCheck {
  readonly id: "protected_content_secret_free" | "credential_refs_resolved";
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}

export interface ProtectionPlan {
  readonly protectedContent: string;
  readonly credentialDrafts: readonly CredentialDraft[];
  readonly safetyChecks: readonly SafetyCheck[];
}

export interface CredentialPreview {
  readonly credentialId: string;
  readonly ref: string;
  readonly start: number;
  readonly end: number;
  readonly entityType: EntityType;
  readonly maskedValue: string;
}

export interface ProtectionPreview {
  readonly protectedContent: string;
  readonly credentials: readonly CredentialPreview[];
  readonly safetyChecks: readonly SafetyCheck[];
  readonly readyToSave: boolean;
}

export interface DemoSaveReceipt {
  readonly sourceId: string;
  readonly kind: SourceSubmissionKind;
  readonly credentialIds: readonly string[];
  readonly savedAt: string;
  readonly storage: "memory_session" | "sqlite";
  readonly preview: ProtectionPreview;
}

export interface DemoSourceSummary {
  readonly sourceId: string;
  readonly kind: SourceSubmissionKind;
  readonly protectedContent: string;
  readonly credentialIds: readonly string[];
  readonly savedAt: string;
}

export interface DemoSourceReveal {
  readonly sourceId: string;
  readonly kind: SourceSubmissionKind;
  readonly originalContent: string;
  readonly savedAt: string;
}

export interface DemoCredentialSummary {
  readonly credentialId: string;
  readonly entityType: EntityType;
  readonly maskedValue: string;
  readonly sourceIds: readonly string[];
  readonly savedAt: string;
}

export interface DemoOfflineSearchResult {
  readonly sources: readonly DemoSourceSummary[];
  readonly credentials: readonly DemoCredentialSummary[];
}

export interface DemoQueryResult extends DemoOfflineSearchResult {
  readonly receipt: DemoSaveReceipt;
}

export type AiActionIntent =
  | {
      readonly kind: "tool_call";
      readonly toolName: string;
      readonly arguments: Readonly<Record<string, unknown>>;
      readonly reason: string;
    }
  | {
      readonly kind: "file_read";
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly kind: "file_write";
      readonly path: string;
      readonly contentSummary: string;
      readonly reason: string;
    }
  | {
      readonly kind: "memory_create" | "memory_update";
      readonly target?: string | undefined;
      readonly contentSummary: string;
      readonly reason: string;
    };

export interface AiConversationInput {
  readonly message: string;
  readonly conversationSource: DemoSourceSummary;
  readonly sources: readonly DemoSourceSummary[];
  readonly credentials: readonly DemoCredentialSummary[];
  readonly memories: readonly MemoryFile[];
}

export interface AiConversationDraft {
  readonly draftId: string;
  readonly provider: "deepseek";
  readonly model: string;
  readonly createdAt: string;
  readonly conversationSourceId: string;
  readonly candidateIds: readonly string[];
  readonly memories: readonly MemoryFile[];
  readonly context: Readonly<Record<string, unknown>>;
}

export type MemoryOperation =
  | {
      readonly operation: "create";
      readonly path: string;
      readonly content: string;
      readonly reason: string;
    }
  | {
      readonly operation: "update";
      readonly path: string;
      readonly expectedVersion: string;
      readonly content: string;
      readonly reason: string;
    };

export interface AiConversationResponse {
  readonly message: string;
  readonly references: readonly {
    readonly kind: "source" | "credential" | "memory";
    readonly id: string;
  }[];
  readonly memoryOperations: readonly MemoryOperation[];
  readonly otherIntents: readonly AiActionIntent[];
}

export type AiConversationEvent =
  | { readonly type: "started"; readonly at: string }
  | { readonly type: "provider_payload"; readonly at: string; readonly payload: unknown }
  | { readonly type: "text_delta"; readonly at: string; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly at: string; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "tool_call"; readonly at: string; readonly contentIndex: number; readonly toolCall: Readonly<Record<string, unknown>> }
  | {
      readonly type: "completed";
      readonly at: string;
      readonly stopReason: string;
      readonly rawMessage: Readonly<Record<string, unknown>>;
      readonly response?: AiConversationResponse | undefined;
      readonly validationError?: string | undefined;
    }
  | {
      readonly type: "failed";
      readonly at: string;
      readonly reason: "error" | "aborted";
      readonly message: string;
      readonly rawMessage?: Readonly<Record<string, unknown>> | undefined;
    };

export interface MemoryFile {
  readonly path: string;
  readonly content: string;
  readonly sourceIds: readonly string[];
  readonly credentialIds: readonly string[];
  readonly updatedAt: string;
  readonly version: string;
}

export interface EntityMapping {
  readonly id: string;
  readonly canonicalName: string;
  readonly entityType: Extract<EntityType, "person" | "company" | "project">;
  readonly token: string;
  readonly aliases: readonly string[];
  readonly defaultPolicy: ProtectionPolicy;
}

export interface CredentialMetadata {
  readonly id: string;
  readonly service: string;
  readonly accountHint?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Credential {
  readonly id: string;
  readonly service: string;
  readonly accountHint?: string;
  readonly encryptedSecret: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgentRequest {
  readonly query: string;
  readonly allowedCandidateIds: readonly string[];
}

export interface AgentEvent {
  readonly type: "started" | "tool_call" | "text_delta" | "completed" | "failed";
  readonly safePayload: Readonly<Record<string, unknown>>;
}

export interface AuditEvent {
  readonly id: string;
  readonly eventType: string;
  readonly safePayload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}
