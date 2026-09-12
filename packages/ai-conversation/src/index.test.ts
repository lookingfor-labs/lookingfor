import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiConversationEvent, AiConversationInput } from "@brainbuddy/domain";
import { createDeepSeekAiConversationEngine } from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("DeepSeekAiConversationEngine", () => {
  it("captures the provider payload and validates answer action intentions", async () => {
    globalThis.fetch = vi.fn(async () => deepSeekToolResponse({
      message: "找到了对应的设计工具凭据。",
      references: [{ kind: "credential", id: "credential-1" }],
      memoryOperations: [{
        operation: "update",
        path: "memories/design-tools.md",
        expectedVersion: "a".repeat(64),
        content: "补充 Figma 说明",
        reason: "更新设计工具记忆"
      }],
      otherIntents: [{
        kind: "file_read",
        path: "attachments/design-notes.md",
        reason: "核对外部附件"
      }]
    })) as typeof fetch;
    const engine = createDeepSeekAiConversationEngine({
      apiKey: "test-key",
      now: () => new Date("2026-08-08T08:00:00.000Z"),
      idFactory: () => "550e8400-e29b-41d4-a716-446655440000"
    });
    const draft = engine.prepare(conversationInput());
    const events: AiConversationEvent[] = [];

    await engine.run(draft, { onEvent: (event) => events.push(event) });

    expect(draft.context).toMatchObject({ systemPrompt: expect.stringContaining("memoryOperations") });
    expect(draft.context).toMatchObject({ systemPrompt: expect.stringContaining("最终 message 禁止提出任何问题") });
    expect(draft.context).toMatchObject({ systemPrompt: expect.stringContaining("Credential Source Link 已在调用模型前由本地系统保存") });
    expect(draft.candidateIds).toContain("SOURCE_QUERY");
    expect((draft.context as { messages: { content: string }[] }).messages[0]?.content).toContain('"conversationSource"');
    expect(JSON.stringify(draft.context)).not.toContain("maskedValue");
    expect(JSON.stringify(draft.context)).not.toContain("••••••••");
    expect(events.some(({ type }) => type === "provider_payload")).toBe(true);
    const completed = events.find((event) => event.type === "completed");
    expect(completed).toMatchObject({
      type: "completed",
      response: {
        message: "找到了对应的设计工具凭据。",
        references: [{ kind: "credential", id: "credential-1" }],
        memoryOperations: [{
          operation: "update",
          path: "memories/design-tools.md",
          content: expect.stringContaining("[SOURCE:SOURCE_QUERY]")
        }],
        otherIntents: [{ kind: "file_read", path: "attachments/design-notes.md" }]
      }
    });
  });

  it("keeps the raw reply but rejects references outside the prepared candidate set", async () => {
    globalThis.fetch = vi.fn(async () => deepSeekToolResponse({
      message: "引用一个不存在的凭据。",
      references: [{ kind: "credential", id: "credential-outside-draft" }],
      memoryOperations: [],
      otherIntents: []
    })) as typeof fetch;
    const engine = createDeepSeekAiConversationEngine({ apiKey: "test-key" });
    const events: AiConversationEvent[] = [];

    await engine.run(engine.prepare(conversationInput()), { onEvent: (event) => events.push(event) });

    const completed = events.find((event) => event.type === "completed");
    expect(completed).toMatchObject({
      type: "completed",
      validationError: expect.stringContaining("本次候选之外")
    });
    expect(completed?.type === "completed" ? completed.rawMessage : undefined).toBeDefined();
  });

  it("rejects unknown references embedded in proposed Memory content", async () => {
    globalThis.fetch = vi.fn(async () => deepSeekToolResponse({
      message: "准备记录。",
      references: [],
      memoryOperations: [{
        operation: "create",
        path: "memories/preferences.md",
        content: "未知来源 [SOURCE:SOURCE_INVENTED]",
        reason: "测试无效引用"
      }],
      otherIntents: []
    })) as typeof fetch;
    const engine = createDeepSeekAiConversationEngine({ apiKey: "test-key" });
    const events: AiConversationEvent[] = [];

    await engine.run(engine.prepare(conversationInput()), { onEvent: (event) => events.push(event) });

    expect(events.find((event) => event.type === "completed")).toMatchObject({
      type: "completed",
      validationError: expect.stringContaining("SOURCE_INVENTED")
    });
  });
});

function conversationInput(): AiConversationInput {
  return {
    message: "找一下之前做界面原型时常用的网站账号。",
    conversationSource: {
      sourceId: "SOURCE_QUERY",
      kind: "conversation",
      protectedContent: "找一下之前做界面原型时常用的网站账号。\n\n来源：[SOURCE:SOURCE_QUERY]",
      credentialIds: [],
      savedAt: "2026-08-08T08:00:00.000Z"
    },
    sources: [{
      sourceId: "SOURCE_FIGMA",
      kind: "capture",
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
    }],
    memories: [{
      path: "memories/design-tools.md",
      content: "Figma 凭据：[CREDENTIAL:credential-1]",
      sourceIds: ["SOURCE_FIGMA"],
      credentialIds: ["credential-1"],
      updatedAt: "2026-08-07T08:00:00.000Z",
      version: "a".repeat(64)
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
            function: { name: "brainbuddy_respond", arguments: JSON.stringify(arguments_) }
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
