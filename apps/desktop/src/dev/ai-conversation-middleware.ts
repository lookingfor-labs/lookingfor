import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Plugin } from "vite";
import { z } from "zod";
import { createDeepSeekAiConversationEngine, type AiConversationEngine } from "@brainbuddy/ai-conversation";
import {
  createDeepSeekAgentRuntime,
  createFileAgentRunRecorder,
  type AgentRuntime,
  type ProtectedRecordReader
} from "@brainbuddy/agent-runtime";
import { DemoMemorySession } from "@brainbuddy/memory-engine/memory";
import type {
  AiConversationDraft,
  AiConversationInput,
  DemoCredentialSummary,
  DemoSourceSummary
} from "@brainbuddy/domain";

const prepareSchema = z.object({
  message: z.string().min(1).max(20_000),
  conversationSource: z.object({
    sourceId: z.string().max(200),
    kind: z.enum(["capture", "local_search", "conversation"]),
    protectedContent: z.string().max(20_000),
    credentialIds: z.array(z.string().max(200)).max(100),
    savedAt: z.string().max(100)
  }),
  sources: z.array(z.object({
    sourceId: z.string().max(200),
    kind: z.enum(["capture", "local_search", "conversation"]),
    protectedContent: z.string().max(20_000),
    credentialIds: z.array(z.string().max(200)).max(100),
    savedAt: z.string().max(100)
  })).max(100),
  credentials: z.array(z.object({
    credentialId: z.string().max(200),
    entityType: z.string().max(100),
    maskedValue: z.string().max(2_000),
    sourceIds: z.array(z.string().max(200)).max(100),
    savedAt: z.string().max(100)
  })).max(100)
});

const memoryOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), path: z.string(), content: z.string(), reason: z.string() }),
  z.object({ operation: z.literal("update"), path: z.string(), expectedVersion: z.string(), content: z.string(), reason: z.string() })
]);

const agentPrepareSchema = z.object({
  message: z.string().min(1).max(20_000),
  conversationSourceId: z.string().max(200),
  writePolicy: z.enum(["require_approval", "auto_apply"]),
  sources: prepareSchema.shape.sources,
  credentials: prepareSchema.shape.credentials
});

class BrowserProtectedRecords implements ProtectedRecordReader {
  readonly #sources = new Map<string, DemoSourceSummary>();
  readonly #credentials = new Map<string, DemoCredentialSummary>();

