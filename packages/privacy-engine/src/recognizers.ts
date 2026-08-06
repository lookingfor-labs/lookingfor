import type { DetectedEntity, EntityMapping } from "@brainbuddy/domain";
import { collectMatches, shannonEntropy } from "./helpers";
import type { Recognizer } from "./types";

export class EmailRecognizer implements Recognizer {
  readonly id = "email";

  recognize(text: string): readonly DetectedEntity[] {
    return collectMatches(
      text,
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
      (match) => ({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
        type: "email",
        risk: "high",
        reason: ["符合邮箱地址格式"],
        suggestedPolicy: "original_only",
        recognizerId: this.id
      })
    );
  }
}

export class PrivateKeyRecognizer implements Recognizer {
  readonly id = "private-key";

  recognize(text: string): readonly DetectedEntity[] {
    return collectMatches(
      text,
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
      (match) => ({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
        type: "private_key",
        risk: "critical",
        reason: ["匹配私钥 PEM 块"],
        suggestedPolicy: "move_to_vault",
        recognizerId: this.id,
        replacementToken: "[CREDENTIAL_PRIVATE_KEY]"
      })
    );
  }
}

export class GitHubTokenRecognizer implements Recognizer {
  readonly id = "github-token";

  recognize(text: string): readonly DetectedEntity[] {
    const classic = collectMatches(text, /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/gu, (match) =>
      this.entity(match)
    );
    const fineGrained = collectMatches(
      text,
      /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/gu,
      (match) => this.entity(match)
    );
    return [...classic, ...fineGrained];
  }

  private entity(match: RegExpExecArray): DetectedEntity {
    return {
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
      type: "github_token",
      risk: "critical",
      reason: ["匹配 GitHub Token 格式"],
      suggestedPolicy: "move_to_vault",
      recognizerId: this.id,
      replacementToken: "[CREDENTIAL_GITHUB]"
    };
  }
}

export class JwtRecognizer implements Recognizer {
  readonly id = "jwt";

  recognize(text: string): readonly DetectedEntity[] {
    return collectMatches(
      text,
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      (match) => ({
        text: match[0],
        start: match.index,
        end: match.index + match[0].length,
        type: "jwt",
        risk: "critical",
        reason: ["匹配 JWT 三段式结构"],
        suggestedPolicy: "move_to_vault",
        recognizerId: this.id,
        replacementToken: "[CREDENTIAL_JWT]"
      })
    );
  }
}

export class KeywordRecognizer implements Recognizer {
  readonly id = "keyword";

  recognize(text: string): readonly DetectedEntity[] {
    return collectMatches(
      text,
      /(?:密码|口令|password|passwd|pwd)\s*(?:是|为|[:：=])\s*["']?([^\s，。；;"']{6,})["']?/giu,
      (match) => {
        const secret = match[1];
        if (!secret) return undefined;
        const relativeStart = match[0].indexOf(secret);
        const start = match.index + relativeStart;
        return {
          text: secret,
          start,
          end: start + secret.length,
          type: "password",
          risk: "critical",
          reason: ["密码关键词附近出现疑似凭证"],
          suggestedPolicy: "move_to_vault",
          recognizerId: this.id,
          replacementToken: "[CREDENTIAL_PASSWORD]"
        };
      }
    );
  }
}

export class HighEntropySecretRecognizer implements Recognizer {
  readonly id = "high-entropy-secret";

  recognize(text: string): readonly DetectedEntity[] {
    return collectMatches(
      text,
      /(?<![\w@])([A-Za-z0-9][A-Za-z0-9_!@#$%^&*+./=~-]{11,})(?![\w@])/gu,
      (match) => {
        const candidate = match[1];
        if (!candidate) return undefined;
        const hasLetters = /[A-Za-z]/u.test(candidate);
        const hasDigits = /\d/u.test(candidate);
        const characterClasses = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter(
          (pattern) => pattern.test(candidate)
        ).length;
        if (!hasLetters || !hasDigits || characterClasses < 3 || shannonEntropy(candidate) < 3.4) {
          return undefined;
        }
        const start = match.index + match[0].indexOf(candidate);
        return {
          text: candidate,
          start,
          end: start + candidate.length,
          type: "high_entropy_secret",
          risk: "high",
          reason: ["字符串较长且字符分布复杂", "同时包含多类字符"],
          suggestedPolicy: "original_only",
          recognizerId: this.id,
          replacementToken: "[POTENTIAL_SECRET]"
        };
      }
    );
  }
}

export class KnownEntityRecognizer implements Recognizer {
  readonly id = "known-entity";

  constructor(private readonly mappings: readonly EntityMapping[]) {}

  recognize(text: string): readonly DetectedEntity[] {
    const entities: DetectedEntity[] = [];
    for (const mapping of this.mappings) {
      for (const name of [mapping.canonicalName, ...mapping.aliases]) {
        let position = text.indexOf(name);
        while (position !== -1) {
          entities.push({
            text: name,
            start: position,
            end: position + name.length,
            type: mapping.entityType,
            risk: "medium",
            reason: ["命中本地已知实体库"],
            suggestedPolicy: mapping.defaultPolicy,
            recognizerId: this.id,
            replacementToken: mapping.token
          });
          position = text.indexOf(name, position + name.length);
        }
      }
    }
    return entities;
  }
}
