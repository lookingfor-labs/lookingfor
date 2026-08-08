import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Plugin } from "vite";
import { z } from "zod";
import { createDeepSeekAiConversationEngine, type AiConversationEngine } from "@brainbuddy/ai-conversation";
import { DemoMemorySession } from "@brainbuddy/memory-engine/memory";
import type { AiConversationDraft, AiConversationInput } from "@brainbuddy/domain";

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

export function aiConversationMiddleware(options: { readonly apiKey: string; readonly modelId?: string }): Plugin {
  let engine: AiConversationEngine | undefined;
  const drafts = new Map<string, AiConversationDraft>();
  const memories = new DemoMemorySession();
  const getEngine = () => engine ??= createDeepSeekAiConversationEngine(options);

  return {
    name: "brainbuddy-ai-conversation-dev-server",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== "POST" || !request.url?.startsWith("/api/ai-conversation/")) return next();
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
            request.once("aborted", () => controller.abort());
            response.writeHead(200, {
              "content-type": "application/x-ndjson; charset=utf-8",
              "cache-control": "no-store",
              connection: "keep-alive"
            });
            await getEngine().run(draft, {
              signal: controller.signal,
              onEvent: (event) => response.write(`${JSON.stringify({ runId, event })}\n`)
            });
            return response.end();
          }
          if (request.url === "/api/ai-conversation/apply-memory") {
            const { operation } = z.object({ operation: memoryOperationSchema }).parse(await readJson(request));
            return sendJson(response, 200, memories.apply(operation));
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
