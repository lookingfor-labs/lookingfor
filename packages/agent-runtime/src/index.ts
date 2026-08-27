import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent, type AgentEvent, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { Type } from "typebox";
import type {
  DemoCredentialSummary,
  DemoSourceSummary,
  MemoryFile,
  MemoryEdit,
  MemoryWriteRequest,
  PreparedMemoryWrite,
  MemoryWritePolicy
} from "@brainbuddy/domain";
import type { MemoryStore } from "@brainbuddy/memory-engine/memory";

const MAX_LOCAL_TOOL_BATCHES = 6;
const MAX_LOCAL_TOOL_CALLS = 16;
const MAX_MODEL_REQUESTS = 10;
const MAX_FINISH_ATTEMPTS = 2;
const MAX_MEMORY_CONTENT_LENGTH = 50_000;
const searchSchema = Type.Object({
  query: Type.String({ maxLength: 2_000 }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
});
const readMemorySchema = Type.Object({ path: Type.String({ minLength: 1, maxLength: 1_000 }) });
const finishSchema = Type.Object({
  message: Type.String({ minLength: 1, maxLength: 20_000 }),
  references: Type.Array(Type.Object({
    kind: Type.Union([Type.Literal("source"), Type.Literal("credential"), Type.Literal("memory")]),
    id: Type.String({ minLength: 1, maxLength: 1_000 })
  }), { maxItems: 50 })
});
const memoryEditSchema = Type.Union([
  Type.Object({ type: Type.Literal("replace"), oldText: Type.String(), newText: Type.String() }),
  Type.Object({
    type: Type.Union([Type.Literal("insert_before"), Type.Literal("insert_after")]),
    anchor: Type.String({ minLength: 1 }),
    content: Type.String()
  }),
  Type.Object({ type: Type.Literal("append"), content: Type.String() })
]);
const writeMemorySchema = Type.Object({
  operation: Type.Union([Type.Literal("create"), Type.Literal("edit")]),
  path: Type.String({ minLength: 1, maxLength: 1_000 }),
  content: Type.Optional(Type.String({ minLength: 1, maxLength: 50_000 })),
  expectedVersion: Type.Optional(Type.String({ minLength: 66, maxLength: 100 })),
  edits: Type.Optional(Type.Array(memoryEditSchema, { minItems: 1, maxItems: 50 })),
  reason: Type.String({ minLength: 1, maxLength: 1_000 })
});

export interface ProtectedRecordSearchResult {
  readonly sources: readonly DemoSourceSummary[];
  readonly credentials: readonly DemoCredentialSummary[];
  readonly total: number;
  readonly truncated: boolean;
}

export interface ProtectedRecordReader {
  search(query: string, limit: number): ProtectedRecordSearchResult;
  sourceExists(sourceId: string): boolean;
  credentialExists(credentialId: string): boolean;
}

export interface PrepareAgentRunInput {
  readonly message: string;
  readonly conversationSourceId: string;
  readonly writePolicy: MemoryWritePolicy;
}

export type MemoryIntent =
  | { readonly type: "no_write_required" }
  | {
      readonly type: "durable_fact";
      readonly requiredSourceId: string;
      readonly requiredCredentialIds: readonly string[];
    };

export interface AgentRunDraft extends PrepareAgentRunInput {
  readonly draftId: string;
  readonly createdAt: string;
  readonly memoryIntent: MemoryIntent;
}

export interface AgentRunBudgets {
  readonly toolBatchCount: number;
  readonly toolCallCount: number;
  readonly modelRequestCount: number;
  readonly finishAttemptCount: number;
}

export type AgentReference = {
  readonly kind: "source" | "credential" | "memory";
  readonly id: string;
};

export type AgentRunResult =
  | {
      readonly status: "completed";
      readonly message: string;
      readonly references: readonly AgentReference[];
      readonly budgets: AgentRunBudgets;
    }
  | {
      readonly status: "failed" | "cancelled";
      readonly code: string;
      readonly message: string;
      readonly budgets: AgentRunBudgets;
    };

export type AgentRuntimeEvent =
  | { readonly type: "agent_started"; readonly runId: string }
  | { readonly type: "turn_started"; readonly runId: string; readonly modelRequestCount: number }
  | { readonly type: "provider_payload"; readonly runId: string; readonly payload: unknown }
  | { readonly type: "model_message_delta"; readonly runId: string; readonly delta: string }
  | { readonly type: "model_message"; readonly runId: string; readonly message: unknown }
  | { readonly type: "tool_call"; readonly runId: string; readonly toolCallId: string; readonly toolName: string; readonly args: unknown }
  | { readonly type: "tool_result"; readonly runId: string; readonly toolCallId: string; readonly toolName: string; readonly result: unknown; readonly isError: boolean }
  | { readonly type: "approval_required"; readonly runId: string; readonly toolCallId: string; readonly prepared: PreparedMemoryWrite }
  | { readonly type: "approved" | "denied" | "auto_applied"; readonly runId: string; readonly approvalId: string }
  | { readonly type: "memory_changed"; readonly runId: string; readonly toolCallId: string; readonly memory: MemoryFile; readonly revisionId: string }
  | { readonly type: "turn_completed"; readonly runId: string }
  | { readonly type: "agent_completed"; readonly runId: string; readonly result: AgentRunResult }
  | { readonly type: "agent_failed" | "agent_cancelled"; readonly runId: string; readonly result: AgentRunResult };

export interface AgentRunHandle {
  readonly runId: string;
  readonly done: Promise<AgentRunResult>;
}

export interface AgentRunAuditSnapshot {
  readonly runId: string;
  readonly recordedAt: string;
  readonly provider: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly draft: AgentRunDraft;
  readonly limits: {
    readonly localToolBatches: number;
    readonly localToolCalls: number;
    readonly modelRequests: number;
    readonly finishAttempts: number;
  };
}

export interface AgentRunRecorder {
  start(snapshot: AgentRunAuditSnapshot): void;
  record(recordedAt: string, event: AgentRuntimeEvent): void;
}

export interface ApprovalResolution {
  readonly status: "approved" | "denied" | "expired";
}

export interface SafeToolError {
  readonly code:
    | "AMBIGUOUS_MATCH"
    | "FINISH_MUST_BE_EXCLUSIVE"
    | "INVALID_PATH"
    | "INVALID_WRITE_REQUEST"
    | "LIMIT_EXCEEDED"
    | "MEMORY_WRITE_REQUIRED"
    | "MEMORY_NOT_FOUND"
    | "REFERENCE_NOT_SEEN"
    | "REQUIRED_REFERENCE_MISSING"
    | "RUN_CANCELLED"
    | "VERSION_CONFLICT"
    | "TOOL_FAILED";
  readonly message: string;
  readonly retryable: boolean;
}

export interface AgentRuntime {
  prepare(input: PrepareAgentRunInput): AgentRunDraft;
  start(draftId: string, onEvent: (event: AgentRuntimeEvent) => void): AgentRunHandle;
  resolveApproval(runId: string, approvalId: string, decision: "approve" | "deny"): Promise<ApprovalResolution>;
  cancel(runId: string): Promise<void>;
}

export interface CreateAgentRuntimeOptions {
  readonly model: Model<Api>;
  readonly streamFn: StreamFn;
  readonly records: ProtectedRecordReader;
  readonly memories: MemoryStore;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly getApiKey?: (provider: string) => string | undefined;
  readonly recorder?: AgentRunRecorder;
}

export function createFileAgentRunRecorder(options: {
  readonly directory: string;
  readonly now?: () => Date;
}): AgentRunRecorder {
  const now = options.now ?? (() => new Date());
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  chmodSync(options.directory, 0o700);
  const append = (runId: string, value: unknown) => {
    if (!/^[a-zA-Z0-9_-]+$/u.test(runId)) throw new Error("Agent Run ID is not safe for a record path");
    const path = join(options.directory, `${runId}.jsonl`);
    appendFileSync(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(path, 0o600);
  };
  return {
    start(snapshot) {
      append(snapshot.runId, { type: "run_snapshot", ...snapshot });
    },
    record(recordedAt, event) {
      append(event.runId, { type: "event", recordedAt: recordedAt || now().toISOString(), event });
    }
  };
}

export interface CreateDeepSeekAgentRuntimeOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly records: ProtectedRecordReader;
  readonly memories: MemoryStore;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly recorder?: AgentRunRecorder;
}

interface MutableBudgets {
  toolBatchCount: number;
  toolCallCount: number;
  modelRequestCount: number;
  finishAttemptCount: number;
}

type MemoryWriteOutcome = "none" | "pending" | "applied" | "denied";

interface RunState {
  readonly runId: string;
  readonly draft: AgentRunDraft;
  readonly seenSourceIds: Set<string>;
  readonly seenCredentialIds: Set<string>;
  readonly seenMemoryPaths: Set<string>;
  readonly countedBatches: Set<string>;
  memoryWriteOutcome: MemoryWriteOutcome;
  readonly budgets: MutableBudgets;
  readonly emit: (event: AgentRuntimeEvent) => void;
  agent?: Agent;
  finish?: { readonly message: string; readonly references: readonly AgentReference[] };
  cancelled: boolean;
}

interface PendingApproval {
  readonly runId: string;
  readonly prepared: PreparedMemoryWrite;
  readonly resolve: (decision: "approve" | "deny") => void;
  readonly reject: (error: Error) => void;
  readonly removeAbortListener: () => void;
}

class ApprovalGate {
  readonly #pending = new Map<string, PendingApproval>();

  wait(runId: string, prepared: PreparedMemoryWrite, signal?: AbortSignal): Promise<"approve" | "deny"> {
    if (this.#pending.has(prepared.approvalId)) return Promise.reject(new Error("APPROVAL_ALREADY_PENDING: Approval already exists"));
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(prepared.approvalId);
        reject(new Error("RUN_CANCELLED: Agent Run was cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(prepared.approvalId, {
        runId,
        prepared,
        resolve,
        reject,
        removeAbortListener: () => signal?.removeEventListener("abort", abort)
      });
    });
  }

  resolve(runId: string, approvalId: string, decision: "approve" | "deny"): ApprovalResolution {
    const pending = this.#pending.get(approvalId);
    if (!pending || pending.runId !== runId) return { status: "expired" };
    this.#pending.delete(approvalId);
    pending.removeAbortListener();
    pending.resolve(decision);
    return { status: decision === "approve" ? "approved" : "denied" };
  }

  cancelRun(runId: string): void {
    for (const [approvalId, pending] of this.#pending) {
      if (pending.runId !== runId) continue;
      this.#pending.delete(approvalId);
      pending.removeAbortListener();
      pending.reject(new Error("RUN_CANCELLED: Agent Run was cancelled"));
    }
  }
}

