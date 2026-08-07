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
  readonly credentialIds: readonly string[];
  readonly savedAt: string;
  readonly storage: "memory_session";
  readonly preview: ProtectionPreview;
}

export interface DemoSourceSummary {
  readonly sourceId: string;
  readonly protectedContent: string;
  readonly credentialIds: readonly string[];
  readonly savedAt: string;
}

export interface DemoSourceReveal {
  readonly sourceId: string;
  readonly originalContent: string;
  readonly savedAt: string;
}

export interface MemoryFile {
  readonly path: string;
  readonly content: string;
  readonly sourceIds: readonly string[];
  readonly credentialIds: readonly string[];
  readonly updatedAt: string;
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
