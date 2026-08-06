import type { DetectedEntity, EntityMapping, PrivacyAnalysis } from "@brainbuddy/domain";
import { resolveOverlaps } from "./helpers";
import {
  EmailRecognizer,
  GitHubTokenRecognizer,
  HighEntropySecretRecognizer,
  JwtRecognizer,
  KeywordRecognizer,
  KnownEntityRecognizer,
  PrivateKeyRecognizer
} from "./recognizers";
import type { Recognizer } from "./types";

export * from "./recognizers";
export * from "./types";

export interface PrivacyEngineOptions {
  readonly knownEntities?: readonly EntityMapping[];
  readonly now?: () => Date;
}

export class PrivacyEngine {
  private readonly recognizers: readonly Recognizer[];
  private readonly now: () => Date;

  constructor(options: PrivacyEngineOptions = {}) {
    this.recognizers = [
      new PrivateKeyRecognizer(),
      new GitHubTokenRecognizer(),
      new JwtRecognizer(),
      new KeywordRecognizer(),
      new EmailRecognizer(),
      new HighEntropySecretRecognizer(),
      new KnownEntityRecognizer(options.knownEntities ?? [])
    ];
    this.now = options.now ?? (() => new Date());
  }

  analyze(text: string): PrivacyAnalysis {
    const entities = resolveOverlaps(this.recognizers.flatMap((recognizer) => recognizer.recognize(text)));
    return {
      inputLength: text.length,
      entities,
      protectedPreview: buildProtectedPreview(text, entities),
      analyzedAt: this.now().toISOString()
    };
  }
}

export function buildProtectedPreview(text: string, entities: readonly DetectedEntity[]): string {
  let cursor = 0;
  let output = "";
  for (const entity of [...entities].sort((left, right) => left.start - right.start)) {
    output += text.slice(cursor, entity.start);
    output += entity.replacementToken ?? policyFallback(entity);
    cursor = entity.end;
  }
  return output + text.slice(cursor);
}

function policyFallback(entity: DetectedEntity): string {
  if (entity.suggestedPolicy === "keep_original") return entity.text;
  if (entity.suggestedPolicy === "original_only") return `[${entity.type.toUpperCase()}]`;
  return `[PROTECTED_${entity.type.toUpperCase()}]`;
}
