import type { ModelConnectionTestResult } from "@brainbuddy/domain";
import type { ModelConnection } from "./model-connection-store";

export async function testModelConnection(connection: ModelConnection, options: {
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
} = {}): Promise<ModelConnectionTestResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const endpoint = `${connection.baseUrl.replace(/\/+$/u, "")}/chat/completions`;
  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: connection.modelId,
        messages: [{ role: "user", content: "1" }],
        max_tokens: 1,
        stream: false
      }),
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) return result(response.status === 401 || response.status === 403
      ? "认证失败，请检查 API Key。"
      : `AI 连接不可用（HTTP ${response.status}）。`);
    const payload = await response.json() as { readonly choices?: readonly unknown[] };
    if (!payload.choices?.length) return result("服务已响应，但没有返回模型结果。");
    return result("AI 连接可用。", true);
  } catch {
    return result("无法连接到 AI 服务，请检查 API 地址和网络。");
  }

  function result(message: string, success = false): ModelConnectionTestResult {
    return {
      success,
      latencyMs: Math.max(0, now() - startedAt),
      modelId: connection.modelId,
      message
    };
  }
}