const systemPrompt = `你是 BrainBuddy 的受控本地 Agent。
使用已注册工具搜索受保护的本地记录与 Memory 文件；你无法读取 Source 原文或 Credential 明文。
你收到的是经过 BrainBuddy 本地保护层处理后的用户消息；其中部分原始值可能已经替换为 [CREDENTIAL:<id>]，它是原始值的有效不透明引用。
不要读取、猜测、恢复或重新创建 Credential 明文。保存长期信息时，必须把已有 [CREDENTIAL:<id>] 原样写入 Memory，并同时保留本轮 [SOURCE:<id>] 以便用户追溯原始记录。
用户陈述账号、密码、Key、Token 等可复用事实，或明确要求记住、记录、保存时，必须先用 write_memory 创建或更新 Memory，再结束 Run；不要求用户额外说“记住”。
用户只是在查找、查询或询问信息时，不得仅因消息中出现 Credential 或 Source 引用而新增 Memory。
如果消息中是邮箱原文，它就是 AI 可见的普通账号信息；只有 [CREDENTIAL:<id>] 才能描述为凭据，绝不能把邮箱自行声称为凭据。
最终回复只陈述本轮已完成的结果，不得提出问题、邀请继续回复，或声称还可以继续执行当前 Run。
你必须在完成任务后调用 brainbuddy_finish，并且它必须是该 AssistantMessage 中唯一的工具调用。
最终回复只能引用本 Run 已见过的 ID 与 Memory Path。不要只输出普通文本后结束。`;

