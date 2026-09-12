import { describe, expect, it } from "vitest";
import { databaseRecordTab, manualCaptureMemoryPathForSource, sourceTitle } from "./MvpApp";

describe("databaseRecordTab", () => {
  it("separates direct saves from AI and query records", () => {
    expect(databaseRecordTab("capture")).toBe("saved");
    expect(databaseRecordTab("conversation")).toBe("conversation");
    expect(databaseRecordTab("local_search")).toBe("conversation");
  });

  it("derives a readable title and deterministic Memory path for a captured Source", () => {
    expect(sourceTitle({ protectedContent: "Figma 账号\n保密信息：[CREDENTIAL:test]" })).toBe("Figma 账号");
    expect(manualCaptureMemoryPathForSource("SOURCE_00000000-0000-4000-8000-000000000001"))
      .toBe("memories/manual-captures/00000000-0000-4000-8000-000000000001.md");
  });
});
