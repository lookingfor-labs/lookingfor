import type { EntityMapping, ProtectionDecision } from "@brainbuddy/domain";
import { describe, expect, it } from "vitest";
import {
  ApiKeyRecognizer,
  buildProtectionPlan,
  EmailRecognizer,
  GitHubTokenRecognizer,
  HighEntropySecretRecognizer,
  JwtRecognizer,
  KeywordRecognizer,
  KnownEntityRecognizer,
  PrivacyEngine,
  PrivateKeyRecognizer
} from "./index";

describe("first recognizers", () => {
  it("detects a password next to a Chinese keyword", () => {
    const [entity] = new KeywordRecognizer().recognize("账号已创建，密码是 A9x!4mQ2#pL7。\n");
    expect(entity).toMatchObject({
      text: "A9x!4mQ2#pL7",
      type: "password",
      risk: "critical",
      suggestedPolicy: "move_to_vault"
    });
  });

  it("detects email addresses", () => {
    const [entity] = new EmailRecognizer().recognize("联系 luyong@example.com 处理");
    expect(entity).toMatchObject({ text: "luyong@example.com", type: "email" });
  });

  it("detects a PEM private key block as one critical entity", () => {
    const key = "-----BEGIN PRIVATE KEY-----\nZmFrZS1rZXktZm9yLXRlc3Rz\n-----END PRIVATE KEY-----";
    const [entity] = new PrivateKeyRecognizer().recognize(key);
    expect(entity).toMatchObject({ text: key, type: "private_key", risk: "critical" });
  });

  it("detects classic and fine-grained GitHub tokens", () => {
    const tokens = new GitHubTokenRecognizer().recognize(
      "ghp_1234567890abcdefghij github_pat_11AA22bb33CC44dd55EE66ff"
    );
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token.type === "github_token")).toBe(true);
  });

  it("detects a low-entropy API key when key context is explicit", () => {
    const [entity] = new ApiKeyRecognizer().recognize(
      "我的中转站的 key 是 sk-sdsdasdadasdasdasdaniinnz "
    );
    expect(entity).toMatchObject({
      text: "sk-sdsdasdadasdasdasdaniinnz",
      type: "api_key",
      risk: "critical",
      suggestedPolicy: "move_to_vault",
      replacementToken: "[CREDENTIAL_API_KEY]"
    });
  });

  it("detects a strong standalone sk-prefixed API key", () => {
    const [entity] = new ApiKeyRecognizer().recognize("使用 sk-AbCdEfGhIjKlMnOpQrSt1234 调试");
    expect(entity).toMatchObject({ type: "api_key", risk: "critical" });
  });

  it("does not treat key-like prose or short values as API keys", () => {
    const recognizer = new ApiKeyRecognizer();
    expect(recognizer.recognize("keyboard 是 development-environment")).toHaveLength(0);
    expect(recognizer.recognize("key 是 sk-short")).toHaveLength(0);
    expect(recognizer.recognize("组件名是 sk-design-system-component")).toHaveLength(0);
  });

  it("detects JWTs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";
    const [entity] = new JwtRecognizer().recognize(jwt);
    expect(entity).toMatchObject({ text: jwt, type: "jwt", risk: "critical" });
  });

  it("detects complex high entropy candidates but ignores ordinary prose", () => {
    const recognizer = new HighEntropySecretRecognizer();
    expect(recognizer.recognize("临时值 8cD$29mQv!4Lx7P 保存好了")).toHaveLength(1);
    expect(recognizer.recognize("BrainBuddy privacy project notes")).toHaveLength(0);
  });

  it("uses stable tokens from the known entity library", () => {
    const mapping: EntityMapping = {
      id: "person-1",
      canonicalName: "张伟",
      entityType: "person",
      token: "[PERSON_A]",
      aliases: ["老张"],
      defaultPolicy: "keep_original"
    };
    const entities = new KnownEntityRecognizer([mapping]).recognize("张伟和老张是同一个人");
    expect(entities).toHaveLength(2);
    expect(entities.every((entity) => entity.replacementToken === "[PERSON_A]")).toBe(true);
  });
});

