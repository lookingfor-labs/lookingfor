import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Plugin } from "vite";
import { z } from "zod";
import { createDeepSeekAiQueryEngine, type AiQueryEngine } from "@brainbuddy/ai-query";
import type { AiQueryDraft, AiQueryInput } from "@brainbuddy/domain";

const prepareSchema = z.object({
  query: z.string().min(1).max(20_000),
  querySource: z.object({
    sourceId: z.string().max(200),
    kind: z.enum(["write", "query"]),
    protectedContent: z.string().max(20_000),
    credentialIds: z.array(z.string().max(200)).max(100),
    savedAt: z.string().max(100)
  }),
  sources: z.array(z.object({
    sourceId: z.string().max(200),
    kind: z.enum(["write", "query"]),
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

export function aiQueryMiddleware(options: { readonly apiKey: string; readonly modelId?: string }): Plugin {
  let engine: AiQueryEngine | undefined;
  const drafts = new Map<string, AiQueryDraft>();
  const getEngine = () => engine ??= createDeepSeekAiQueryEngine(options);

  return {
    name: "brainbuddy-ai-query-dev-server",
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (request.method !== "POST" || !request.url?.startsWith("/api/ai-query/")) return next();
        try {
          if (request.url === "/api/ai-query/prepare") {
            const input = prepareSchema.parse(await readJson(request)) as AiQueryInput;
            const draft = getEngine().prepare(input);
            drafts.set(draft.draftId, draft);
            return sendJson(response, 200, draft);
          }
          if (request.url === "/api/ai-query/run") {
            const { draftId } = z.object({ draftId: z.string().uuid() }).parse(await readJson(request));
            const draft = drafts.get(draftId);
            if (!draft) return sendJson(response, 404, { error: "AI query draft was not found or has expired" });
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
