import type { DetectedEntity, EntityMapping, PrivacyAnalysis } from "@brainbuddy/domain";
import { resolveOverlaps } from "./helpers.ts";
import {
  ApiKeyRecognizer,
  AsciiSegmentRecognizer,
  EmailRecognizer,
  GitHubTokenRecognizer,
  HighEntropySecretRecognizer,
  JwtRecognizer,
  KeywordRecognizer,
  KnownEntityRecognizer,
  PrivateKeyRecognizer
} from "./recognizers.ts";
import type { Recognizer } from "./types.ts";
import { findCredentialReferences } from "./credential-id.ts";

export * from "./recognizers.ts";
export * from "./credential-id.ts";
export * from "./protection-plan.ts";
export * from "./types.ts";

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
      new ApiKeyRecognizer(),
      new GitHubTokenRecognizer(),
      new JwtRecognizer(),
      new KeywordRecognizer(),
      new EmailRecognizer(),
      new HighEntropySecretRecognizer(),
      new KnownEntityRecognizer(options.knownEntities ?? []),
      new AsciiSegmentRecognizer()
    ];
    this.now = options.now ?? (() => new Date());
  }

  analyze(text: string): PrivacyAnalysis {
    const references = findCredentialReferences(text);
    const entities = resolveOverlaps(this.recognizers.flatMap((recognizer) => recognizer.recognize(text)))
      .filter((entity) => !references.some((reference) => entity.start >= reference.start && entity.end <= reference.end));
    return {
      inputLength: text.length,
      entities,
      analyzedAt: this.now().toISOString()
    };
  }
}
