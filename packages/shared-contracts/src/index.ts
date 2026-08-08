import { z } from "zod";
import type {
  DemoSaveReceipt,
  DemoOfflineSearchResult,
  DemoQueryResult,
  AiQueryDraft,
  AiQueryEvent,
  DemoSourceReveal,
  PrivacyAnalysis,
  ProtectionPreview
} from "@brainbuddy/domain";

export const ANALYZE_INPUT_CHANNEL = "privacy:analyze-input";
export const PREVIEW_PROTECTION_CHANNEL = "privacy:preview-protection";
export const SAVE_DEMO_CANDIDATE_CHANNEL = "memory:save-demo-candidate";
export const SEARCH_DEMO_SOURCES_CHANNEL = "source:search-demo-sources";
export const SUBMIT_DEMO_QUERY_CHANNEL = "source:submit-demo-query";
export const REVEAL_DEMO_SOURCE_CHANNEL = "memory:reveal-demo-source";
export const PREPARE_AI_QUERY_CHANNEL = "ai:prepare-query";
export const START_AI_QUERY_CHANNEL = "ai:start-query";
export const CANCEL_AI_QUERY_CHANNEL = "ai:cancel-query";
export const AI_QUERY_EVENT_CHANNEL = "ai:query-event";

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

export const PrepareAiQueryRequestSchema = z.object({
  text: z.string().trim().min(1).max(2_000)
});

export const StartAiQueryRequestSchema = z.object({
  draftId: z.string().uuid()
});

export const CancelAiQueryRequestSchema = z.object({
  runId: z.string().uuid()
});

export type SearchDemoSourcesRequest = z.infer<typeof SearchDemoSourcesRequestSchema>;
export type SubmitDemoQueryRequest = z.infer<typeof SubmitDemoQueryRequestSchema>;
export type RevealDemoSourceRequest = z.infer<typeof RevealDemoSourceRequestSchema>;
export type PrepareAiQueryRequest = z.infer<typeof PrepareAiQueryRequestSchema>;
export type StartAiQueryRequest = z.infer<typeof StartAiQueryRequestSchema>;
export type CancelAiQueryRequest = z.infer<typeof CancelAiQueryRequestSchema>;

export interface AiQueryRunEvent {
  readonly runId: string;
  readonly event: AiQueryEvent;
}

export interface BrainBuddyApi {
  analyzeInput(request: AnalyzeInputRequest): Promise<PrivacyAnalysis>;
  previewProtection(request: ProtectionRequest): Promise<ProtectionPreview>;
  saveDemoCandidate(request: ProtectionRequest): Promise<DemoSaveReceipt>;
  searchDemoSources(request: SearchDemoSourcesRequest): Promise<DemoOfflineSearchResult>;
  submitDemoQuery(request: SubmitDemoQueryRequest): Promise<DemoQueryResult>;
  revealDemoSource(request: RevealDemoSourceRequest): Promise<DemoSourceReveal>;
  prepareAiQuery(request: PrepareAiQueryRequest): Promise<AiQueryDraft>;
  startAiQuery(request: StartAiQueryRequest): Promise<{ readonly runId: string }>;
  cancelAiQuery(request: CancelAiQueryRequest): Promise<void>;
  onAiQueryEvent(listener: (event: AiQueryRunEvent) => void): () => void;
}
