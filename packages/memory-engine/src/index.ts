import type {
  CredentialDraft,
  DemoMemorySummary,
  DemoSaveReceipt,
  DemoSourceReveal,
  ProtectionPlan
} from "@brainbuddy/domain";
import { toProtectionPreview } from "@brainbuddy/privacy-engine";

export interface DemoMemorySessionOptions {
  readonly now?: () => Date;
}

export class DemoMemorySession {
  readonly #now: () => Date;
  #sequence = 0;
  readonly #records = new Map<string, ProtectionPlan>();
  readonly #credentials = new Map<string, CredentialDraft>();
  readonly #summaries = new Map<string, DemoMemorySummary>();
  readonly #sources = new Map<string, DemoSourceReveal>();

  constructor(options: DemoMemorySessionOptions = {}) {
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
    const memoryId = `MEMORY_DEMO_${suffix}`;
    const sourceId = `SOURCE_DEMO_${suffix}`;
    const savedAt = this.#now().toISOString();
    const storedPlan = {
      ...plan,
      memoryContent: `${plan.memoryContent}\n\n来源：[SOURCE:${sourceId}]`
    };
    const preview = toProtectionPreview(storedPlan);
    const credentialIds = plan.credentialDrafts.map((credential) => credential.credentialId);
    this.#records.set(memoryId, storedPlan);
    plan.credentialDrafts.forEach((credential) => this.#credentials.set(credential.credentialId, credential));
    this.#sources.set(sourceId, { sourceId, originalContent, savedAt });
    this.#summaries.set(memoryId, { memoryId, sourceId, memoryContent: storedPlan.memoryContent, credentialIds, savedAt });

    return {
      memoryId,
      sourceId,
      credentialIds,
      savedAt,
      storage: "memory_session",
      preview
    };
  }

  search(query: string): readonly DemoMemorySummary[] {
    const normalized = query.trim().toLocaleLowerCase();
    return [...this.#summaries.values()].filter((summary) =>
      !normalized || [summary.memoryId, summary.sourceId, summary.memoryContent, ...summary.credentialIds]
        .some((value) => value.toLocaleLowerCase().includes(normalized))
    );
  }

  revealSource(sourceId: string): DemoSourceReveal {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error("Source record not found");
    return source;
  }
}
