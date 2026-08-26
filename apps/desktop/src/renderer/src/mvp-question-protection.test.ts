import type { PrivacyAnalysis } from "@brainbuddy/domain";
import { describe, expect, it } from "vitest";
import { buildQuestionProtectionDecisions } from "./MvpApp";

describe("MVP question protection", () => {
  it("keeps the preview Credential ID when the protected question is submitted", () => {
    const text = "记录一下 agentflow 的密码是 77778888";
    const secret = "77778888";
    const start = text.indexOf(secret);
    const analysis: PrivacyAnalysis = {
      inputLength: text.length,
      analyzedAt: "2026-08-27T00:00:00.000Z",
      entities: [{
        text: secret,
        start,
        end: start + secret.length,
        type: "password",
        risk: "critical",
        reason: ["密码语境"],
        suggestedPolicy: "move_to_vault",
        recognizerId: "password-context"
      }]
    };
    const credentialId = "00e5dcad-aad5-4fe2-a520-3ca35e0d03a8";

    expect(buildQuestionProtectionDecisions(
      analysis,
      { [`${start}:${start + secret.length}`]: "move_to_vault" },
      { [`${start}:${start + secret.length}`]: credentialId }
    )).toEqual([{
      start,
      end: start + secret.length,
      policy: "move_to_vault",
      credentialId
    }]);
  });
});
