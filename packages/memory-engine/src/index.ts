import type { DemoSaveReceipt, ProtectionPlan } from "@brainbuddy/domain";
import { toProtectionPreview } from "@brainbuddy/privacy-engine";

export interface DemoMemorySessionOptions {
  readonly now?: () => Date;
}

export class DemoMemorySession {
  readonly #now: () => Date;
  #sequence = 0;
  readonly #records = new Map<string, ProtectionPlan>();

  constructor(options: DemoMemorySessionOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  save(plan: ProtectionPlan): DemoSaveReceipt {
    const preview = toProtectionPreview(plan);
    if (!preview.readyToSave) {
      throw new Error("Protection checks must pass before saving");
    }

    this.#sequence += 1;
    const suffix = String(this.#sequence).padStart(3, "0");
    const memoryId = `MEMORY_DEMO_${suffix}`;
    this.#records.set(memoryId, plan);

    return {
      memoryId,
      protectedMemoryId: `PROTECTED_MEMORY_DEMO_${suffix}`,
      credentialIds: plan.credentialDrafts.map((credential, index) =>
        `CREDENTIAL_${credential.entityType.toUpperCase()}_${suffix}_${String(index + 1).padStart(2, "0")}`
      ),
      savedAt: this.#now().toISOString(),
      storage: "memory_session",
      preview
    };
  }
}