describe("PrivacyEngine", () => {
  it("resolves overlaps in favor of the specialized critical recognizer", () => {
    const token = "ghp_1234567890abcdefghij";
    const result = new PrivacyEngine().analyze(`token ${token}`);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.type).toBe("github_token");
  });

  it("reports detected entities without creating another content view", () => {
    const input = "Figma 账号 luyong@example.com，密码是 A9x!4mQ2#pL7。";
    const result = new PrivacyEngine({ now: () => new Date("2025-01-01T00:00:00.000Z") }).analyze(input);
    expect(result.entities.map((entity) => entity.type)).toEqual(["email", "password"]);
    expect(result).not.toHaveProperty("protectedPreview");
    expect(result.analyzedAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("detects a contextual API key without transforming the input", () => {
    const secret = "sk-sdsdasdadasdasdasdaniinnz";
    const result = new PrivacyEngine().analyze(`我的中转站的 key 是 ${secret}`);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]?.type).toBe("api_key");
    expect(result).not.toHaveProperty("protectedPreview");
  });
});

describe("buildProtectionPlan", () => {
  const credentialId = "550e8400-e29b-41d4-a716-446655440000";
  const input = "张伟的账号 demo@example.com，key 是 sk-demoExample1234567890";
  const engine = new PrivacyEngine({
    knownEntities: [{
      id: "person-1",
      canonicalName: "张伟",
      entityType: "person",
      token: "[PERSON_A]",
      aliases: [],
      defaultPolicy: "keep_original"
    }]
  });

  it("builds one memory view and credential drafts from confirmed decisions", () => {
    const entities = engine.analyze(input).entities;
    const decisions: ProtectionDecision[] = entities.map((entity) => ({
      start: entity.start,
      end: entity.end,
      policy: entity.suggestedPolicy
    }));
    const plan = buildProtectionPlan({
      text: input,
      entities,
      decisions,
      credentialIdFactory: () => credentialId
    });

    expect(plan.protectedContent).toBe(
      "张伟的账号 demo@example.com，key 是 [CREDENTIAL:550e8400-e29b-41d4-a716-446655440000]"
    );
    expect(plan.credentialDrafts).toEqual([
      expect.objectContaining({
        credentialId,
        ref: "[CREDENTIAL:550e8400-e29b-41d4-a716-446655440000]",
        entityType: "api_key",
        secret: "sk-demoExample1234567890"
      })
    ]);
    expect(plan.safetyChecks.every((check) => check.passed)).toBe(true);
  });

  it("keeps high-risk values in the shared memory and AI content when the user chooses keep", () => {
    const analysis = new PrivacyEngine().analyze("账号 demo@example.com");
    const entity = analysis.entities[0]!;
    const plan = buildProtectionPlan({
      text: "账号 demo@example.com",
      entities: analysis.entities,
      decisions: [{ start: entity.start, end: entity.end, policy: "keep_original" }],
      credentialIdFactory: () => credentialId
    });

    expect(plan.protectedContent).toBe("账号 demo@example.com");
    expect(plan.credentialDrafts).toHaveLength(0);
  });

  it("rejects incomplete decisions instead of silently using defaults", () => {
    const entities = engine.analyze(input).entities;
    expect(() => buildProtectionPlan({ text: input, entities, decisions: [], credentialIdFactory: () => credentialId })).toThrow(
      "Every detected entity requires one protection decision"
    );
  });

  it("lets the user extract a medium-risk entity despite its keep-original default", () => {
    const entity = engine.analyze("张伟").entities[0]!;
    const plan = buildProtectionPlan({
      text: "张伟",
      entities: [entity],
      decisions: [{ start: entity.start, end: entity.end, policy: "move_to_vault" }],
      credentialIdFactory: () => credentialId
    });

    expect(plan.protectedContent).toBe(`[CREDENTIAL:${credentialId}]`);
    expect(plan.credentialDrafts[0]).toEqual(expect.objectContaining({
      credentialId,
      entityType: "person",
      secret: "张伟"
    }));
  });

  it("reuses a confirmed credential id so preview and persistence share one lookup key", () => {
    const entity = engine.analyze(input).entities.find((candidate) => candidate.type === "api_key")!;
    const plan = buildProtectionPlan({
      text: input,
      entities: [entity],
      decisions: [{
        start: entity.start,
        end: entity.end,
        policy: "move_to_vault",
        credentialId
      }],
      credentialIdFactory: () => { throw new Error("should not allocate another id"); }
    });

    expect(plan.credentialDrafts[0]?.credentialId).toBe(credentialId);
    expect(plan.protectedContent).toContain(`[CREDENTIAL:${credentialId}]`);
  });
});
