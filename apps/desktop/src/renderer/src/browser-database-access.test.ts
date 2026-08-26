import { afterEach, describe, expect, it, vi } from "vitest";
import { configureDatabasePassword, configureModelConnection, getModelConnectionStatus, prepareAgentRun } from "./App";

describe("browser database access", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("configures a password when the insecure HTTP context has no Web Crypto subtle API", async () => {
    vi.stubGlobal("window", { brainBuddy: undefined });
    vi.stubGlobal("crypto", {
      getRandomValues: (value: Uint8Array) => value.fill(7)
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      passwordConfigured: true,
      unlocked: true
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(configureDatabasePassword(undefined, "test-password")).resolves.toEqual({
      passwordConfigured: true,
      unlocked: true
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/database/configure-password", expect.any(Object));
  });

  it("uses the same backend-only model connection interface in browser development", async () => {
    vi.stubGlobal("window", { brainBuddy: undefined });
    const status = { provider: "deepseek", configured: true, modelId: "deepseek-chat", maskedApiKey: "sk-••••7890" } as const;
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(status), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(configureModelConnection("sk-test-key-1234567890", "deepseek-chat")).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/model/configure-connection", expect.objectContaining({
      body: JSON.stringify({ apiKey: "sk-test-key-1234567890", modelId: "deepseek-chat" })
    }));

    await expect(getModelConnectionStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/model/connection-status", expect.any(Object));
  });

  it("submits the reviewed privacy decisions when preparing an Agent Run", async () => {
    vi.stubGlobal("window", { brainBuddy: undefined });
    const draft = {
      draftId: "7885efba-fdd8-47f4-8607-f75018fdaf92",
      createdAt: "2026-08-27T00:00:00.000Z",
      message: "记录一下 agentflow 的密码是 [CREDENTIAL:test]",
      conversationSourceId: "SOURCE_DEMO_004",
      writePolicy: "require_approval"
    };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(draft), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    const decisions = [{
      start: 20,
      end: 28,
      policy: "move_to_vault" as const,
      credentialId: "00e5dcad-aad5-4fe2-a520-3ca35e0d03a8"
    }];

    await expect(prepareAgentRun("记录一下 agentflow 的密码是 77778888", "require_approval", decisions)).resolves.toEqual(draft);
    expect(fetchMock).toHaveBeenCalledWith("/api/agent/prepare", expect.objectContaining({
      body: JSON.stringify({
        text: "记录一下 agentflow 的密码是 77778888",
        writePolicy: "require_approval",
        decisions
      })
    }));
  });
});
