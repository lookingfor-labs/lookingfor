import { describe, expect, it } from "vitest";
import { DemoMemorySession } from "@brainbuddy/memory-engine/memory";
import type { DemoSaveReceipt } from "@brainbuddy/domain";
import {
  ManualCaptureMemoryProjector,
  formatManualCaptureSavedAt,
  manualCaptureMemoryContent,
  manualCaptureMemoryPath
} from "./manual-capture-memory-projector";

const receipt: DemoSaveReceipt = {
  sourceId: "SOURCE_00000000-0000-4000-8000-000000000001",
  kind: "capture",
  credentialIds: ["550e8400-e29b-41d4-a716-446655440000"],
  savedAt: "2026-09-12T08:30:00.000Z",
  storage: "sqlite",
  preview: {
    protectedContent: "Figma 账号\n保密信息：[CREDENTIAL:550e8400-e29b-41d4-a716-446655440000]\n保密信息二：允许 AI 读取的公开说明\n来源：[SOURCE:SOURCE_00000000-0000-4000-8000-000000000001]",
    credentials: [],
    safetyChecks: [],
    readyToSave: true
  }
};

describe("ManualCaptureMemoryProjector", () => {
  it("creates a deterministic AI-readable Memory without Credential plaintext", () => {
    const memories = new DemoMemorySession();
    const memory = new ManualCaptureMemoryProjector(memories).project(receipt);

    expect(memory.path).toBe(manualCaptureMemoryPath(receipt.sourceId));
    expect(memory.content).toBe(manualCaptureMemoryContent(receipt));
    expect(memory.content).toContain(receipt.credentialIds[0]!);
    expect(memory.content).toContain(receipt.sourceId);
    expect(memory.content).toContain("记录方式：用户主动保存");
    expect(memory.content).toContain("保密信息二：允许 AI 读取的公开说明");
    expect(memory.content).not.toContain("主动保存了与“Figma 账号”相关的信息");
  });

  it("formats the saved time for people while retaining its timezone", () => {
    expect(formatManualCaptureSavedAt("2026-09-12T08:27:09.937Z", "Asia/Hong_Kong"))
      .toBe("2026-09-12 16:27:09（Asia/Hong_Kong）");
    expect(formatManualCaptureSavedAt("not-a-date", "Asia/Hong_Kong")).toBe("not-a-date");
  });

  it("rejects conversation Sources", () => {
    const memories = new DemoMemorySession();
    expect(() => new ManualCaptureMemoryProjector(memories).project({ ...receipt, kind: "conversation" }))
      .toThrow("Only manually captured Sources can be projected to Memory");
  });
});
