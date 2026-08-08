import { contextBridge, ipcRenderer } from "electron";
import type { BrainBuddyApi } from "@brainbuddy/shared-contracts";
import {
  ANALYZE_INPUT_CHANNEL,
  AI_QUERY_EVENT_CHANNEL,
  CANCEL_AI_QUERY_CHANNEL,
  PREPARE_AI_QUERY_CHANNEL,
  PREVIEW_PROTECTION_CHANNEL,
  REVEAL_DEMO_SOURCE_CHANNEL,
  SEARCH_DEMO_SOURCES_CHANNEL,
  SUBMIT_DEMO_QUERY_CHANNEL,
  SAVE_DEMO_CANDIDATE_CHANNEL,
  START_AI_QUERY_CHANNEL
} from "@brainbuddy/shared-contracts";

const api: BrainBuddyApi = {
  analyzeInput: (request) => ipcRenderer.invoke(ANALYZE_INPUT_CHANNEL, request),
  previewProtection: (request) => ipcRenderer.invoke(PREVIEW_PROTECTION_CHANNEL, request),
  saveDemoCandidate: (request) => ipcRenderer.invoke(SAVE_DEMO_CANDIDATE_CHANNEL, request),
  searchDemoSources: (request) => ipcRenderer.invoke(SEARCH_DEMO_SOURCES_CHANNEL, request),
  submitDemoQuery: (request) => ipcRenderer.invoke(SUBMIT_DEMO_QUERY_CHANNEL, request),
  revealDemoSource: (request) => ipcRenderer.invoke(REVEAL_DEMO_SOURCE_CHANNEL, request),
  prepareAiQuery: (request) => ipcRenderer.invoke(PREPARE_AI_QUERY_CHANNEL, request),
  startAiQuery: (request) => ipcRenderer.invoke(START_AI_QUERY_CHANNEL, request),
  cancelAiQuery: (request) => ipcRenderer.invoke(CANCEL_AI_QUERY_CHANNEL, request),
  onAiQueryEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on(AI_QUERY_EVENT_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(AI_QUERY_EVENT_CHANNEL, wrapped);
  }
};

contextBridge.exposeInMainWorld("brainBuddy", api);
