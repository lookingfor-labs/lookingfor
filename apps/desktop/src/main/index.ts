import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { DemoMemorySession } from "@brainbuddy/memory-engine";
import { buildProtectionPlan, PrivacyEngine, toProtectionPreview } from "@brainbuddy/privacy-engine";
import {
  ANALYZE_INPUT_CHANNEL,
  AnalyzeInputRequestSchema,
  PREVIEW_PROTECTION_CHANNEL,
  ProtectionRequestSchema,
  REVEAL_DEMO_SOURCE_CHANNEL,
  RevealDemoSourceRequestSchema,
  SEARCH_DEMO_MEMORIES_CHANNEL,
  SearchDemoMemoriesRequestSchema,
  SAVE_DEMO_CANDIDATE_CHANNEL
} from "@brainbuddy/shared-contracts";

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
const demoMemorySession = new DemoMemorySession();

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
  ipcMain.handle(ANALYZE_INPUT_CHANNEL, (_event, request: unknown) => {
    const { text } = AnalyzeInputRequestSchema.parse(request);
    return privacyEngine.analyze(text);
  });
  ipcMain.handle(PREVIEW_PROTECTION_CHANNEL, (_event, request: unknown) =>
    toProtectionPreview(createProtectionPlan(request))
  );
  ipcMain.handle(SAVE_DEMO_CANDIDATE_CHANNEL, (_event, request: unknown) =>
    demoMemorySession.save(createProtectionPlan(request), ProtectionRequestSchema.parse(request).text)
  );
  ipcMain.handle(SEARCH_DEMO_MEMORIES_CHANNEL, (_event, request: unknown) => {
    const { query } = SearchDemoMemoriesRequestSchema.parse(request);
    return demoMemorySession.search(query);
  });
  ipcMain.handle(REVEAL_DEMO_SOURCE_CHANNEL, (_event, request: unknown) => {
    const { sourceId } = RevealDemoSourceRequestSchema.parse(request);
    return demoMemorySession.revealSource(sourceId);
  });
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
