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
  AiConversationDraft,
  AiConversationEvent,
  AiConversationInput,
  AiConversationResponse
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
  })
]);

const responseTool: Tool = {
  name: "brainbuddy_respond",
  description: "Return the conversation response, references, proposed Memory operations, and other declarative intentions.",
  parameters: Type.Object({
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    references: Type.Array(Type.Object({
      kind: Type.Union([Type.Literal("source"), Type.Literal("credential"), Type.Literal("memory")]),
      id: Type.String({ minLength: 1, maxLength: 1_000 })
    }), { maxItems: 50 }),
    memoryOperations: Type.Array(Type.Union([
      Type.Object({
        operation: Type.Literal("create"),
        path: Type.String({ minLength: 1, maxLength: 1_000 }),
        content: Type.String({ minLength: 1, maxLength: 50_000 }),
        reason: Type.String({ minLength: 1, maxLength: 1_000 })
      }),
      Type.Object({
        operation: Type.Literal("update"),
        path: Type.String({ minLength: 1, maxLength: 1_000 }),
        expectedVersion: Type.String({ minLength: 64, maxLength: 64 }),
        content: Type.String({ minLength: 1, maxLength: 50_000 }),
        reason: Type.String({ minLength: 1, maxLength: 1_000 })
      })
    ]), { maxItems: 20 }),
    otherIntents: Type.Array(actionIntentSchema, { maxItems: 30 })
  })
};

const systemPrompt = `你是 BrainBuddy 的对话模型。用户可能提问、提供新信息，或希望更新本地记忆；不要预判用户意图。

规则：
1. 根据用户消息、Source、Credential 和 Memory 候选给出回复。
2. 不得猜测、还原或输出凭据原文。凭据引用保持锁定状态。
3. 必须调用 brainbuddy_respond 返回结构化结果。
4. 创建 Memory 时只能使用 memories/ 下的相对 Markdown 路径。
5. 更新 Memory 时只能选择上下文中已有的 Memory Path，并原样返回其 version 作为 expectedVersion。
6. Memory 内容如果来自某条 Source，必须保留 [SOURCE:<Source ID>]；涉及凭据时只保留 [CREDENTIAL:<Credential ID>]，不得写入原文。
7. memoryOperations 只是提案，必须由用户确认后才能应用。
8. 任意工具或非 Memory 文件意图放入 otherIntents，本次调用不会执行。
9. 只能引用本次上下文中出现的 Source ID、Credential ID 或 Memory Path。`;

export interface DeepSeekAiConversationEngineOptions {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface AiConversationRunOptions {
  readonly signal?: AbortSignal;
  readonly onEvent: (event: AiConversationEvent) => void;
}

export interface AiConversationEngine {
  prepare(input: AiConversationInput): AiConversationDraft;
  run(draft: AiConversationDraft, options: AiConversationRunOptions): Promise<void>;
}

export function createDeepSeekAiConversationEngine(options: DeepSeekAiConversationEngineOptions): AiConversationEngine {
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
        toolChoice: { type: "function", function: { name: responseTool.name } },
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
          const validation = validateResponse(event.message, draft.candidateIds, draft.conversationSourceId);
          runOptions.onEvent({
            type: "completed",
            at: at(),
            stopReason: event.message.stopReason,
            rawMessage: cloneJson(event.message) as Readonly<Record<string, unknown>>,
            ...(validation.response ? { response: validation.response } : {}),
            ...(validation.error ? { validationError: validation.error } : {})
          });
        } else if (event.type === "error") {
          runOptions.onEvent({
            type: "failed",
            at: at(),
            reason: event.reason,
            message: event.error.errorMessage || (event.reason === "aborted" ? "对话已取消" : "DeepSeek 调用失败"),
            rawMessage: cloneJson(event.error) as Readonly<Record<string, unknown>>
          });
        }
      }
    }
  };
}