export function requiresDurableMemory(message: string): boolean {
  if (/(?:记住|记录(?:一下)?|保存)|(?:账号|账户|邮箱|密码|(?:api[ _-]?)?key|token|密钥)\s*(?:是|为|有(?!什么|哪些|没有)|包括|包含)/iu.test(message)) return true;
  const containsCredentialReference = /\[CREDENTIAL:[^\]\r\n]+\]/u.test(message);
  const isQuery = /(?:查找|查询|搜索|找(?:到|一下)?|查看|有没有|有哪些|是什么|哪里|哪一个|哪个)/u.test(message);
  return containsCredentialReference && !isQuery;
}

function memoryIntentFor(message: string, conversationSourceId: string): MemoryIntent {
  if (!requiresDurableMemory(message)) return { type: "no_write_required" };
  return {
    type: "durable_fact",
    requiredSourceId: conversationSourceId,
    requiredCredentialIds: [...new Set([...message.matchAll(/\[CREDENTIAL:([^\]\r\n]+)\]/gu)].map((match) => match[1]!))]
  };
}

export function createAgentRuntime(options: CreateAgentRuntimeOptions): AgentRuntime {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const drafts = new Map<string, AgentRunDraft>();
  const runs = new Map<string, RunState>();
  const approvalGate = new ApprovalGate();

  return {
    prepare(input) {
      if (!input.message.trim()) throw new Error("Agent message cannot be empty");
      if (!options.records.sourceExists(input.conversationSourceId)) throw new Error("Conversation Source does not exist");
      if (input.writePolicy === "auto_apply" && !options.memories.revisionsAvailable()) {
        throw new Error("REVISION_STORE_UNAVAILABLE: Automatic Memory writes require Revisions");
      }
      const memoryIntent = memoryIntentFor(input.message, input.conversationSourceId);
      if (memoryIntent.type === "durable_fact") {
        const unknownCredentialId = memoryIntent.requiredCredentialIds.find((id) => !options.records.credentialExists(id));
        if (unknownCredentialId) throw new Error("Conversation contains an unknown Credential reference");
      }
      const draft = Object.freeze({ ...input, memoryIntent, draftId: idFactory(), createdAt: now().toISOString() });
      drafts.set(draft.draftId, draft);
      return draft;
    },
    start(draftId, onEvent) {
      const draft = drafts.get(draftId);
      if (!draft) throw new Error("Agent Run draft was not found or has expired");
      drafts.delete(draftId);
      const runId = idFactory();
      safelyRecord(() => options.recorder?.start({
        runId,
        recordedAt: now().toISOString(),
        provider: options.model.provider,
        model: options.model.id,
        systemPrompt,
        draft,
        limits: {
          localToolBatches: MAX_LOCAL_TOOL_BATCHES,
          localToolCalls: MAX_LOCAL_TOOL_CALLS,
          modelRequests: MAX_MODEL_REQUESTS,
          finishAttempts: MAX_FINISH_ATTEMPTS
        }
      }));
      const emit = (event: AgentRuntimeEvent) => {
        onEvent(event);
        safelyRecord(() => options.recorder?.record(now().toISOString(), event));
      };
      const state: RunState = {
        runId,
        draft,
        seenSourceIds: new Set([draft.conversationSourceId]),
        seenCredentialIds: new Set(draft.memoryIntent.type === "durable_fact" ? draft.memoryIntent.requiredCredentialIds : []),
        seenMemoryPaths: new Set(),
        countedBatches: new Set(),
        memoryWriteOutcome: "none",
        budgets: { toolBatchCount: 0, toolCallCount: 0, modelRequestCount: 0, finishAttemptCount: 0 },
        emit,
        cancelled: false
      };
      runs.set(runId, state);
      const done = runAgent(state, options, approvalGate).finally(() => runs.delete(runId));
      return { runId, done };
    },
    async resolveApproval(runId, approvalId, decision) {
      return approvalGate.resolve(runId, approvalId, decision);
    },
    async cancel(runId) {
      const state = runs.get(runId);
      if (!state) return;
      state.cancelled = true;
      approvalGate.cancelRun(runId);
      state.agent?.abort();
      await state.agent?.waitForIdle();
    }
  };
}

