import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { config as loadDotEnv } from "dotenv";
import { createDeepSeekAiConversationEngine, type AiConversationEngine } from "@brainbuddy/ai-conversation";
import {
  createDeepSeekAgentRuntime,
  createFileAgentRunRecorder,
  type AgentRuntime
} from "@brainbuddy/agent-runtime";
import { LocalBackend } from "../backend/local-backend";
import { modelConnectionFromEnvironment } from "../backend/model-connection-store";
import { resolveMainRuntimePaths } from "./runtime-paths";
import {
  ANALYZE_INPUT_CHANNEL,
  AGENT_RUN_EVENT_CHANNEL,
  AI_CONVERSATION_EVENT_CHANNEL,
  APPLY_MEMORY_OPERATION_CHANNEL,
  ApplyMemoryOperationRequestSchema,
  AnalyzeInputRequestSchema,
  CANCEL_AI_CONVERSATION_CHANNEL,
  CANCEL_AGENT_RUN_CHANNEL,
  CancelAgentRunRequestSchema,
  CancelAiConversationRequestSchema,
  CONFIGURE_DATABASE_PASSWORD_CHANNEL,
  ConfigureDatabasePasswordRequestSchema,
  CONFIGURE_MODEL_CONNECTION_CHANNEL,
  ConfigureModelConnectionRequestSchema,
  GET_DATABASE_ACCESS_STATUS_CHANNEL,
  GET_MODEL_CONNECTION_STATUS_CHANNEL,
  LIST_MEMORY_FILES_CHANNEL,
  LOCK_DATABASE_CHANNEL,
  PREPARE_AI_CONVERSATION_CHANNEL,
  PREPARE_AGENT_RUN_CHANNEL,
  PrepareAgentRunRequestSchema,
  PrepareAiConversationRequestSchema,
  PREVIEW_PROTECTION_CHANNEL,
  ProtectionRequestSchema,
  REVEAL_DEMO_SOURCE_CHANNEL,
  RESOLVE_AGENT_APPROVAL_CHANNEL,
  RESET_MEMORY_CONTEXT_CHANNEL,
  RESET_DATABASE_CHANNEL,
  ResetDatabaseRequestSchema,
  ResolveAgentApprovalRequestSchema,
  REVERT_MEMORY_REVISION_CHANNEL,
  RevertMemoryRevisionRequestSchema,
  RevealDemoSourceRequestSchema,
  SEARCH_DEMO_SOURCES_CHANNEL,
  SearchDemoSourcesRequestSchema,
  SAVE_DEMO_CANDIDATE_CHANNEL,
  START_AI_CONVERSATION_CHANNEL,
  START_AGENT_RUN_CHANNEL,
  StartAgentRunRequestSchema,
  StartAiConversationRequestSchema,
  UNLOCK_DATABASE_CHANNEL,
  UnlockDatabaseRequestSchema
} from "@brainbuddy/shared-contracts";

loadDotEnv({ quiet: true });

let localBackend: LocalBackend | undefined;
let aiConversationEngine: AiConversationEngine | undefined;
let agentRuntime: AgentRuntime | undefined;
const aiDrafts = new Map<string, ReturnType<AiConversationEngine["prepare"]>>();
const aiRuns = new Map<string, AbortController>();
const agentRuns = new Set<string>();
const mainRuntimePaths = resolveMainRuntimePaths(import.meta.url);

function getAiConversationEngine(): AiConversationEngine {
  if (aiConversationEngine) return aiConversationEngine;
  if (!localBackend) throw new Error("Local stores are not ready");
  const connection = localBackend.requireModelConnection();
  aiConversationEngine = createDeepSeekAiConversationEngine({
    apiKey: connection.apiKey,
    modelId: connection.modelId
  });
  return aiConversationEngine;
}

function getAgentRuntime(): AgentRuntime {
  if (agentRuntime) return agentRuntime;
  if (!localBackend) throw new Error("Local stores are not ready");
  const connection = localBackend.requireModelConnection();
  agentRuntime = createDeepSeekAgentRuntime({
    apiKey: connection.apiKey,
    modelId: connection.modelId,
    records: localBackend.records,
    memories: localBackend.memories,
    recorder: createFileAgentRunRecorder({ directory: join(app.getPath("userData"), "agent-runs") })
  });
  return agentRuntime;
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 640,
    show: false,
    backgroundColor: "#f2f0e9",
    webPreferences: {
      preload: mainRuntimePaths.preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(mainRuntimePaths.renderer);
  }
}

