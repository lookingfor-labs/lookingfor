import { describe, expect, it } from "vitest";
import type { ProtectionPlan } from "@brainbuddy/domain";
import { DemoMemorySession } from "./index";

const safePlan: ProtectionPlan = {
  memoryContent: "key 是 [CREDENTIAL:550e8400-e29b-41d4-a716-446655440000]",
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
    id: "memory_secret_free",
    label: "安全",
    passed: true,
    detail: "已通过"
  }]
};

describe("DemoMemorySession", () => {
  it("returns a safe receipt without exposing credential secrets", () => {
    const session = new DemoMemorySession({ now: () => new Date("2026-08-07T00:00:00.000Z") });
    const receipt = session.save(safePlan);

    expect(receipt.memoryId).toBe("MEMORY_DEMO_001");
    expect(receipt.credentialIds).toEqual(["550e8400-e29b-41d4-a716-446655440000"]);
    expect(receipt.savedAt).toBe("2026-08-07T00:00:00.000Z");
    expect(JSON.stringify(receipt)).not.toContain("sk-secret-value-123456");
  });

  it("assigns sequential ids within one session", () => {
    const session = new DemoMemorySession();
    const planWithoutCredentials = {
      ...safePlan,
      credentialDrafts: [],
      memoryContent: "普通记忆"
    };
    session.save(planWithoutCredentials);
    expect(session.save(planWithoutCredentials).memoryId).toBe("MEMORY_DEMO_002");
  });

  it("rejects reusing a credential lookup id in one session", () => {
    const session = new DemoMemorySession();
    session.save(safePlan);
    expect(() => session.save(safePlan)).toThrow("A credential id can only be saved once per session");
  });

  it("rejects a plan that fails a safety check", () => {
    const session = new DemoMemorySession();
    expect(() => session.save({
      ...safePlan,
      safetyChecks: [{ ...safePlan.safetyChecks[0]!, passed: false }]
    })).toThrow("Protection checks must pass before saving");
  });
});