function safelyRecord(record: () => void): void {
  try {
    record();
  } catch {
    // Debug recording must never change Agent Run behavior.
  }
}

export function createDeepSeekAgentRuntime(options: CreateDeepSeekAgentRuntimeOptions): AgentRuntime {
  if (!options.apiKey.trim()) throw new Error("SECRET_DEEPSEEK_API_KEY is not configured");
  const models = createModels();
  const provider = deepseekProvider();
  models.setProvider(provider);
  const modelId = options.modelId?.trim() || "deepseek-v4-flash";
  const template = provider.getModels().find(({ id }) => id === modelId) ?? provider.getModels()[0];
  if (!template) throw new Error("DeepSeek model catalog is empty");
  const model = {
    ...template,
    id: modelId,
    name: modelId,
    baseUrl: options.baseUrl?.trim() || template.baseUrl
  };
  return createAgentRuntime({
    model,
    streamFn: models.streamSimple.bind(models),
    getApiKey: (providerId) => providerId === provider.id ? options.apiKey : undefined,
    records: options.records,
    memories: options.memories,
    ...(options.recorder ? { recorder: options.recorder } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.idFactory ? { idFactory: options.idFactory } : {})
  });
}

async function runAgent(state: RunState, options: CreateAgentRuntimeOptions, approvalGate: ApprovalGate): Promise<AgentRunResult> {
  const tools = createTools(state, options, approvalGate);
  const agent = new Agent({
    initialState: { systemPrompt, model: options.model, tools },
    streamFn: options.streamFn,
    ...(options.getApiKey ? { getApiKey: options.getApiKey } : {}),
    onPayload: (payload) => state.emit({ type: "provider_payload", runId: state.runId, payload: cloneSafe(payload) }),
    toolExecution: "sequential",
    beforeToolCall: async ({ assistantMessage }) => preflightBatch(state, assistantMessage),
    afterToolCall: async ({ result, isError }) => {
      const terminate = budgetExceeded(state);
      if (!isError) return terminate ? { terminate: true } : undefined;
      const error = safeToolError(result);
      return { ...safeToolResult(error), isError: true, terminate };
    }
  });
  state.agent = agent;
  agent.subscribe((event) => observeAgentEvent(state, event));
  state.emit({ type: "agent_started", runId: state.runId });
  try {
    await agent.prompt(state.draft.message);
  } catch {
    return finishFailed(state, "AGENT_RUNTIME_ERROR", "Agent Run failed safely");
  }
  if (state.cancelled) {
    const result: AgentRunResult = { status: "cancelled", code: "RUN_CANCELLED", message: "Agent Run was cancelled", budgets: budgets(state) };
    state.emit({ type: "agent_cancelled", runId: state.runId, result });
    return result;
  }
  if (agent.state.errorMessage) return finishFailed(state, "MODEL_REQUEST_FAILED", "The model request failed safely");
  if (!state.finish) return finishFailed(state, "FINISH_REQUIRED", "Agent did not produce a valid final response");
  const result: AgentRunResult = { status: "completed", ...state.finish, budgets: budgets(state) };
  state.emit({ type: "agent_completed", runId: state.runId, result });
  return result;
}