app.whenReady().then(() => {
  const dataDirectory = app.getPath("userData");
  const initialModelConnection = modelConnectionFromEnvironment(process.env);
  localBackend = new LocalBackend({
    dataDirectory,
    ...(initialModelConnection ? { initialModelConnection } : {})
  });
  ipcMain.handle(ANALYZE_INPUT_CHANNEL, (_event, request: unknown) => {
    const { text } = AnalyzeInputRequestSchema.parse(request);
    return localBackend!.analyze(text);
  });
  ipcMain.handle(PREVIEW_PROTECTION_CHANNEL, (_event, request: unknown) => {
    const { text, decisions } = ProtectionRequestSchema.parse(request);
    return localBackend!.preview(text, decisions);
  });
  ipcMain.handle(SAVE_DEMO_CANDIDATE_CHANNEL, (_event, request: unknown) => {
    const { text, decisions } = ProtectionRequestSchema.parse(request);
    return localBackend!.save(text, decisions, "capture");
  });
  ipcMain.handle(SEARCH_DEMO_SOURCES_CHANNEL, (_event, request: unknown) => {
    const { query } = SearchDemoSourcesRequestSchema.parse(request);
    return localBackend!.search(query);
  });
  ipcMain.handle(REVEAL_DEMO_SOURCE_CHANNEL, (_event, request: unknown) => {
    const { sourceId } = RevealDemoSourceRequestSchema.parse(request);
    return localBackend!.reveal(sourceId);
  });
  ipcMain.handle(PREPARE_AI_CONVERSATION_CHANNEL, (_event, request: unknown) => {
    const { text } = PrepareAiConversationRequestSchema.parse(request);
    const receipt = localBackend!.saveSuggested(text, "conversation");
    const candidates = localBackend!.search("", receipt.sourceId);
    const draft = getAiConversationEngine().prepare({
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
      memories: localBackend!.memories.list()
    });
    aiDrafts.set(draft.draftId, draft);
    return draft;
  });
  ipcMain.handle(START_AI_CONVERSATION_CHANNEL, (event, request: unknown) => {
    const { draftId } = StartAiConversationRequestSchema.parse(request);
    const draft = aiDrafts.get(draftId);
    if (!draft) throw new Error("AI conversation draft was not found or has expired");
    aiDrafts.delete(draftId);
    const runId = randomUUID();
    const controller = new AbortController();
    aiRuns.set(runId, controller);
    setImmediate(() => {
      void getAiConversationEngine().run(draft, {
        signal: controller.signal,
        onEvent: (aiEvent) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(AI_CONVERSATION_EVENT_CHANNEL, { runId, event: aiEvent });
          }
        }
      }).catch((error: unknown) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send(AI_CONVERSATION_EVENT_CHANNEL, {
            runId,
            event: {
              type: "failed",
              at: new Date().toISOString(),
              reason: controller.signal.aborted ? "aborted" : "error",
              message: error instanceof Error ? error.message : "DeepSeek 调用失败"
            }
          });
        }
      }).finally(() => {
        aiRuns.delete(runId);
      });
    });
    return { runId };
  });
  ipcMain.handle(CANCEL_AI_CONVERSATION_CHANNEL, (_event, request: unknown) => {
    const { runId } = CancelAiConversationRequestSchema.parse(request);
    aiRuns.get(runId)?.abort();
  });
  ipcMain.handle(APPLY_MEMORY_OPERATION_CHANNEL, (_event, request: unknown) => {
    const { operation } = ApplyMemoryOperationRequestSchema.parse(request);
    return localBackend!.memories.apply(operation);
  });
  ipcMain.handle(PREPARE_AGENT_RUN_CHANNEL, (_event, request: unknown) => {
    const { text, writePolicy, decisions } = PrepareAgentRunRequestSchema.parse(request);
    const receipt = decisions
      ? localBackend!.save(text, decisions, "conversation")
      : localBackend!.saveSuggested(text, "conversation");
    return getAgentRuntime().prepare({
      message: receipt.preview.protectedContent,
      conversationSourceId: receipt.sourceId,
      writePolicy
    });
  });
  ipcMain.handle(START_AGENT_RUN_CHANNEL, (event, request: unknown) => {
    const { draftId } = StartAgentRunRequestSchema.parse(request);
    const handle = getAgentRuntime().start(draftId, (agentEvent) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send(AGENT_RUN_EVENT_CHANNEL, { runId: agentEvent.runId, event: agentEvent });
      }
    });
    agentRuns.add(handle.runId);
    void handle.done.finally(() => agentRuns.delete(handle.runId));
    return { runId: handle.runId };
  });
  ipcMain.handle(RESOLVE_AGENT_APPROVAL_CHANNEL, (_event, request: unknown) => {
    const { runId, approvalId, decision } = ResolveAgentApprovalRequestSchema.parse(request);
    return getAgentRuntime().resolveApproval(runId, approvalId, decision);
  });
  ipcMain.handle(CANCEL_AGENT_RUN_CHANNEL, (_event, request: unknown) => {
    const { runId } = CancelAgentRunRequestSchema.parse(request);
    return getAgentRuntime().cancel(runId);
  });
  ipcMain.handle(REVERT_MEMORY_REVISION_CHANNEL, (_event, request: unknown) => {
    const { revisionId } = RevertMemoryRevisionRequestSchema.parse(request);
    return localBackend!.memories.revert(revisionId);
  });
  ipcMain.handle(RESET_MEMORY_CONTEXT_CHANNEL, () => {
    if (aiRuns.size || agentRuns.size) throw new Error("MEMORY_RESET_BLOCKED: A Run is still active");
    aiDrafts.clear();
    return localBackend!.memories.reset();
  });
  ipcMain.handle(LIST_MEMORY_FILES_CHANNEL, () => localBackend!.memories.list());
  ipcMain.handle(GET_DATABASE_ACCESS_STATUS_CHANNEL, () => localBackend!.access.status());
  ipcMain.handle(CONFIGURE_DATABASE_PASSWORD_CHANNEL, (_event, request: unknown) => {
    const { currentPassword, newPassword } = ConfigureDatabasePasswordRequestSchema.parse(request);
    return localBackend!.access.configure(currentPassword, newPassword);
  });
  ipcMain.handle(UNLOCK_DATABASE_CHANNEL, (_event, request: unknown) => {
    const { password } = UnlockDatabaseRequestSchema.parse(request);
    return localBackend!.access.unlock(password);
  });
  ipcMain.handle(LOCK_DATABASE_CHANNEL, () => localBackend!.access.lock());
  ipcMain.handle(RESET_DATABASE_CHANNEL, (_event, request: unknown) => {
    ResetDatabaseRequestSchema.parse(request);
    if (aiRuns.size || agentRuns.size) throw new Error("DATABASE_RESET_BLOCKED: A Run is still active");
    aiDrafts.clear();
    agentRuntime = undefined;
    return localBackend!.resetDatabase();
  });
  ipcMain.handle(GET_MODEL_CONNECTION_STATUS_CHANNEL, () => localBackend!.modelConnectionStatus());
  ipcMain.handle(CONFIGURE_MODEL_CONNECTION_CHANNEL, (_event, request: unknown) => {
    const { apiKey, modelId } = ConfigureModelConnectionRequestSchema.parse(request);
    if (aiRuns.size || agentRuns.size) throw new Error("MODEL_CONFIG_BLOCKED: An AI Run is still active");
    aiDrafts.clear();
    aiConversationEngine = undefined;
    agentRuntime = undefined;
    return localBackend!.configureModelConnection(apiKey, modelId);
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  for (const controller of aiRuns.values()) controller.abort();
  aiRuns.clear();
  aiDrafts.clear();
  for (const runId of agentRuns) void agentRuntime?.cancel(runId);
  agentRuns.clear();
  agentRuntime = undefined;
  localBackend?.close();
  localBackend = undefined;
});
