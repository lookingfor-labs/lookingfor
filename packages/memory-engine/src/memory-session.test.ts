import { describe, expect, it } from "vitest";
import type { ProtectionPlan } from "@brainbuddy/domain";
import { DemoSourceSession } from "./index";

const safePlan: ProtectionPlan = {
  protectedContent: "key 是 [CREDENTIAL:550e8400-e29b-41d4-a716-446655440000]",
  credentialDrafts: [{
    credentialId: "550e8400-e29b-41d4-a716-446655440000",
    ref: "[CREDENTIAL:550e8400-e29b-41d4-a716-446655440000]",
    start: 6,
    end: 28,
    entityType: "api_key",
    secret: "sk-secret-value-123456",
    maskedValue: "sk-••••••••••••56"
  }],
  safetyChecks: [{
    id: "protected_content_secret_free",
    label: "安全",
    passed: true,
    detail: "已通过"
  }]
};

describe("DemoSourceSession", () => {
  it("returns a safe receipt without exposing credential secrets", () => {
    const session = new DemoSourceSession({ now: () => new Date("2026-08-07T00:00:00.000Z") });
    const receipt = session.save(safePlan, "原始 key 是 sk-secret-value-123456");

    expect(receipt.sourceId).toBe("SOURCE_DEMO_001");
    expect(receipt.preview.protectedContent).toContain("[SOURCE:SOURCE_DEMO_001]");
    expect(receipt.credentialIds).toEqual(["550e8400-e29b-41d4-a716-446655440000"]);
    expect(receipt.savedAt).toBe("2026-08-07T00:00:00.000Z");
    expect(JSON.stringify(receipt)).not.toContain("sk-secret-value-123456");
  });

  it("assigns sequential source ids within one session", () => {
    const session = new DemoSourceSession();
    const planWithoutCredentials = {
      ...safePlan,
      credentialDrafts: [],
      protectedContent: "普通输入"
    };
    session.save(planWithoutCredentials, "第一条原文");
    expect(session.save(planWithoutCredentials, "第二条原文").sourceId).toBe("SOURCE_DEMO_002");
  });

  it("links one credential to every source where it is observed", () => {
    const session = new DemoSourceSession();
    const first = session.save(safePlan, "第一条原文");
    const second = session.save(safePlan, "第二条原文", "local_search");

    expect(second.kind).toBe("local_search");
    expect(session.searchOffline("550e8400").credentials[0]?.sourceIds).toEqual([
      first.sourceId,
      second.sourceId
    ]);
  });

  it("rejects a plan that fails a safety check", () => {
    const session = new DemoSourceSession();
    expect(() => session.save({
      ...safePlan,
      safetyChecks: [{ ...safePlan.safetyChecks[0]!, passed: false }]
    }, "原始内容")).toThrow("Protection checks must pass before saving");
  });

  it("searches protected source content and reveals the original only by source id", () => {
    const session = new DemoSourceSession();
    const receipt = session.save(safePlan, "只有手动操作才能看到的原始内容");

    expect(session.search("SOURCE_DEMO_001")).toHaveLength(1);
    expect(JSON.stringify(session.search("key"))).not.toContain("只有手动操作才能看到的原始内容");
    expect(session.revealSource(receipt.sourceId).originalContent).toBe("只有手动操作才能看到的原始内容");
    expect(() => session.revealSource("SOURCE_DEMO_999")).toThrow("Source record not found");
  });
});
