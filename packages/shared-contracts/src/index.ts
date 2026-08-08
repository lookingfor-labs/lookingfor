import { z } from "zod";
import type {
  DemoSaveReceipt,
  DemoOfflineSearchResult,
  DemoQueryResult,
  AiConversationDraft,
  AiConversationEvent,
  DemoSourceReveal,
  PrivacyAnalysis,
  ProtectionPreview,
  MemoryFile
} from "@brainbuddy/domain";

export const ANALYZE_INPUT_CHANNEL = "privacy:analyze-input";
export const PREVIEW_PROTECTION_CHANNEL = "privacy:preview-protection";
export const SAVE_DEMO_CANDIDATE_CHANNEL = "memory:save-demo-candidate";
export const SEARCH_DEMO_SOURCES_CHANNEL = "source:search-demo-sources";
export const SUBMIT_DEMO_QUERY_CHANNEL = "source:submit-demo-query";
export const REVEAL_DEMO_SOURCE_CHANNEL = "memory:reveal-demo-source";
export const PREPARE_AI_CONVERSATION_CHANNEL = "ai:prepare-conversation";
export const START_AI_CONVERSATION_CHANNEL = "ai:start-conversation";
export const CANCEL_AI_CONVERSATION_CHANNEL = "ai:cancel-conversation";
export const AI_CONVERSATION_EVENT_CHANNEL = "ai:conversation-event";
export const APPLY_MEMORY_OPERATION_CHANNEL = "memory:apply-operation";

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

export const SubmitDemoQueryRequestSchema = z.object({
  text: z.string().trim().min(1).max(2_000)
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

export type SearchDemoSourcesRequest = z.infer<typeof SearchDemoSourcesRequestSchema>;
export type SubmitDemoQueryRequest = z.infer<typeof SubmitDemoQueryRequestSchema>;
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
    expectedVersion: z.string().length(64),
    content: z.string().min(1).max(50_000),
    reason: z.string().min(1).max(1_000)
  })
]);

export const ApplyMemoryOperationRequestSchema = z.object({ operation: MemoryOperationSchema });

export type PrepareAiConversationRequest = z.infer<typeof PrepareAiConversationRequestSchema>;
export type StartAiConversationRequest = z.infer<typeof StartAiConversationRequestSchema>;
export type CancelAiConversationRequest = z.infer<typeof CancelAiConversationRequestSchema>;
export type ApplyMemoryOperationRequest = z.infer<typeof ApplyMemoryOperationRequestSchema>;

export interface AiConversationRunEvent {
  readonly runId: string;
  readonly event: AiConversationEvent;
}

export interface BrainBuddyApi {
  analyzeInput(request: AnalyzeInputRequest): Promise<PrivacyAnalysis>;
  previewProtection(request: ProtectionRequest): Promise<ProtectionPreview>;
  saveDemoCandidate(request: ProtectionRequest): Promise<DemoSaveReceipt>;
  searchDemoSources(request: SearchDemoSourcesRequest): Promise<DemoOfflineSearchResult>;
  submitDemoQuery(request: SubmitDemoQueryRequest): Promise<DemoQueryResult>;
  revealDemoSource(request: RevealDemoSourceRequest): Promise<DemoSourceReveal>;
  prepareAiConversation(request: PrepareAiConversationRequest): Promise<AiConversationDraft>;
  startAiConversation(request: StartAiConversationRequest): Promise<{ readonly runId: string }>;
  cancelAiConversation(request: CancelAiConversationRequest): Promise<void>;
  onAiConversationEvent(listener: (event: AiConversationRunEvent) => void): () => void;
  applyMemoryOperation(request: ApplyMemoryOperationRequest): Promise<MemoryFile>;
}
