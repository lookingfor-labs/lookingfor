import type {
  CredentialDraft,
  DemoSourceSummary,
  DemoSaveReceipt,
  DemoSourceReveal,
  ProtectionPlan
} from "@brainbuddy/domain";
import { toProtectionPreview } from "@brainbuddy/privacy-engine";

export interface DemoSourceSessionOptions {
  readonly now?: () => Date;
}

export class DemoSourceSession {
  readonly #now: () => Date;
  #sequence = 0;
  readonly #credentials = new Map<string, CredentialDraft>();
  readonly #summaries = new Map<string, DemoSourceSummary>();
  readonly #sources = new Map<string, DemoSourceReveal>();

  constructor(options: DemoSourceSessionOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  save(plan: ProtectionPlan, originalContent: string): DemoSaveReceipt {
    const initialPreview = toProtectionPreview(plan);
    if (!initialPreview.readyToSave) {
      throw new Error("Protection checks must pass before saving");
    }
    if (plan.credentialDrafts.some((credential) => this.#credentials.has(credential.credentialId))) {
      throw new Error("A credential id can only be saved once per session");
    }

    this.#sequence += 1;
    const suffix = String(this.#sequence).padStart(3, "0");
    const sourceId = `SOURCE_DEMO_${suffix}`;
    const savedAt = this.#now().toISOString();
    const storedPlan = {
      ...plan,
      protectedContent: `${plan.protectedContent}\n\n来源：[SOURCE:${sourceId}]`
    };
    const preview = toProtectionPreview(storedPlan);
    const credentialIds = plan.credentialDrafts.map((credential) => credential.credentialId);
    plan.credentialDrafts.forEach((credential) => this.#credentials.set(credential.credentialId, credential));
    this.#sources.set(sourceId, { sourceId, originalContent, savedAt });
    this.#summaries.set(sourceId, { sourceId, protectedContent: storedPlan.protectedContent, credentialIds, savedAt });

    return {
      sourceId,
      credentialIds,
      savedAt,
      storage: "memory_session",
      preview
    };
  }

  search(query: string): readonly DemoSourceSummary[] {
    const normalized = query.trim().toLocaleLowerCase();
    return [...this.#summaries.values()].filter((summary) =>
      !normalized || [summary.sourceId, summary.protectedContent, ...summary.credentialIds]
        .some((value) => value.toLocaleLowerCase().includes(normalized))
    );
  }

  revealSource(sourceId: string): DemoSourceReveal {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error("Source record not found");
    return source;
  }
}
