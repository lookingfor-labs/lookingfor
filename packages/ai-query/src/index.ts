import { randomUUID } from "node:crypto";
import {
  Type,
  createModels,
  validateToolCall,
  type AssistantMessage,
  type Context,
  type Model,
  type Tool,
  type ToolCall
} from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import type {
  AiActionIntent,
  AiQueryAnswer,
  AiQueryDraft,
  AiQueryEvent,
  AiQueryInput
} from "@brainbuddy/domain";

const DEFAULT_MODEL = "deepseek-v4-flash";
const MAX_SOURCES = 16;
const MAX_CREDENTIALS = 16;

const actionIntentSchema = Type.Union([
  Type.Object({
    kind: Type.Literal("tool_call"),
    toolName: Type.String({ minLength: 1, maxLength: 120 }),
    arguments: Type.Record(Type.String(), Type.Unknown()),
    reason: Type.String({ minLength: 1, maxLength: 1_000 })
  }),
  Type.Object({
    kind: Type.Literal("file_read"),
    path: Type.String({ minLength: 1, maxLength: 1_000 }),
    reason: Type.String({ minLength: 1, maxLength: 1_000 })
  }),
  Type.Object({
    kind: Type.Literal("file_write"),
    path: Type.String({ minLength: 1, maxLength: 1_000 }),
    contentSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
    reason: Type.String({ minLength: 1, maxLength: 1_000 })
  }),
  Type.Object({
    kind: Type.Union([Type.Literal("memory_create"), Type.Literal("memory_update")]),
    target: Type.Optional(Type.String({ minLength: 1, maxLength: 1_000 })),
    contentSummary: Type.String({ minLength: 1, maxLength: 2_000 }),
    reason: Type.String({ minLength: 1, maxLength: 1_000 })
  })
]);

const answerTool: Tool = {
  name: "brainbuddy_answer",
  description: "Return the answer, local references, and declarative action intentions. Actions are observed only and will not be executed.",
  parameters: Type.Object({
    answer: Type.String({ minLength: 1, maxLength: 20_000 }),
    references: Type.Array(Type.Object({
      kind: Type.Union([Type.Literal("source"), Type.Literal("credential"), Type.Literal("memory")]),
      id: Type.String({ minLength: 1, maxLength: 1_000 })
    }), { maxItems: 50 }),
    proposedActions: Type.Array(actionIntentSchema, { maxItems: 30 })
  })
};

const systemPrompt = `你是 BrainBuddy 的单次查询模型。请根据用户问题和本地候选给出答案。

规则：
1. 只能引用本次上下文中出现的 Source ID、Credential ID 或 Memory 路径。
2. 不得猜测、还原或输出凭据原文。凭据引用保持锁定状态。
3. 必须调用 brainbuddy_answer 返回结构化结果。
4. 如果你认为后续需要调用工具、读取文件、写入文件或修改 Memory，请把它写入 proposedActions。
5. proposedActions 只是声明式意图，系统不会在本次调用中执行。
6. 如果现有候选不足以回答，请明确说明，并返回空 references。`;

export interface DeepSeekAiQueryEngineOptions {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface AiQueryRunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent: (event: AiQueryEvent) => void;
}

export interface AiQueryEngine {
  prepare(input: AiQueryInput): AiQueryDraft;
  run(draft: AiQueryDraft, options: AiQueryRunOptions): Promise<void>;
}

