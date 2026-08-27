import { describe, expect, it, vi } from "vitest";
import { testModelConnection } from "./model-connection-test";

describe("testModelConnection", () => {
  it("verifies an OpenAI-compatible model with a one-token completion", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: "1" } }]
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const times = [1_000, 1_025];

    await expect(testModelConnection({
      apiKey: "sk-test-key-123456",
      baseUrl: "https://api.deepseek.com/v1/",
      modelId: "deepseek-v4-flash"
    }, {
      fetchFn,
      now: () => times.shift()!
    })).resolves.toEqual({
      success: true,
      latencyMs: 25,
      modelId: "deepseek-v4-flash",
      message: "AI 连接可用。"
    });
    expect(fetchFn).toHaveBeenCalledWith("https://api.deepseek.com/v1/chat/completions", expect.objectContaining({
      method: "POST",
      headers: {
        authorization: "Bearer sk-test-key-123456",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "1" }],
        max_tokens: 1,
        stream: false
      })
    }));
  });

  it("returns a safe failure without exposing the provider response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "invalid sk-PLAINTEXT-SECRET" }
    }), { status: 401, headers: { "content-type": "application/json" } }));
    const times = [2_000, 2_012];

    await expect(testModelConnection({
      apiKey: "sk-PLAINTEXT-SECRET",
      baseUrl: "https://api.deepseek.com",
      modelId: "deepseek-v4-flash"
    }, {
      fetchFn,
      now: () => times.shift()!
    })).resolves.toEqual({
      success: false,
      latencyMs: 12,
      modelId: "deepseek-v4-flash",
      message: "认证失败，请检查 API Key。"
    });
  });
});
