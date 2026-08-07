import type { CredentialDraft, DemoSaveReceipt, ProtectionPlan } from "@brainbuddy/domain";
import { toProtectionPreview } from "@brainbuddy/privacy-engine";

export interface DemoMemorySessionOptions {
  readonly now?: () => Date;
}

export class DemoMemorySession {
  readonly #now: () => Date;
  #sequence = 0;
  readonly #records = new Map<string, ProtectionPlan>();
  readonly #credentials = new Map<string, CredentialDraft>();

  constructor(options: DemoMemorySessionOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  save(plan: ProtectionPlan): DemoSaveReceipt {
    const preview = toProtectionPreview(plan);
    if (!preview.readyToSave) {
      throw new Error("Protection checks must pass before saving");
    }
    if (plan.credentialDrafts.some((credential) => this.#credentials.has(credential.credentialId))) {
      throw new Error("A credential id can only be saved once per session");
    }

    this.#sequence += 1;
    const suffix = String(this.#sequence).padStart(3, "0");
    const memoryId = `MEMORY_DEMO_${suffix}`;
    this.#records.set(memoryId, plan);
    plan.credentialDrafts.forEach((credential) => this.#credentials.set(credential.credentialId, credential));

    return {
      memoryId,
      credentialIds: plan.credentialDrafts.map((credential) => credential.credentialId),
      savedAt: this.#now().toISOString(),
      storage: "memory_session",
      preview
    };
  }
}
