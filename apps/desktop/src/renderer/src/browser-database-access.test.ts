import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureDatabasePassword,
  configureLocalStorageSettings,
  configureModelConnection,
  getLocalStorageSettings,
  getModelConnectionStatus,
  prepareAgentRun
} from "./App";

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
    const status = { provider: "deepseek", configured: true, baseUrl: "https://proxy.example.com/v1", modelId: "custom-model", maskedApiKey: "sk-••••7890" } as const;
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(status), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(configureModelConnection("sk-test-key-1234567890", "https://proxy.example.com/v1", "custom-model")).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/model/configure-connection", expect.objectContaining({
      body: JSON.stringify({ apiKey: "sk-test-key-1234567890", baseUrl: "https://proxy.example.com/v1", modelId: "custom-model" })
    }));

    await expect(getModelConnectionStatus()).resolves.toEqual(status);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/model/connection-status", expect.any(Object));
  });

  it("uses the backend interface for editable local storage paths", async () => {
    vi.stubGlobal("window", { brainBuddy: undefined });
    const settings = {
      memoryDirectory: "/tmp/brainbuddy/memories",
      databaseDirectory: "/tmp/brainbuddy/database",
      memoryWritePolicy: "auto_apply" as const
    };
    const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify(settings), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getLocalStorageSettings()).resolves.toEqual(settings);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/settings/local-storage", expect.any(Object));
    await expect(configureLocalStorageSettings(settings)).resolves.toEqual(settings);
    expect(fetchMock).toHaveBeenLastCalledWith("/api/settings/configure-local-storage", expect.objectContaining({
      body: JSON.stringify(settings)
    }));
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
