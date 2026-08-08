import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiQueryEvent, AiQueryInput } from "@brainbuddy/domain";
import { createDeepSeekAiQueryEngine } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("DeepSeekAiQueryEngine", () => {
  it("captures the provider payload and validates answer action intentions", async () => {
    globalThis.fetch = vi.fn(async () => deepSeekToolResponse({
      answer: "找到了对应的设计工具凭据。",
      references: [{ kind: "credential", id: "credential-1" }],
      proposedActions: [{
        kind: "file_read",
        path: "memories/design-tools.md",
        reason: "核对本地工具说明"
      }]
    })) as typeof fetch;
    const engine = createDeepSeekAiQueryEngine({
      apiKey: "test-key",
      now: () => new Date("2026-08-08T08:00:00.000Z"),
      idFactory: () => "550e8400-e29b-41d4-a716-446655440000"
    });
    const draft = engine.prepare(queryInput());
    const events: AiQueryEvent[] = [];

    await engine.run(draft, { onEvent: (event) => events.push(event) });

    expect(draft.context).toMatchObject({ systemPrompt: expect.stringContaining("proposedActions") });
    expect(events.some(({ type }) => type === "provider_payload")).toBe(true);
    const completed = events.find((event) => event.type === "completed");
    expect(completed).toMatchObject({
      type: "completed",
      answer: {
        answer: "找到了对应的设计工具凭据。",
        references: [{ kind: "credential", id: "credential-1" }],
        proposedActions: [{ kind: "file_read", path: "memories/design-tools.md" }]
      }
    });
  });

  it("keeps the raw reply but rejects references outside the prepared candidate set", async () => {
    globalThis.fetch = vi.fn(async () => deepSeekToolResponse({
      answer: "引用一个不存在的凭据。",
      references: [{ kind: "credential", id: "credential-outside-draft" }],
      proposedActions: []
    })) as typeof fetch;
    const engine = createDeepSeekAiQueryEngine({ apiKey: "test-key" });
    const events: AiQueryEvent[] = [];

    await engine.run(engine.prepare(queryInput()), { onEvent: (event) => events.push(event) });

    const completed = events.find((event) => event.type === "completed");
    expect(completed).toMatchObject({
      type: "completed",
      validationError: expect.stringContaining("本次候选之外")
    });
    expect(completed?.type === "completed" ? completed.rawMessage : undefined).toBeDefined();
  });
});

function queryInput(): AiQueryInput {
  return {
    query: "找一下之前做界面原型时常用的网站账号。",
    querySource: {
      sourceId: "SOURCE_QUERY",
      kind: "query",
      protectedContent: "找一下之前做界面原型时常用的网站账号。\n\n来源：[SOURCE:SOURCE_QUERY]",
      credentialIds: [],
      savedAt: "2026-08-08T08:00:00.000Z"
    },
    sources: [{
      sourceId: "SOURCE_FIGMA",
      kind: "write",
      protectedContent: "Figma 登录凭据是 [CREDENTIAL:credential-1]",
      credentialIds: ["credential-1"],
      savedAt: "2026-08-07T08:00:00.000Z"
    }],
    credentials: [{
      credentialId: "credential-1",
      entityType: "password",
      maskedValue: "••••••••",
      sourceIds: ["SOURCE_FIGMA"],
      savedAt: "2026-08-07T08:00:00.000Z"
    }]
  };
}

function deepSeekToolResponse(arguments_: unknown): Response {
  const chunks = [
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1_786_176_000,
      model: "deepseek-v4-flash",
      choices: [{
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call-answer",
            type: "function",
            function: { name: "brainbuddy_answer", arguments: JSON.stringify(arguments_) }
          }]
        },
        finish_reason: null
      }]
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      created: 1_786_176_000,
      model: "deepseek-v4-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110 }
    }
  ];
  const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}
