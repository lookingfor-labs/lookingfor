import type {
  CredentialDraft,
  DetectedEntity,
  EntityType,
  ProtectionDecision,
  ProtectionPlan,
  ProtectionPreview,
  ProtectionPolicy,
  SafetyCheck
} from "@brainbuddy/domain";

const credentialTypes: ReadonlySet<EntityType> = new Set([
  "password",
  "api_key",
  "private_key",
  "github_token",
  "jwt",
  "high_entropy_secret"
]);

export interface BuildProtectionPlanInput {
  readonly text: string;
  readonly entities: readonly DetectedEntity[];
  readonly decisions: readonly ProtectionDecision[];
}

export function buildProtectionPlan(input: BuildProtectionPlanInput): ProtectionPlan {
  const entities = [...input.entities].sort((left, right) => left.start - right.start);
  const decisionMap = new Map(
    input.decisions.map((decision) => [entityKey(decision), decision.policy])
  );
  if (input.decisions.length !== entities.length || decisionMap.size !== entities.length) {
    throw new Error("Every detected entity requires one protection decision");
  }

  let cursor = 0;
  let memoryContent = "";
  let protectedContent = "";
  const credentialDrafts: CredentialDraft[] = [];
  const credentialCounts = new Map<EntityType, number>();

  for (const entity of entities) {
    validateEntity(input.text, entity, cursor);
    const policy = decisionMap.get(entityKey(entity));
    if (!policy) {
      throw new Error("Every detected entity requires one protection decision");
    }
    if (policy === "move_to_vault" && !credentialTypes.has(entity.type)) {
      throw new Error("Only credential entities can move to the vault");
    }

    const token = replacementToken(entity, policy, credentialCounts);
    memoryContent += input.text.slice(cursor, entity.start);
    memoryContent += memoryValue(entity, policy, token);
    protectedContent += input.text.slice(cursor, entity.start);
    protectedContent += protectedValue(entity, policy, token);

    if (policy === "move_to_vault") {
      credentialDrafts.push({
        ref: token,
        entityType: entity.type,
        secret: entity.text,
        maskedValue: maskSecret(entity.text)
      });
    }
    cursor = entity.end;
  }

  memoryContent += input.text.slice(cursor);
  protectedContent += input.text.slice(cursor);
  const safetyChecks = buildSafetyChecks(
    entities,
    credentialDrafts,
    memoryContent,
    protectedContent
  );

  return { memoryContent, protectedContent, credentialDrafts, safetyChecks };
}

export function entityKey(entity: Pick<DetectedEntity, "start" | "end">): string {
  return `${entity.start}:${entity.end}`;
}

export function toProtectionPreview(plan: ProtectionPlan): ProtectionPreview {
  return {
    memoryContent: plan.memoryContent,
    protectedContent: plan.protectedContent,
    credentials: plan.credentialDrafts.map(({ ref, entityType, maskedValue }) => ({
      ref,
      entityType,
      maskedValue
    })),
    safetyChecks: plan.safetyChecks,
    readyToSave: plan.safetyChecks.every((check) => check.passed)
  };
}

function validateEntity(text: string, entity: DetectedEntity, cursor: number): void {
  if (entity.start < cursor || entity.end > text.length || text.slice(entity.start, entity.end) !== entity.text) {
    throw new Error("Detected entity positions do not match the input text");
  }
}

function replacementToken(
  entity: DetectedEntity,
  policy: ProtectionPolicy,
  credentialCounts: Map<EntityType, number>
): string {
  const base = entity.replacementToken ?? `[${entity.type.toUpperCase()}]`;
  if (policy !== "move_to_vault") return base;

  const count = (credentialCounts.get(entity.type) ?? 0) + 1;
  credentialCounts.set(entity.type, count);
  if (count === 1) return base;
  return base.endsWith("]") ? `${base.slice(0, -1)}_${count}]` : `${base}_${count}`;
}

function memoryValue(entity: DetectedEntity, policy: ProtectionPolicy, token: string): string {
  return policy === "replace_with_token" || policy === "move_to_vault" ? token : entity.text;
}

function protectedValue(entity: DetectedEntity, policy: ProtectionPolicy, token: string): string {
  const mustProtect = entity.risk === "critical" || entity.risk === "high";
  return policy === "keep_original" && !mustProtect ? entity.text : token;
}

function buildSafetyChecks(
  entities: readonly DetectedEntity[],
  credentials: readonly CredentialDraft[],
  memoryContent: string,
  protectedContent: string
): SafetyCheck[] {
  const memorySecretFree = credentials.every((credential) => !memoryContent.includes(credential.secret));
  const protectedViewSecretFree = entities
    .filter((entity) => entity.risk === "critical" || entity.risk === "high")
    .every((entity) => !protectedContent.includes(entity.text));
  const refsResolved = credentials.every(
    (credential) => memoryContent.includes(credential.ref) && protectedContent.includes(credential.ref)
  );

  return [
    {
      id: "memory_secret_free",
      label: "普通记忆正文不包含已抽离 Secret",
      passed: memorySecretFree,
      detail: memorySecretFree ? "已抽离的凭证只存在于凭证草稿" : "普通记忆正文仍包含已抽离凭证"
    },
    {
      id: "protected_view_secret_free",
      label: "AI 可见版本不包含高风险原文",
      passed: protectedViewSecretFree,
      detail: protectedViewSecretFree ? "严重和高风险内容均已替换" : "AI 可见版本仍包含高风险内容"
    },
    {
      id: "credential_refs_resolved",
      label: "凭证引用可追踪",
      passed: refsResolved,
      detail: refsResolved ? "记忆与 AI 视图均保留对应凭证引用" : "存在无法追踪的凭证引用"
    }
  ];
}

function maskSecret(secret: string): string {
  if (secret.length <= 6) return "••••••";
  return `${secret.slice(0, 3)}${"•".repeat(Math.min(12, secret.length - 5))}${secret.slice(-2)}`;
}