  add(sources: readonly DemoSourceSummary[], credentials: readonly DemoCredentialSummary[]): void {
    sources.forEach((source) => this.#sources.set(source.sourceId, source));
    credentials.forEach((credential) => this.#credentials.set(credential.credentialId, credential));
  }

  search(query: string, limit: number) {
    const normalized = query.toLocaleLowerCase();
    const sources = [...this.#sources.values()].filter((source) =>
      `${source.sourceId} ${source.kind} ${source.protectedContent}`.toLocaleLowerCase().includes(normalized)
    );
    const credentials = [...this.#credentials.values()].filter((credential) =>
      `${credential.credentialId} ${credential.entityType} ${credential.maskedValue} ${credential.sourceIds.join(" ")}`
        .toLocaleLowerCase().includes(normalized)
    );
    return {
      sources: sources.slice(0, limit),
      credentials: credentials.slice(0, limit),
      total: sources.length + credentials.length,
      truncated: sources.length > limit || credentials.length > limit
    };
  }

  sourceExists(sourceId: string): boolean { return this.#sources.has(sourceId); }
  credentialExists(credentialId: string): boolean { return this.#credentials.has(credentialId); }
  reset(): void { this.#sources.clear(); this.#credentials.clear(); }
}

export function aiConversationMiddleware(options: {
  readonly apiKey: string;
  readonly modelId?: string;
  readonly agentRunLogDirectory?: string;
}): Plugin {
  let engine: AiConversationEngine | undefined;
  let agentRuntime: AgentRuntime | undefined;
  const drafts = new Map<string, AiConversationDraft>();
  const memories = new DemoMemorySession();
  const records = new BrowserProtectedRecords();
  const activeAiRuns = new Set<string>();
  const activeAgentRuns = new Set<string>();
  const getEngine = () => engine ??= createDeepSeekAiConversationEngine(options);
  const getAgentRuntime = () => agentRuntime ??= createDeepSeekAgentRuntime({
    apiKey: options.apiKey,
    ...(options.modelId ? { modelId: options.modelId } : {}),
    records,
    memories,
    ...(options.agentRunLogDirectory
      ? { recorder: createFileAgentRunRecorder({ directory: options.agentRunLogDirectory }) }
      : {})
  });

  return {
    name: "brainbuddy-ai-conversation-dev-server",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== "POST" || (!request.url?.startsWith("/api/ai-conversation/") && !request.url?.startsWith("/api/agent/") && !request.url?.startsWith("/api/memory/") && !request.url?.startsWith("/api/database/"))) return next();
        try {
          if (request.url === "/api/ai-conversation/prepare") {
            const input = prepareSchema.parse(await readJson(request)) as Omit<AiConversationInput, "memories">;
            const draft = getEngine().prepare({ ...input, memories: memories.list() });
            drafts.set(draft.draftId, draft);
            return sendJson(response, 200, draft);
          }
          if (request.url === "/api/ai-conversation/run") {
            const { draftId } = z.object({ draftId: z.string().uuid() }).parse(await readJson(request));
            const draft = drafts.get(draftId);
            if (!draft) return sendJson(response, 404, { error: "AI conversation draft was not found or has expired" });
            drafts.delete(draftId);
            const runId = randomUUID();
            const controller = new AbortController();
            activeAiRuns.add(runId);
            request.once("aborted", () => controller.abort());
            response.writeHead(200, {
              "content-type": "application/x-ndjson; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive"
            });
            try {
              await getEngine().run(draft, {
                signal: controller.signal,
                onEvent: (event) => response.write(`${JSON.stringify({ runId, event })}\n`)
              });
              return response.end();
            } finally {
              activeAiRuns.delete(runId);
            }
          }
          if (request.url === "/api/ai-conversation/apply-memory") {
            const { operation } = z.object({ operation: memoryOperationSchema }).parse(await readJson(request));
            return sendJson(response, 200, memories.apply(operation));
          }
          if (request.url === "/api/agent/prepare") {
            const input = agentPrepareSchema.parse(await readJson(request));
            records.add(input.sources as DemoSourceSummary[], input.credentials as DemoCredentialSummary[]);
            return sendJson(response, 200, getAgentRuntime().prepare({
              message: input.message,
              conversationSourceId: input.conversationSourceId,
              writePolicy: input.writePolicy
            }));
          }
          if (request.url === "/api/agent/run") {
            const { draftId } = z.object({ draftId: z.string().uuid() }).parse(await readJson(request));
            response.writeHead(200, {
              "content-type": "application/x-ndjson; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive"
            });
            const handle = getAgentRuntime().start(draftId, (event) => response.write(`${JSON.stringify({ runId: event.runId, event })}\n`));
            activeAgentRuns.add(handle.runId);
            request.once("aborted", () => void getAgentRuntime().cancel(handle.runId));
            try {
              await handle.done;
              return response.end();
            } finally {
              activeAgentRuns.delete(handle.runId);
            }
          }
          if (request.url === "/api/agent/approval") {
            const input = z.object({
              runId: z.string().uuid(),
              approvalId: z.string().uuid(),
              decision: z.enum(["approve", "deny"])
            }).parse(await readJson(request));
            return sendJson(response, 200, await getAgentRuntime().resolveApproval(input.runId, input.approvalId, input.decision));
          }
          if (request.url === "/api/agent/cancel") {
            const { runId } = z.object({ runId: z.string().uuid() }).parse(await readJson(request));
            await getAgentRuntime().cancel(runId);
            return sendJson(response, 200, { cancelled: true });
          }
          if (request.url === "/api/agent/revert") {
            const { revisionId } = z.object({ revisionId: z.string().uuid() }).parse(await readJson(request));
            return sendJson(response, 200, memories.revert(revisionId));
          }
          if (request.url === "/api/agent/reset-memory") {
            if (activeAgentRuns.size) return sendJson(response, 409, { error: "Memory 正在被 Agent Run 使用，请先等待完成或取消 Run。" });
            drafts.clear();
            return sendJson(response, 200, memories.reset());
          }
          if (request.url === "/api/memory/list") return sendJson(response, 200, memories.list());
          if (request.url === "/api/database/reset") {
            z.object({ confirmation: z.literal("清除数据库") }).parse(await readJson(request));
            if (activeAiRuns.size || activeAgentRuns.size) {
              return sendJson(response, 409, { error: "数据库正在被 Run 使用，请先等待完成或取消 Run。" });
            }
            drafts.clear();
            records.reset();
            agentRuntime = undefined;
            return sendJson(response, 200, { ready: true });
          }
          return sendJson(response, 404, { error: "Not found" });
        } catch (error) {
          if (response.headersSent) {
            response.write(`${JSON.stringify({
              runId: "browser",
              event: {
                type: "failed",
                at: new Date().toISOString(),
                reason: "error",
                message: error instanceof Error ? error.message : "DeepSeek 调用失败"
              }
            })}\n`);
            return response.end();
          }
          return sendJson(response, 400, { error: error instanceof Error ? error.message : "Invalid request" });
        }
      });
    }
  };
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 1_000_000) throw new Error("Request body is too large");
  }
  return JSON.parse(body || "{}");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}
