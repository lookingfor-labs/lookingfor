import type { PrivacyAnalysis } from "@brainbuddy/domain";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { activeQuestionProtectionRanges, buildManualCapture, buildQuestionProtectionDecisions, ManualSecretInput, prepareMvpAgentRun } from "./MvpApp";

describe("MVP question protection", () => {
  it("shows manually entered confidential information as plaintext while editing", () => {
    const markup = renderToStaticMarkup(createElement(ManualSecretInput, {
      value: "visible-secret",
      onChange: () => undefined
    }));

    expect(markup).toContain('type="text"');
    expect(markup).toContain('value="visible-secret"');
  });

  it("refreshes database records immediately after the conversation Source is persisted", async () => {
    const calls: string[] = [];
    const draft = {
      draftId: "draft-1",
      createdAt: "2026-08-27T00:00:00.000Z",
      message: "记录一下 agentflow 的密码是 [CREDENTIAL:test]",
      conversationSourceId: "SOURCE_TEST",
      writePolicy: "require_approval" as const,
      memoryIntent: { type: "write_required" as const, requiredSourceId: "SOURCE_TEST", requiredCredentialIds: ["test"] }
    };

    await expect(prepareMvpAgentRun({
      text: "记录一下 agentflow 的密码是 77778888",
      writePolicy: "require_approval",
      decisions: [],
      prepare: async () => {
        calls.push("persisted");
        return draft;
      },
      onSaved: () => calls.push("refreshed")
    })).resolves.toBe(draft);

    expect(calls).toEqual(["persisted", "refreshed"]);
  });

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

  it("turns every manually entered secret into an explicit protected range", () => {
    const capture = buildManualCapture({
      keyword: "家庭路由器",
      secrets: ["123456", "中文口令"],
      note: "书房"
    });

    expect(capture.text).toBe("家庭路由器\n保密信息：123456\n保密信息二：中文口令\n备注：书房");
    expect(capture.manual.map(({ entityType, ...range }) => ({
      ...range,
      value: capture.text.slice(range.start, range.end),
      entityType
    }))).toEqual([
      expect.objectContaining({ value: "123456", entityType: "custom" }),
      expect.objectContaining({ value: "中文口令", entityType: "custom" })
    ]);
  });

  it("allows a keep-original entity to be selected for protection again", () => {
    const analysis: PrivacyAnalysis = {
      inputLength: 6,
      analyzedAt: "2026-09-11T00:00:00.000Z",
      entities: [{
        text: "secret",
        start: 0,
        end: 6,
        type: "custom",
        risk: "medium",
        reason: ["ASCII segment"],
        suggestedPolicy: "move_to_vault",
        recognizerId: "ascii-segment"
      }]
    };

    expect(activeQuestionProtectionRanges(analysis, { "0:6": "keep_original" }, [])).toEqual([]);
    expect(activeQuestionProtectionRanges(analysis, { "0:6": "move_to_vault" }, [])).toEqual([
      expect.objectContaining({ start: 0, end: 6 })
    ]);
  });
});