function createTools(state: RunState, options: CreateAgentRuntimeOptions, approvalGate: ApprovalGate): AgentTool[] {
  const searchLocalRecords: AgentTool<typeof searchSchema> = {
    name: "search_local_records",
    label: "Search protected local records",
    description: "Search protected Source records and masked Credential metadata.",
    parameters: searchSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = options.records.search(params.query, params.limit ?? 8);
      result.sources.forEach(({ sourceId, credentialIds }) => {
        state.seenSourceIds.add(sourceId);
        credentialIds.forEach((id) => state.seenCredentialIds.add(id));
      });
      result.credentials.forEach(({ credentialId, sourceIds }) => {
        state.seenCredentialIds.add(credentialId);
        sourceIds.forEach((id) => state.seenSourceIds.add(id));
      });
      return safeToolResult(result);
    }
  };
  const searchMemories: AgentTool<typeof searchSchema> = {
    name: "search_memories",
    label: "Search Memory files",
    description: "Search AI-readable local Memory files by path or content.",
    parameters: searchSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const query = params.query.toLocaleLowerCase();
      const matches = options.memories.list()
        .filter(({ path, content }) => path.toLocaleLowerCase().includes(query) || content.toLocaleLowerCase().includes(query))
        .slice(0, params.limit ?? 8)
        .map(memoryProjection);
      matches.forEach((memory) => seeMemory(state, memory));
      return safeToolResult({ memories: matches, truncated: matches.length === (params.limit ?? 8) });
    }
  };
  const readMemory: AgentTool<typeof readMemorySchema> = {
    name: "read_memory",
    label: "Read a Memory file",
    description: "Read one AI-visible Memory file by its controlled Memory Path.",
    parameters: readMemorySchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const memory = options.memories.list().find(({ path }) => path === params.path);
      if (!memory) throw new Error("MEMORY_NOT_FOUND: Memory was not found");
      seeMemory(state, memory);
      return safeToolResult(memoryProjection(memory));
    }
  };
  const writeMemory: AgentTool<typeof writeMemorySchema> = {
    name: "write_memory",
    label: "Write a Memory file",
    description: "Create or exactly edit one controlled Memory file. Preserve every existing [CREDENTIAL:<id>] as an opaque reference and include the current [SOURCE:<id>] for durable facts. Never recover or replace Credential plaintext. The active Run policy controls approval.",
    parameters: writeMemorySchema,
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const request = normalizeMemoryWrite(params);
      const prepared = options.memories.prepare(request);
      validatePreparedReferences(state, options, prepared);
      validateRequiredMemoryReferences(state, prepared);
      if (state.memoryWriteOutcome !== "applied") state.memoryWriteOutcome = "pending";
      const autoApply = state.draft.writePolicy === "auto_apply";
      if (!autoApply) {
        state.emit({ type: "approval_required", runId: state.runId, toolCallId, prepared });
        const decision = await approvalGate.wait(state.runId, prepared, signal);
        state.emit({ type: decision === "approve" ? "approved" : "denied", runId: state.runId, approvalId: prepared.approvalId });
        if (decision === "deny") {
          if (state.memoryWriteOutcome !== "applied") state.memoryWriteOutcome = "denied";
          return safeToolResult({ status: "denied", approvalId: prepared.approvalId });
        }
      }
      const committed = options.memories.commit(prepared, {
        runId: state.runId,
        toolCallId,
        writePolicy: state.draft.writePolicy
      });
      state.memoryWriteOutcome = "applied";
      seeMemory(state, committed.memory);
      if (autoApply) state.emit({ type: "auto_applied", runId: state.runId, approvalId: prepared.approvalId });
      state.emit({
        type: "memory_changed",
        runId: state.runId,
        toolCallId,
        memory: committed.memory,
        revisionId: committed.revision.revisionId
      });
      return safeToolResult({ status: "applied", memory: memoryProjection(committed.memory), revisionId: committed.revision.revisionId });
    }
  };
  const finish: AgentTool<typeof finishSchema> = {
    name: "brainbuddy_finish",
    label: "Finish the Agent Run",
    description: "Return the final response and references. This must be the only tool call in the AssistantMessage.",
    parameters: finishSchema,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      if (state.draft.memoryIntent.type === "durable_fact"
        && state.memoryWriteOutcome !== "applied"
        && state.memoryWriteOutcome !== "denied") {
        throw new Error("MEMORY_WRITE_REQUIRED: This message contains a durable fact that must be handled with write_memory before finishing");
      }
      const references = params.references as AgentReference[];
      const unseen = references.find((reference) => !referenceWasSeen(state, reference));
      if (unseen) throw new Error(`REFERENCE_NOT_SEEN: ${unseen.kind} reference was not seen in this Run`);
      state.finish = {
        message: state.memoryWriteOutcome === "denied" ? "Memory 写入未获批准，本轮没有修改本地记忆。" : params.message,
        references
      };
      return { ...safeToolResult({ accepted: true }), terminate: true };
    }
  };
  return [searchLocalRecords, searchMemories, readMemory, writeMemory, finish];
}

