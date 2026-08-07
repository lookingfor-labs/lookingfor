import { z } from "zod";
import type {
  DemoSaveReceipt,
  PrivacyAnalysis,
  ProtectionPreview
} from "@brainbuddy/domain";

export const ANALYZE_INPUT_CHANNEL = "privacy:analyze-input";
export const PREVIEW_PROTECTION_CHANNEL = "privacy:preview-protection";
export const SAVE_DEMO_CANDIDATE_CHANNEL = "memory:save-demo-candidate";

export const AnalyzeInputRequestSchema = z.object({
  text: z.string().max(20_000)
});

export type AnalyzeInputRequest = z.infer<typeof AnalyzeInputRequestSchema>;

export const ProtectionRequestSchema = z.object({
  text: z.string().max(20_000),
  decisions: z.array(z.object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    policy: z.enum(["keep_original", "replace_with_token", "original_only", "move_to_vault"])
  })).max(500)
});

export type ProtectionRequest = z.infer<typeof ProtectionRequestSchema>;

export interface BrainBuddyApi {
  analyzeInput(request: AnalyzeInputRequest): Promise<PrivacyAnalysis>;
  previewProtection(request: ProtectionRequest): Promise<ProtectionPreview>;
  saveDemoCandidate(request: ProtectionRequest): Promise<DemoSaveReceipt>;
}
