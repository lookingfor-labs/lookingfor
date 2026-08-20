import type {
  CredentialDraft,
  DetectedEntity,
  ProtectionDecision,
  ProtectionPlan,
  ProtectionPreview,
  SafetyCheck
} from "@brainbuddy/domain";
import { isCredentialId } from "./credential-id";

export interface BuildProtectionPlanInput {
  readonly text: string;
  readonly entities: readonly DetectedEntity[];
  readonly decisions: readonly ProtectionDecision[];
  readonly credentialIdFactory: () => string;
}

export function buildProtectionPlan(input: BuildProtectionPlanInput): ProtectionPlan {
  const entities = [...input.entities].sort((left, right) => left.start - right.start);
  const decisionMap = new Map(
    input.decisions.map((decision) => [entityKey(decision), decision])
  );
  if (input.decisions.length !== entities.length || decisionMap.size !== entities.length) {
    throw new Error("Every detected entity requires one protection decision");
  }

  let cursor = 0;
  let protectedContent = "";
  const credentialDrafts: CredentialDraft[] = [];
  const credentialIds = new Set<string>();

  for (const entity of entities) {
    validateEntity(input.text, entity, cursor);
    const decision = decisionMap.get(entityKey(entity));
    if (!decision) {
      throw new Error("Every detected entity requires one protection decision");
    }
    const { policy } = decision;
    const credentialId = policy === "move_to_vault"
      ? decision.credentialId ?? input.credentialIdFactory()
      : undefined;
    if (credentialId && (!isCredentialId(credentialId) || credentialIds.has(credentialId))) {
      throw new Error("Credential ids must be unique UUIDs");
    }
    if (credentialId) credentialIds.add(credentialId);

    const token = policy === "move_to_vault"
      ? `[CREDENTIAL:${credentialId}]`
      : entity.replacementToken ?? `[${entity.type.toUpperCase()}]`;
    protectedContent += input.text.slice(cursor, entity.start);
    protectedContent += protectedValue(entity, policy, token);

    if (policy === "move_to_vault" && credentialId) {
      credentialDrafts.push({
        credentialId,
        ref: token,
        start: entity.start,
        end: entity.end,
        entityType: entity.type,
        secret: entity.text,
        maskedValue: maskSecret(entity.text)
      });
    }
    cursor = entity.end;
  }

  protectedContent += input.text.slice(cursor);
  const safetyChecks = buildSafetyChecks(
    credentialDrafts,
    protectedContent
  );

  return { protectedContent, credentialDrafts, safetyChecks };
}

export function entityKey(entity: Pick<DetectedEntity, "start" | "end">): string {
  return `${entity.start}:${entity.end}`;
}

export function toProtectionPreview(plan: ProtectionPlan): ProtectionPreview {
  return {
    protectedContent: plan.protectedContent,
    credentials: plan.credentialDrafts.map(({ credentialId, ref, start, end, entityType, maskedValue }) => ({
      credentialId,
      ref,
      start,
      end,
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

function protectedValue(entity: DetectedEntity, policy: ProtectionDecision["policy"], token: string): string {
  return policy === "move_to_vault" ? token : entity.text;
}

function buildSafetyChecks(
  credentials: readonly CredentialDraft[],
  protectedContent: string
): SafetyCheck[] {
  const protectedContentSecretFree = credentials.every((credential) => !protectedContent.includes(credential.secret));
  const refsResolved = credentials.every((credential) => protectedContent.includes(credential.ref));

  return [
    {
      id: "protected_content_secret_free",
      label: "AI 可见输入不包含已抽离 Secret",
      passed: protectedContentSecretFree,
      detail: protectedContentSecretFree ? "已抽离的凭据只存在于凭据草稿" : "AI 可见输入仍包含已抽离凭据"
    },
    {
      id: "credential_refs_resolved",
      label: "凭证引用可追踪",
      passed: refsResolved,
      detail: refsResolved ? "AI 可见输入保留对应凭据引用" : "存在无法追踪的凭据引用"
    }
  ];
}

function maskSecret(secret: string): string {
  if (secret.length <= 6) return "••••••";
  return `${secret.slice(0, 3)}${"•".repeat(Math.min(12, secret.length - 5))}${secret.slice(-2)}`;
}