function validatePreparedReferences(state: RunState, options: CreateAgentRuntimeOptions, prepared: PreparedMemoryWrite): void {
  const current = options.memories.list().find(({ path }) => path === prepared.path);
  const existingSources = new Set(current?.sourceIds ?? []);
  const existingCredentials = new Set(current?.credentialIds ?? []);
  const invalidSource = prepared.sourceIds.find((id) => !existingSources.has(id)
    && (!state.seenSourceIds.has(id) || !options.records.sourceExists(id)));
  if (invalidSource) throw new Error("REFERENCE_NOT_SEEN: Source reference was not seen in this Run");
  const invalidCredential = prepared.credentialIds.find((id) => !existingCredentials.has(id)
    && (!state.seenCredentialIds.has(id) || !options.records.credentialExists(id)));
  if (invalidCredential) throw new Error("REFERENCE_NOT_SEEN: Credential reference was not seen in this Run");
}

function validateRequiredMemoryReferences(state: RunState, prepared: PreparedMemoryWrite): void {
  const intent = state.draft.memoryIntent;
  if (intent.type !== "durable_fact") return;
  if (!prepared.sourceIds.includes(intent.requiredSourceId)
    || intent.requiredCredentialIds.some((id) => !prepared.credentialIds.includes(id))) {
    throw new Error("REQUIRED_REFERENCE_MISSING: A protected reference required by this durable fact is missing from the Memory write");
  }
}

