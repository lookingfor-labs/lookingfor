import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Plugin } from "vite";
import { z } from "zod";
import { createDeepSeekAiConversationEngine, type AiConversationEngine } from "@brainbuddy/ai-conversation";
import {
  createDeepSeekAgentRuntime,
  createFileAgentRunRecorder,
  type AgentRuntime
} from "@brainbuddy/agent-runtime";
import type { AiConversationDraft } from "@brainbuddy/domain";
import {
  AnalyzeInputRequestSchema,
  ConfigureModelConnectionRequestSchema,
  PrepareAgentRunRequestSchema,
  PrepareAiConversationRequestSchema,
  ProtectionRequestSchema,
  RevealDemoSourceRequestSchema,
  SearchDemoSourcesRequestSchema
} from "@brainbuddy/shared-contracts";
import { LocalBackend } from "../backend/local-backend";
import type { ModelConnection } from "../backend/model-connection-store";

const memoryOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("create"), path: z.string(), content: z.string(), reason: z.string() }),
  z.object({ operation: z.literal("update"), path: z.string(), expectedVersion: z.string(), content: z.string(), reason: z.string() })
]);

export function aiConversationMiddleware(options: {
  readonly dataDirectory: string;
  readonly initialModelConnection?: ModelConnection;
  readonly agentRunLogDirectory?: string;
}): Plugin {
  let engine: AiConversationEngine | undefined;
  let agentRuntime: AgentRuntime | undefined;
  const drafts = new Map<string, AiConversationDraft>();
  const backend = new LocalBackend({
    dataDirectory: options.dataDirectory,
    ...(options.initialModelConnection ? { initialModelConnection: options.initialModelConnection } : {})
  });
  const activeAiRuns = new Set<string>();
  const activeAgentRuns = new Set<string>();
  const getEngine = () => {
    if (engine) return engine;
    const connection = backend.requireModelConnection();
    return engine = createDeepSeekAiConversationEngine(connection);
  };
  const getAgentRuntime = () => {
    if (agentRuntime) return agentRuntime;
    const connection = backend.requireModelConnection();
    return agentRuntime = createDeepSeekAgentRuntime({
      ...connection,
      records: backend.records,
      memories: backend.memories,
      ...(options.agentRunLogDirectory
        ? { recorder: createFileAgentRunRecorder({ directory: options.agentRunLogDirectory }) }
        : {})
    });
  };

  return {
    name: "brainbuddy-ai-conversation-dev-server",
    configureServer(server) {
      server.httpServer?.once("close", () => backend.close());
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== "POST" || (!request.url?.startsWith("/api/privacy/") && !request.url?.startsWith("/api/ai-conversation/") && !request.url?.startsWith("/api/agent/") && !request.url?.startsWith("/api/memory/") && !request.url?.startsWith("/api/database/") && !request.url?.startsWith("/api/model/"))) return next();
        try {
          if (request.url === "/api/privacy/analyze") {
            const { text } = AnalyzeInputRequestSchema.parse(await readJson(request));
            return sendJson(response, 200, backend.analyze(text));
          }
          if (request.url === "/api/privacy/preview") {
            const { text, decisions } = ProtectionRequestSchema.parse(await readJson(request));
            return sendJson(response, 200, backend.preview(text, decisions));
          }
          if (request.url === "/api/database/save") {
            const { text, decisions } = ProtectionRequestSchema.parse(await readJson(request));
            return sendJson(response, 200, backend.save(text, decisions, "capture"));
          }
          if (request.url === "/api/database/search") {
            const { query } = SearchDemoSourcesRequestSchema.parse(await readJson(request));
            return sendJson(response, 200, backend.search(query));
          }
          if (request.url === "/api/database/reveal") {
            const { sourceId } = RevealDemoSourceRequestSchema.parse(await readJson(request));
            return sendJson(response, 200, backend.reveal(sourceId));
          }
          if (request.url === "/api/ai-conversation/prepare") {
            const { text } = PrepareAiConversationRequestSchema.parse(await readJson(request));
            const receipt = backend.saveSuggested(text, "conversation");
            const candidates = backend.search("", receipt.sourceId);
            const draft = getEngine().prepare({
              message: receipt.preview.protectedContent,
              conversationSource: {
                sourceId: receipt.sourceId,
                kind: receipt.kind,
                protectedContent: receipt.preview.protectedContent,
                credentialIds: receipt.credentialIds,
                savedAt: receipt.savedAt
              },
              sources: candidates.sources,
              credentials: candidates.credentials,
              memories: backend.memories.list()
            });
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
            return sendJson(response, 200, backend.memories.apply(operation));
          }
          if (request.url === "/api/agent/prepare") {
            const input = PrepareAgentRunRequestSchema.parse(await readJson(request));
            const receipt = input.decisions
              ? backend.save(input.text, input.decisions, "conversation")
              : backend.saveSuggested(input.text, "conversation");
            return sendJson(response, 200, getAgentRuntime().prepare({
              message: receipt.preview.protectedContent,
              conversationSourceId: receipt.sourceId,
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
            return sendJson(response, 200, backend.memories.revert(revisionId));
          }
          if (request.url === "/api/agent/reset-memory") {
            if (activeAgentRuns.size) return sendJson(response, 409, { error: "Memory 正在被 Agent Run 使用，请先等待完成或取消 Run。" });
            drafts.clear();
            return sendJson(response, 200, backend.memories.reset());
          }
          if (request.url === "/api/memory/list") return sendJson(response, 200, backend.memories.list());
          if (request.url === "/api/database/access-status") {
            return sendJson(response, 200, backend.access.status());
          }
          if (request.url === "/api/database/configure-password") {
            const input = z.object({
              currentPassword: z.string().max(128).optional(),
              newPassword: z.string().min(8).max(128)
            }).parse(await readJson(request));
            return sendJson(response, 200, backend.access.configure(input.currentPassword, input.newPassword));
          }
          if (request.url === "/api/database/unlock") {
            const { password } = z.object({ password: z.string().min(1).max(128) }).parse(await readJson(request));
            return sendJson(response, 200, backend.access.unlock(password));
          }
          if (request.url === "/api/database/lock") {
            return sendJson(response, 200, backend.access.lock());
          }
          if (request.url === "/api/database/assert-access") {
            backend.access.assertUnlocked();
            return sendJson(response, 200, { unlocked: true });
          }
          if (request.url === "/api/database/reset") {
            z.object({ confirmation: z.literal("清除数据库") }).parse(await readJson(request));
            if (activeAiRuns.size || activeAgentRuns.size) {
              return sendJson(response, 409, { error: "数据库正在被 Run 使用，请先等待完成或取消 Run。" });
            }
            drafts.clear();
            agentRuntime = undefined;
            return sendJson(response, 200, backend.resetDatabase());
          }
          if (request.url === "/api/model/connection-status") {
            return sendJson(response, 200, backend.modelConnectionStatus());
          }
          if (request.url === "/api/model/configure-connection") {
            const { apiKey, modelId } = ConfigureModelConnectionRequestSchema.parse(await readJson(request));
            if (activeAiRuns.size || activeAgentRuns.size) {
              return sendJson(response, 409, { error: "模型配置正在被 AI Run 使用，请先等待完成或取消 Run。" });
            }
            drafts.clear();
            engine = undefined;
            agentRuntime = undefined;
            return sendJson(response, 200, backend.configureModelConnection(apiKey, modelId));
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
