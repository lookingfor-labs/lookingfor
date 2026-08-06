import type { EntityMapping } from "@brainbuddy/domain";
import { describe, expect, it } from "vitest";
import {
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
      defaultPolicy: "replace_with_token"
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

  it("builds a protected preview without secrets", () => {
    const input = "Figma 账号 luyong@example.com，密码是 A9x!4mQ2#pL7。";
    const result = new PrivacyEngine({ now: () => new Date("2025-01-01T00:00:00.000Z") }).analyze(input);
    expect(result.protectedPreview).toBe("Figma 账号 [EMAIL]，密码是 [CREDENTIAL_PASSWORD]。");
    expect(result.protectedPreview).not.toContain("luyong@example.com");
    expect(result.protectedPreview).not.toContain("A9x!4mQ2#pL7");
    expect(result.analyzedAt).toBe("2025-01-01T00:00:00.000Z");
  });
});
