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
  | "replace_with_token"
  | "original_only"
  | "move_to_vault";

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
  readonly protectedPreview: string;
  readonly analyzedAt: string;
}

export interface Memory {
  readonly id: string;
  readonly originalContent: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly status: "active" | "deleted";
}

export interface ProtectedMemory {
  readonly id: string;
  readonly sourceMemoryId: string;
  readonly protectedContent: string;
  readonly privacyRuleVersion: string;
  readonly generatedAt: string;
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