function preflightBatch(state: RunState, assistantMessage: { readonly content: readonly unknown[] }): { readonly block: true; readonly reason: string } | undefined {
  const calls = assistantMessage.content.filter((content): content is { readonly type: "toolCall"; readonly id: string; readonly name: string } =>
    typeof content === "object" && content !== null && "type" in content && content.type === "toolCall" && "id" in content && "name" in content
  );
  const batchId = calls.map(({ id }) => id).join(":");
  if (!state.countedBatches.has(batchId)) {
    state.countedBatches.add(batchId);
    const finishCalls = calls.filter(({ name }) => name === "brainbuddy_finish");
    if (finishCalls.length) state.budgets.finishAttemptCount += 1;
    const localCalls = calls.filter(({ name }) => name !== "brainbuddy_finish");
    if (localCalls.length) state.budgets.toolBatchCount += 1;
    state.budgets.toolCallCount += localCalls.length;
  }
  if (calls.some(({ name }) => name === "brainbuddy_finish") && calls.length !== 1) {
    return { block: true, reason: "FINISH_MUST_BE_EXCLUSIVE: brainbuddy_finish must be the only tool call" };
  }
  if (state.budgets.toolBatchCount > MAX_LOCAL_TOOL_BATCHES || state.budgets.toolCallCount > MAX_LOCAL_TOOL_CALLS) {
    return { block: true, reason: "LIMIT_EXCEEDED: local tool budget exceeded" };
  }
  if (state.budgets.finishAttemptCount > MAX_FINISH_ATTEMPTS) {
    return { block: true, reason: "LIMIT_EXCEEDED: finish attempt budget exceeded" };
  }
  return undefined;
}

