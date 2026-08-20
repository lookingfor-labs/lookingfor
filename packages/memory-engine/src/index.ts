import type {
  CredentialDraft,
  DemoCredentialSummary,
  DemoOfflineSearchResult,
  DemoSourceSummary,
  DemoSaveReceipt,
  DemoSourceReveal,
  ProtectionPlan,
  SourceSubmissionKind
} from "@brainbuddy/domain";
import { findCredentialReferences, toProtectionPreview } from "@brainbuddy/privacy-engine";

export interface DemoSourceSessionOptions {
  readonly now?: () => Date;
}

export class DemoSourceSession {
  readonly #now: () => Date;
  #sequence = 0;
  readonly #credentials = new Map<string, { readonly draft: CredentialDraft; readonly sourceIds: string[]; readonly savedAt: string }>();
  readonly #summaries = new Map<string, DemoSourceSummary>();
  readonly #sources = new Map<string, DemoSourceReveal>();

  constructor(options: DemoSourceSessionOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  save(plan: ProtectionPlan, originalContent: string, kind: SourceSubmissionKind = "capture"): DemoSaveReceipt {
    const initialPreview = toProtectionPreview(plan);
    if (!initialPreview.readyToSave) {
      throw new Error("Protection checks must pass before saving");
    }
    if (plan.credentialDrafts.some((credential) => {
      const existing = this.#credentials.get(credential.credentialId);
      return existing && existing.draft.secret !== credential.secret;
    })) {
      throw new Error("A credential id cannot identify different secrets");
    }

    const resolvedCredentials = plan.credentialDrafts.map((credential) => {
      const existing = [...this.#credentials.values()].find(({ draft }) => draft.secret === credential.secret);
      return existing
        ? { ...credential, credentialId: existing.draft.credentialId, ref: existing.draft.ref }
        : credential;
    });
    const protectedContent = plan.credentialDrafts.reduce((content, credential, index) => {
      const resolved = resolvedCredentials[index];
      return resolved ? content.replaceAll(credential.ref, resolved.ref) : content;
    }, plan.protectedContent);
    const credentialIds = [...new Set(findCredentialReferences(protectedContent).map(({ credentialId }) => credentialId))];
    const availableCredentialIds = new Set([
      ...this.#credentials.keys(),
      ...resolvedCredentials.map(({ credentialId }) => credentialId)
    ]);
    const unknownCredentialId = credentialIds.find((credentialId) => !availableCredentialIds.has(credentialId));
    if (unknownCredentialId) throw new Error(`Credential reference does not exist: ${unknownCredentialId}`);

    this.#sequence += 1;
    const suffix = String(this.#sequence).padStart(3, "0");
    const sourceId = `SOURCE_DEMO_${suffix}`;
    const savedAt = this.#now().toISOString();
    const storedPlan = {
      ...plan,
      protectedContent: `${protectedContent}\n\n来源：[SOURCE:${sourceId}]`,
      credentialDrafts: resolvedCredentials
    };
    const preview = toProtectionPreview(storedPlan);
    resolvedCredentials.forEach((credential) => {
      const existing = this.#credentials.get(credential.credentialId);
      if (!existing) this.#credentials.set(credential.credentialId, { draft: credential, sourceIds: [], savedAt });
    });
    credentialIds.forEach((credentialId) => {
      const credential = this.#credentials.get(credentialId)!;
      if (!credential.sourceIds.includes(sourceId)) credential.sourceIds.push(sourceId);
    });
    this.#sources.set(sourceId, { sourceId, kind, originalContent, savedAt });
    this.#summaries.set(sourceId, { sourceId, kind, protectedContent: storedPlan.protectedContent, credentialIds, savedAt });

    return {
      sourceId,
      kind,
      credentialIds,
      savedAt,
      storage: "memory_session",
      preview
    };
  }

  search(query: string): readonly DemoSourceSummary[] {
    return this.searchOffline(query).sources;
  }

  searchOffline(query: string, excludeSourceId?: string): DemoOfflineSearchResult {
    const normalized = query.trim().toLocaleLowerCase();
    const sources = [...this.#summaries.values()].filter((summary) =>
      summary.sourceId !== excludeSourceId && (!normalized || [summary.sourceId, summary.kind, summary.protectedContent, ...summary.credentialIds]
        .some((value) => value.toLocaleLowerCase().includes(normalized))
      )
    );
    const matchingSourceIds = new Set(sources.map((source) => source.sourceId));
    const credentials: DemoCredentialSummary[] = [...this.#credentials.values()]
      .filter(({ draft, sourceIds }) => !normalized
        || [draft.credentialId, draft.entityType, draft.maskedValue]
          .some((value) => value.toLocaleLowerCase().includes(normalized))
        || sourceIds.some((sourceId) => matchingSourceIds.has(sourceId)))
      .map(({ draft, sourceIds, savedAt }) => ({
        credentialId: draft.credentialId,
        entityType: draft.entityType,
        maskedValue: draft.maskedValue,
        sourceIds: [...sourceIds],
        savedAt
      }));
    return { sources, credentials };
  }

  revealSource(sourceId: string): DemoSourceReveal {
    const source = this.#sources.get(sourceId);
    if (!source) throw new Error("Source record not found");
    return source;
  }
}
