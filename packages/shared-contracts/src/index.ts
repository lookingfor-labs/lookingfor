import { z } from "zod";
import type { PrivacyAnalysis } from "@brainbuddy/domain";

export const ANALYZE_INPUT_CHANNEL = "privacy:analyze-input";

export const AnalyzeInputRequestSchema = z.object({
  text: z.string().max(20_000)
});

export type AnalyzeInputRequest = z.infer<typeof AnalyzeInputRequestSchema>;

export interface BrainBuddyApi {
  analyzeInput(request: AnalyzeInputRequest): Promise<PrivacyAnalysis>;
}