function observeAgentEvent(state: RunState, event: AgentEvent): void {
  if (event.type === "turn_start") {
    state.budgets.modelRequestCount += 1;
    if (state.budgets.modelRequestCount > MAX_MODEL_REQUESTS) state.agent?.abort();
    state.emit({ type: "turn_started", runId: state.runId, modelRequestCount: state.budgets.modelRequestCount });
  } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    state.emit({ type: "model_message_delta", runId: state.runId, delta: event.assistantMessageEvent.delta });
  } else if (event.type === "message_end" && event.message.role === "assistant") {
    state.emit({ type: "model_message", runId: state.runId, message: safeModelMessage(event.message) });
  } else if (event.type === "tool_execution_start") {
    state.emit({ type: "tool_call", runId: state.runId, toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
  } else if (event.type === "tool_execution_end") {
    state.emit({ type: "tool_result", runId: state.runId, toolCallId: event.toolCallId, toolName: event.toolName, result: event.result?.details, isError: event.isError });
  } else if (event.type === "turn_end") {
    state.emit({ type: "turn_completed", runId: state.runId });
    if (!state.finish && event.toolResults.length === 0 && !state.agent?.state.errorMessage && state.budgets.modelRequestCount < MAX_MODEL_REQUESTS) {
      state.agent?.followUp({
        role: "user",
        content: "你尚未调用 brainbuddy_finish。请继续完成任务，并将 brainbuddy_finish 作为唯一工具调用返回；不要只输出普通文本。",
        timestamp: Date.now()
      });
    }
  }
}

function cloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function safeModelMessage<T>(value: T): T {
  const message = cloneSafe(value) as T & { errorMessage?: string };
  if (message.errorMessage) message.errorMessage = "The model request failed safely";
  return message;
}

function safeToolResult<T>(details: T): { content: { type: "text"; text: string }[]; details: T } {
  return { content: [{ type: "text", text: JSON.stringify(details) }], details };
}

const SAFE_ERROR_CODES = new Set<SafeToolError["code"]>([
  "AMBIGUOUS_MATCH",
  "FINISH_MUST_BE_EXCLUSIVE",
  "INVALID_PATH",
  "INVALID_WRITE_REQUEST",
  "LIMIT_EXCEEDED",
  "MEMORY_WRITE_REQUIRED",
  "MEMORY_NOT_FOUND",
  "REFERENCE_NOT_SEEN",
  "REQUIRED_REFERENCE_MISSING",
  "RUN_CANCELLED",
  "VERSION_CONFLICT"
]);

function safeToolError(result: { readonly content?: readonly unknown[] } | undefined): SafeToolError {
  const text = result?.content
    ?.find((item): item is { readonly type: "text"; readonly text: string } =>
      typeof item === "object" && item !== null && "type" in item && item.type === "text" && "text" in item && typeof item.text === "string"
    )?.text ?? "";
  const candidate = text.match(/^([A-Z_]+):/)?.[1] as SafeToolError["code"] | undefined;
  const code = candidate && SAFE_ERROR_CODES.has(candidate) ? candidate : "TOOL_FAILED";
  return {
    code,
    message: code === "TOOL_FAILED" ? "The local tool failed safely" : safeErrorMessage(code),
    retryable: code !== "RUN_CANCELLED" && code !== "LIMIT_EXCEEDED"
  };
}

function safeErrorMessage(code: Exclude<SafeToolError["code"], "TOOL_FAILED">): string {
  const messages: Record<typeof code, string> = {
    AMBIGUOUS_MATCH: "The requested edit matched more than once",
    FINISH_MUST_BE_EXCLUSIVE: "brainbuddy_finish must be the only tool call",
    INVALID_PATH: "The Memory Path is not allowed",
    INVALID_WRITE_REQUEST: "The Memory write request is incomplete",
    LIMIT_EXCEEDED: "The Agent Run budget was exceeded",
    MEMORY_WRITE_REQUIRED: "A durable fact must be handled with write_memory before finishing",
    MEMORY_NOT_FOUND: "The requested Memory was not found",
    REFERENCE_NOT_SEEN: "The reference was not seen in this Run",
    REQUIRED_REFERENCE_MISSING: "A protected reference required by this durable fact is missing from the Memory write",
    RUN_CANCELLED: "The Agent Run was cancelled",
    VERSION_CONFLICT: "The Memory changed since it was read"
  };
  return messages[code];
}

function normalizeMemoryWrite(params: {
  readonly operation: "create" | "edit";
  readonly path: string;
  readonly content?: string;
  readonly expectedVersion?: string;
  readonly edits?: readonly MemoryEdit[];
  readonly reason: string;
}): MemoryWriteRequest {
  if (params.operation === "create") {
    if (params.content === undefined || params.expectedVersion !== undefined || params.edits !== undefined) {
      throw new Error("INVALID_WRITE_REQUEST: create requires content only");
    }
    return { operation: "create", path: params.path, content: params.content, reason: params.reason };
  }
  if (!params.expectedVersion || !params.edits?.length || params.content !== undefined) {
    throw new Error("INVALID_WRITE_REQUEST: edit requires expectedVersion and edits only");
  }
  return { operation: "edit", path: params.path, expectedVersion: params.expectedVersion, edits: params.edits, reason: params.reason };
}

function memoryProjection(memory: MemoryFile): MemoryFile {
  return {
    path: memory.path,
    content: memory.content.slice(0, MAX_MEMORY_CONTENT_LENGTH),
    version: memory.version,
    updatedAt: memory.updatedAt,
    sourceIds: [...memory.sourceIds],
    credentialIds: [...memory.credentialIds]
  };
}

function seeMemory(state: RunState, memory: Pick<MemoryFile, "path" | "sourceIds" | "credentialIds">): void {
  state.seenMemoryPaths.add(memory.path);
  memory.sourceIds.forEach((id) => state.seenSourceIds.add(id));
  memory.credentialIds.forEach((id) => state.seenCredentialIds.add(id));
}

function referenceWasSeen(state: RunState, reference: AgentReference): boolean {
  if (reference.kind === "source") return state.seenSourceIds.has(reference.id);
  if (reference.kind === "credential") return state.seenCredentialIds.has(reference.id);
  return state.seenMemoryPaths.has(reference.id);
}

function budgets(state: RunState): AgentRunBudgets {
  return { ...state.budgets };
}

function budgetExceeded(state: RunState): boolean {
  return state.budgets.toolBatchCount > MAX_LOCAL_TOOL_BATCHES
    || state.budgets.toolCallCount > MAX_LOCAL_TOOL_CALLS
    || state.budgets.finishAttemptCount > MAX_FINISH_ATTEMPTS
    || state.budgets.modelRequestCount >= MAX_MODEL_REQUESTS;
}

function finishFailed(state: RunState, code: string, message: string): AgentRunResult {
  const result: AgentRunResult = { status: "failed", code, message, budgets: budgets(state) };
  state.emit({ type: "agent_failed", runId: state.runId, result });
  return result;
}