export function createDeepSeekAiQueryEngine(options: DeepSeekAiQueryEngineOptions): AiQueryEngine {
  if (!options.apiKey.trim()) throw new Error("SECRET_DEEPSEEK_API_KEY is not configured");
  const models = createModels();
  const provider = deepseekProvider();
  models.setProvider(provider);
  const modelId = options.modelId?.trim() || DEFAULT_MODEL;
  const model = provider.getModels().find(({ id }) => id === modelId);
  if (!model) throw new Error(`DeepSeek model is not available: ${modelId}`);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;

  return {
    prepare(input) {
      return buildDraft(input, model, now, idFactory);
    },
    async run(draft, runOptions) {
      const at = () => now().toISOString();
      runOptions.onEvent({ type: "started", at: at() });
      const context = draft.context as unknown as Context;
      const stream = models.stream(model, context, {
        apiKey: options.apiKey,
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
        toolChoice: { type: "function", function: { name: answerTool.name } },
        temperature: 0.2,
        maxTokens: 4_096,
        timeoutMs: 60_000,
        maxRetries: 1,
        onPayload: (payload) => {
          runOptions.onEvent({ type: "provider_payload", at: at(), payload: cloneJson(payload) });
        }
      });

      for await (const event of stream) {
        if (event.type === "text_delta") {
          runOptions.onEvent({ type: "text_delta", at: at(), contentIndex: event.contentIndex, delta: event.delta });
        } else if (event.type === "thinking_delta") {
          runOptions.onEvent({ type: "thinking_delta", at: at(), contentIndex: event.contentIndex, delta: event.delta });
        } else if (event.type === "toolcall_end") {
          runOptions.onEvent({
            type: "tool_call",
            at: at(),
            contentIndex: event.contentIndex,
            toolCall: cloneJson(event.toolCall) as Readonly<Record<string, unknown>>
          });
        } else if (event.type === "done") {
          const validation = validateAnswer(event.message, draft.candidateIds);
          runOptions.onEvent({
            type: "completed",
            at: at(),
            stopReason: event.message.stopReason,
            rawMessage: cloneJson(event.message) as Readonly<Record<string, unknown>>,
            ...(validation.answer ? { answer: validation.answer } : {}),
            ...(validation.error ? { validationError: validation.error } : {})
          });
        } else if (event.type === "error") {
          runOptions.onEvent({
            type: "failed",
            at: at(),
            reason: event.reason,
            message: event.error.errorMessage || (event.reason === "aborted" ? "查询已取消" : "DeepSeek 调用失败"),
            rawMessage: cloneJson(event.error) as Readonly<Record<string, unknown>>
          });
        }
      }
    }
  };
}

function buildDraft(
  input: AiQueryInput,
  model: Model<"openai-completions">,
  now: () => Date,
  idFactory: () => string
): AiQueryDraft {
  const sources = input.sources.slice(0, MAX_SOURCES).map(({ sourceId, kind, protectedContent, credentialIds, savedAt }) => ({
    sourceId, kind, protectedContent, credentialIds, savedAt
  }));
  const credentials = input.credentials.slice(0, MAX_CREDENTIALS).map(({ credentialId, entityType, maskedValue, sourceIds, savedAt }) => ({
    credentialId, entityType, maskedValue, sourceIds, savedAt
  }));
  const candidateIds = [...new Set([
    ...sources.map(({ sourceId }) => sourceId),
    ...credentials.map(({ credentialId }) => credentialId)
  ])];
  const context: Context = {
    systemPrompt,
    messages: [{
      role: "user",
      timestamp: now().getTime(),
      content: [
        "用户问题（已按用户选择的本地策略处理）：",
        input.query,
        "",
        "可引用的本地候选：",
        JSON.stringify({ sources, credentials }, null, 2)
      ].join("\n")
    }],
    tools: [answerTool]
  };
  return {
    draftId: idFactory(),
    provider: "deepseek",
    model: model.id,
    createdAt: now().toISOString(),
    querySourceId: input.querySource.sourceId,
    candidateIds,
    context: cloneJson(context) as Readonly<Record<string, unknown>>
  };
}

function validateAnswer(
  message: AssistantMessage,
  candidateIds: readonly string[]
): { readonly answer?: AiQueryAnswer; readonly error?: string } {
  const toolCalls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
  const answerCalls = toolCalls.filter((toolCall) => toolCall.name === answerTool.name);
  if (answerCalls.length !== 1) {
    return { error: `期望 1 个 ${answerTool.name} 调用，实际收到 ${answerCalls.length} 个` };
  }
  try {
    const parsed = validateToolCall([answerTool], answerCalls[0]!) as AiQueryAnswer;
    const allowed = new Set(candidateIds);
    const unknown = parsed.references.find(({ id }) => !allowed.has(id));
    if (unknown) return { error: `模型引用了本次候选之外的 ${unknown.kind}：${unknown.id}` };
    return { answer: { ...parsed, proposedActions: parsed.proposedActions.map(normalizeAction) } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "模型返回的结构不符合约定" };
  }
}

function normalizeAction(action: AiActionIntent): AiActionIntent {
  return cloneJson(action) as AiActionIntent;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
