import { z } from "zod";
import type {
  DemoSaveReceipt,
  DemoMemorySummary,
  DemoSourceReveal,
  PrivacyAnalysis,
  ProtectionPreview
} from "@brainbuddy/domain";

export const ANALYZE_INPUT_CHANNEL = "privacy:analyze-input";
export const PREVIEW_PROTECTION_CHANNEL = "privacy:preview-protection";
export const SAVE_DEMO_CANDIDATE_CHANNEL = "memory:save-demo-candidate";
export const SEARCH_DEMO_MEMORIES_CHANNEL = "memory:search-demo-memories";
export const REVEAL_DEMO_SOURCE_CHANNEL = "memory:reveal-demo-source";

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

export const SearchDemoMemoriesRequestSchema = z.object({
  query: z.string().max(2_000)
});

export const RevealDemoSourceRequestSchema = z.object({
  sourceId: z.string().regex(/^SOURCE_DEMO_\d{3,}$/u)
});

export type SearchDemoMemoriesRequest = z.infer<typeof SearchDemoMemoriesRequestSchema>;
export type RevealDemoSourceRequest = z.infer<typeof RevealDemoSourceRequestSchema>;

export interface BrainBuddyApi {
  analyzeInput(request: AnalyzeInputRequest): Promise<PrivacyAnalysis>;
  previewProtection(request: ProtectionRequest): Promise<ProtectionPreview>;
  saveDemoCandidate(request: ProtectionRequest): Promise<DemoSaveReceipt>;
  searchDemoMemories(request: SearchDemoMemoriesRequest): Promise<readonly DemoMemorySummary[]>;
  revealDemoSource(request: RevealDemoSourceRequest): Promise<DemoSourceReveal>;
}
