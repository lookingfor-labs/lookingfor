import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { config as loadDotEnv } from "dotenv";
import { createDeepSeekAiConversationEngine, type AiConversationEngine } from "@brainbuddy/ai-conversation";
import { FileMemoryStore, type MemoryStore } from "@brainbuddy/memory-engine/memory";
import { SqliteSourceStore } from "@brainbuddy/memory-engine/sqlite";
import { buildProtectionPlan, PrivacyEngine, toProtectionPreview } from "@brainbuddy/privacy-engine";
import {
  ANALYZE_INPUT_CHANNEL,
  AI_CONVERSATION_EVENT_CHANNEL,
  APPLY_MEMORY_OPERATION_CHANNEL,
  ApplyMemoryOperationRequestSchema,
  AnalyzeInputRequestSchema,
  CANCEL_AI_CONVERSATION_CHANNEL,
  CancelAiConversationRequestSchema,
  PREPARE_AI_CONVERSATION_CHANNEL,
  PrepareAiConversationRequestSchema,
  PREVIEW_PROTECTION_CHANNEL,
  ProtectionRequestSchema,
  REVEAL_DEMO_SOURCE_CHANNEL,
  RevealDemoSourceRequestSchema,
  SEARCH_DEMO_SOURCES_CHANNEL,
  SearchDemoSourcesRequestSchema,
  SUBMIT_DEMO_QUERY_CHANNEL,
  SubmitDemoQueryRequestSchema,
  SAVE_DEMO_CANDIDATE_CHANNEL,
  START_AI_CONVERSATION_CHANNEL,
  StartAiConversationRequestSchema
} from "@brainbuddy/shared-contracts";

loadDotEnv({ quiet: true });

const privacyEngine = new PrivacyEngine({
  knownEntities: [
    {
      id: "demo-person-zhang-wei",
      canonicalName: "张伟",
      entityType: "person",
      token: "[PERSON_A]",
      aliases: [],
      defaultPolicy: "keep_original"
    }
  ]
});
let sourceStore: SqliteSourceStore | undefined;
let memoryStore: MemoryStore | undefined;
let aiConversationEngine: AiConversationEngine | undefined;
const aiDrafts = new Map<string, ReturnType<AiConversationEngine["prepare"]>>();
const aiRuns = new Map<string, AbortController>();

function getAiConversationEngine(): AiConversationEngine {
  aiConversationEngine ??= createDeepSeekAiConversationEngine({
    apiKey: process.env.SECRET_DEEPSEEK_API_KEY ?? "",
    ...(process.env.SECRET_DEEPSEEK_MODEL ? { modelId: process.env.SECRET_DEEPSEEK_MODEL } : {})
  });
  return aiConversationEngine;
}

function createProtectionPlan(request: unknown) {
  const { text, decisions } = ProtectionRequestSchema.parse(request);
  const analysis = privacyEngine.analyze(text);
  return buildProtectionPlan({
    text,
    entities: analysis.entities,
    decisions,
    credentialIdFactory: randomUUID
  });
}

function createSuggestedProtectionPlan(text: string) {
  const analysis = privacyEngine.analyze(text);
  return buildProtectionPlan({
    text,
    entities: analysis.entities,
    decisions: analysis.entities.map(({ start, end, suggestedPolicy: policy }) => ({ start, end, policy })),
    credentialIdFactory: randomUUID
  });
}

function loadEncryptionKey(dataDirectory: string): Buffer {
  mkdirSync(dataDirectory, { recursive: true });
  const keyPath = join(dataDirectory, "brainbuddy.key");
  try {
    const key = readFileSync(keyPath);
    if (key.byteLength !== 32) throw new Error("Stored BrainBuddy key is invalid");
    chmodSync(keyPath, 0o600);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const key = randomBytes(32);
    writeFileSync(keyPath, key, { flag: "wx", mode: 0o600 });
    return key;
  }
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
      preload: join(__dirname, "../preload/index.mjs"),
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
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  const dataDirectory = app.getPath("userData");
  sourceStore = new SqliteSourceStore({
    databasePath: join(dataDirectory, "brainbuddy.sqlite"),
    encryptionKey: loadEncryptionKey(dataDirectory)
  });
  memoryStore = new FileMemoryStore({ rootDirectory: join(dataDirectory, "memories") });
  ipcMain.handle(ANALYZE_INPUT_CHANNEL, (_event, request: unknown) => {
    const { text } = AnalyzeInputRequestSchema.parse(request);
    return privacyEngine.analyze(text);
  });
  ipcMain.handle(PREVIEW_PROTECTION_CHANNEL, (_event, request: unknown) =>
    toProtectionPreview(createProtectionPlan(request))
  );
  ipcMain.handle(SAVE_DEMO_CANDIDATE_CHANNEL, (_event, request: unknown) =>
    sourceStore!.save(createProtectionPlan(request), ProtectionRequestSchema.parse(request).text, "capture")
  );
  ipcMain.handle(SEARCH_DEMO_SOURCES_CHANNEL, (_event, request: unknown) => {
    const { query } = SearchDemoSourcesRequestSchema.parse(request);
    return sourceStore!.searchOffline(query);
  });
  ipcMain.handle(SUBMIT_DEMO_QUERY_CHANNEL, (_event, request: unknown) => {
    const { text } = SubmitDemoQueryRequestSchema.parse(request);
    const receipt = sourceStore!.save(createSuggestedProtectionPlan(text), text, "local_search");
    const result = sourceStore!.searchOffline(text, receipt.sourceId);
    const submittedCredentials = sourceStore!.searchOffline("").credentials
      .filter((credential) => receipt.credentialIds.includes(credential.credentialId));
    return {
      receipt,
      sources: result.sources,
      credentials: [...submittedCredentials, ...result.credentials.filter((credential) =>
        !receipt.credentialIds.includes(credential.credentialId))]
    };
  });
  ipcMain.handle(REVEAL_DEMO_SOURCE_CHANNEL, (_event, request: unknown) => {
    const { sourceId } = RevealDemoSourceRequestSchema.parse(request);
    return sourceStore!.revealSource(sourceId);
  });
  ipcMain.handle(PREPARE_AI_CONVERSATION_CHANNEL, (_event, request: unknown) => {
    const { text } = PrepareAiConversationRequestSchema.parse(request);
    const receipt = sourceStore!.save(createSuggestedProtectionPlan(text), text, "conversation");
    const candidates = sourceStore!.searchOffline("", receipt.sourceId);
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
      memories: memoryStore!.list()
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
    return memoryStore!.apply(operation);
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
  sourceStore?.close();
  sourceStore = undefined;
  memoryStore = undefined;
});