function buildDraft(
  input: AiConversationInput,
  model: Model<"openai-completions">,
  now: () => Date,
  idFactory: () => string
): AiConversationDraft {
  const conversationSource = {
    sourceId: input.conversationSource.sourceId,
    kind: input.conversationSource.kind,
    protectedContent: input.conversationSource.protectedContent,
    credentialIds: input.conversationSource.credentialIds,
    savedAt: input.conversationSource.savedAt
  };
  const sources = input.sources.slice(0, MAX_SOURCES).map(({ sourceId, kind, protectedContent, credentialIds, savedAt }) => ({
    sourceId, kind, protectedContent, credentialIds, savedAt
  }));
  const credentials = input.credentials.slice(0, MAX_CREDENTIALS).map(({ credentialId, entityType, maskedValue, sourceIds, savedAt }) => ({
    credentialId, entityType, maskedValue, sourceIds, savedAt
  }));
  const memories = input.memories.map(({ path, content, sourceIds, credentialIds, updatedAt, version }) => ({
    path, content, sourceIds, credentialIds, updatedAt, version
  }));
  const candidateIds = [...new Set([
    conversationSource.sourceId,
    ...sources.map(({ sourceId }) => sourceId),
    ...credentials.map(({ credentialId }) => credentialId),
    ...memories.map(({ path }) => path)
  ])];
  const context: Context = {
    systemPrompt,
    messages: [{
      role: "user",
      timestamp: now().getTime(),
      content: [
        "用户消息（已按用户选择的本地策略处理）：",
        input.message,
        "",
        "可引用的本地候选：",
        JSON.stringify({ conversationSource, sources, credentials, memories }, null, 2)
      ].join("\n")
    }],
    tools: [responseTool]
  };
  return {
    draftId: idFactory(),
    provider: "deepseek",
    model: model.id,
    createdAt: now().toISOString(),
    conversationSourceId: input.conversationSource.sourceId,
    candidateIds,
    memories,
    context: cloneJson(context) as Readonly<Record<string, unknown>>
  };
}

function validateResponse(
  message: AssistantMessage,
  candidateIds: readonly string[],
  conversationSourceId: string
): { readonly response?: AiConversationResponse; readonly error?: string } {
  const toolCalls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
  const responseCalls = toolCalls.filter((toolCall) => toolCall.name === responseTool.name);
  if (responseCalls.length !== 1) {
    return { error: `期望 1 个 ${responseTool.name} 调用，实际收到 ${responseCalls.length} 个` };
  }
  try {
    const parsed = validateToolCall([responseTool], responseCalls[0]!) as AiConversationResponse;
    const allowed = new Set(candidateIds);
    const unknown = parsed.references.find(({ id }) => !allowed.has(id));
    if (unknown) return { error: `模型引用了本次候选之外的 ${unknown.kind}：${unknown.id}` };
    for (const operation of parsed.memoryOperations) {
      const unknownContentReference = contentReferences(operation.content).find((id) => !allowed.has(id));
      if (unknownContentReference) return { error: `Memory 提案包含本次候选之外的引用：${unknownContentReference}` };
    }
    const invalidUpdate = parsed.memoryOperations.find((operation) => operation.operation === "update" && !allowed.has(operation.path));
    if (invalidUpdate) return { error: `模型试图更新本次上下文之外的 Memory：${invalidUpdate.path}` };
    return {
      response: {
        ...parsed,
        memoryOperations: parsed.memoryOperations.map((operation) => ({
          ...operation,
          content: appendSourceReference(operation.content, conversationSourceId)
        })),
        otherIntents: parsed.otherIntents.map(normalizeAction)
      }
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "模型返回的结构不符合约定" };
  }
}

function contentReferences(content: string): readonly string[] {
  return [...content.matchAll(/\[(?:SOURCE|CREDENTIAL):(.+?)\]/gu)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
}

function appendSourceReference(content: string, sourceId: string): string {
  const reference = `[SOURCE:${sourceId}]`;
  return content.includes(reference) ? content : `${content.trimEnd()}\n\n来源：${reference}`;
}

function normalizeAction(action: AiActionIntent): AiActionIntent {
  return cloneJson(action) as AiActionIntent;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}
