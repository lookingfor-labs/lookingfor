import { z } from "zod";
import type {
  DemoSaveReceipt,
  DemoOfflineSearchResult,
  AiConversationDraft,
  AiConversationEvent,
  DemoSourceReveal,
  PrivacyAnalysis,
  ProtectionPreview,
  MemoryFile,
  MemoryRevertResult
} from "@brainbuddy/domain";
import type {
  AgentRunDraft,
  AgentRuntimeEvent,
  ApprovalResolution
} from "@brainbuddy/agent-runtime";

export const ANALYZE_INPUT_CHANNEL = "privacy:analyze-input";
export const PREVIEW_PROTECTION_CHANNEL = "privacy:preview-protection";
export const SAVE_DEMO_CANDIDATE_CHANNEL = "memory:save-demo-candidate";
export const SEARCH_DEMO_SOURCES_CHANNEL = "source:search-demo-sources";
export const REVEAL_DEMO_SOURCE_CHANNEL = "memory:reveal-demo-source";
export const PREPARE_AI_CONVERSATION_CHANNEL = "ai:prepare-conversation";
export const START_AI_CONVERSATION_CHANNEL = "ai:start-conversation";
export const CANCEL_AI_CONVERSATION_CHANNEL = "ai:cancel-conversation";
export const AI_CONVERSATION_EVENT_CHANNEL = "ai:conversation-event";
export const APPLY_MEMORY_OPERATION_CHANNEL = "memory:apply-operation";
export const PREPARE_AGENT_RUN_CHANNEL = "agent:prepare-run";
export const START_AGENT_RUN_CHANNEL = "agent:start-run";
export const RESOLVE_AGENT_APPROVAL_CHANNEL = "agent:resolve-approval";
export const CANCEL_AGENT_RUN_CHANNEL = "agent:cancel-run";
export const AGENT_RUN_EVENT_CHANNEL = "agent:run-event";
export const REVERT_MEMORY_REVISION_CHANNEL = "memory:revert-revision";

export const AnalyzeInputRequestSchema = z.object({
  text: z.string().max(20_000)
});

export type AnalyzeInputRequest = z.infer<typeof AnalyzeInputRequestSchema>;

export const ProtectionRequestSchema = z.object({
  text: z.string().max(20_000),
  decisions: z.array(z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    policy: z.enum(["keep_original", "move_to_vault"]),
    credentialId: z.string().uuid().optional()
  })).max(500)
});

export type ProtectionRequest = z.infer<typeof ProtectionRequestSchema>;

export const SearchDemoSourcesRequestSchema = z.object({
  query: z.string().max(2_000)
});

export const RevealDemoSourceRequestSchema = z.object({
  sourceId: z.string().regex(/^SOURCE_(?:DEMO_\d{3,}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu)
});

export const PrepareAiConversationRequestSchema = z.object({
  text: z.string().trim().min(1).max(2_000)
});

export const StartAiConversationRequestSchema = z.object({
  draftId: z.string().uuid()
});

export const CancelAiConversationRequestSchema = z.object({
  runId: z.string().uuid()
});

export const PrepareAgentRunRequestSchema = z.object({
  text: z.string().trim().min(1).max(2_000),
  writePolicy: z.enum(["require_approval", "auto_apply"])
});

export const StartAgentRunRequestSchema = z.object({ draftId: z.string().uuid() });
export const ResolveAgentApprovalRequestSchema = z.object({
  runId: z.string().uuid(),
  approvalId: z.string().uuid(),
  decision: z.enum(["approve", "deny"])
});
export const CancelAgentRunRequestSchema = z.object({ runId: z.string().uuid() });
export const RevertMemoryRevisionRequestSchema = z.object({ revisionId: z.string().uuid() });

export type SearchDemoSourcesRequest = z.infer<typeof SearchDemoSourcesRequestSchema>;
export type RevealDemoSourceRequest = z.infer<typeof RevealDemoSourceRequestSchema>;
export const MemoryOperationSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("create"),
    path: z.string().min(1).max(1_000),
    content: z.string().min(1).max(50_000),
    reason: z.string().min(1).max(1_000)
  }),
  z.object({
    operation: z.literal("update"),
    path: z.string().min(1).max(1_000),
    expectedVersion: z.string().min(64).max(100),
    content: z.string().min(1).max(50_000),
    reason: z.string().min(1).max(1_000)
  })
]);

export const ApplyMemoryOperationRequestSchema = z.object({ operation: MemoryOperationSchema });

export type PrepareAiConversationRequest = z.infer<typeof PrepareAiConversationRequestSchema>;
export type StartAiConversationRequest = z.infer<typeof StartAiConversationRequestSchema>;
export type CancelAiConversationRequest = z.infer<typeof CancelAiConversationRequestSchema>;
export type ApplyMemoryOperationRequest = z.infer<typeof ApplyMemoryOperationRequestSchema>;
export type PrepareAgentRunRequest = z.infer<typeof PrepareAgentRunRequestSchema>;
export type StartAgentRunRequest = z.infer<typeof StartAgentRunRequestSchema>;
export type ResolveAgentApprovalRequest = z.infer<typeof ResolveAgentApprovalRequestSchema>;
export type CancelAgentRunRequest = z.infer<typeof CancelAgentRunRequestSchema>;
export type RevertMemoryRevisionRequest = z.infer<typeof RevertMemoryRevisionRequestSchema>;

export interface AiConversationRunEvent {
  readonly runId: string;
  readonly event: AiConversationEvent;
}

export interface AgentRunEventPayload {
  readonly runId: string;
  readonly event: AgentRuntimeEvent;
}

export interface BrainBuddyApi {
  analyzeInput(request: AnalyzeInputRequest): Promise<PrivacyAnalysis>;
  previewProtection(request: ProtectionRequest): Promise<ProtectionPreview>;
  saveDemoCandidate(request: ProtectionRequest): Promise<DemoSaveReceipt>;
  searchDemoSources(request: SearchDemoSourcesRequest): Promise<DemoOfflineSearchResult>;
  revealDemoSource(request: RevealDemoSourceRequest): Promise<DemoSourceReveal>;
  prepareAiConversation(request: PrepareAiConversationRequest): Promise<AiConversationDraft>;
  startAiConversation(request: StartAiConversationRequest): Promise<{ readonly runId: string }>;
  cancelAiConversation(request: CancelAiConversationRequest): Promise<void>;
  onAiConversationEvent(listener: (event: AiConversationRunEvent) => void): () => void;
  applyMemoryOperation(request: ApplyMemoryOperationRequest): Promise<MemoryFile>;
  prepareAgentRun(request: PrepareAgentRunRequest): Promise<AgentRunDraft>;
  startAgentRun(request: StartAgentRunRequest): Promise<{ readonly runId: string }>;
  resolveAgentApproval(request: ResolveAgentApprovalRequest): Promise<ApprovalResolution>;
  cancelAgentRun(request: CancelAgentRunRequest): Promise<void>;
  onAgentRunEvent(listener: (event: AgentRunEventPayload) => void): () => void;
  revertMemoryRevision(request: RevertMemoryRevisionRequest): Promise<MemoryRevertResult>;
}
