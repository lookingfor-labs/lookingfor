import { contextBridge, ipcRenderer } from "electron";
import type { BrainBuddyApi } from "@brainbuddy/shared-contracts";
import {
  ANALYZE_INPUT_CHANNEL,
  AI_CONVERSATION_EVENT_CHANNEL,
  APPLY_MEMORY_OPERATION_CHANNEL,
  CANCEL_AI_CONVERSATION_CHANNEL,
  PREPARE_AI_CONVERSATION_CHANNEL,
  PREVIEW_PROTECTION_CHANNEL,
  REVEAL_DEMO_SOURCE_CHANNEL,
  SEARCH_DEMO_SOURCES_CHANNEL,
  SAVE_DEMO_CANDIDATE_CHANNEL,
  START_AI_CONVERSATION_CHANNEL
} from "@brainbuddy/shared-contracts";

const api: BrainBuddyApi = {
  analyzeInput: (request) => ipcRenderer.invoke(ANALYZE_INPUT_CHANNEL, request),
  previewProtection: (request) => ipcRenderer.invoke(PREVIEW_PROTECTION_CHANNEL, request),
  saveDemoCandidate: (request) => ipcRenderer.invoke(SAVE_DEMO_CANDIDATE_CHANNEL, request),
  searchDemoSources: (request) => ipcRenderer.invoke(SEARCH_DEMO_SOURCES_CHANNEL, request),
  revealDemoSource: (request) => ipcRenderer.invoke(REVEAL_DEMO_SOURCE_CHANNEL, request),
  prepareAiConversation: (request) => ipcRenderer.invoke(PREPARE_AI_CONVERSATION_CHANNEL, request),
  startAiConversation: (request) => ipcRenderer.invoke(START_AI_CONVERSATION_CHANNEL, request),
  cancelAiConversation: (request) => ipcRenderer.invoke(CANCEL_AI_CONVERSATION_CHANNEL, request),
  onAiConversationEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on(AI_CONVERSATION_EVENT_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(AI_CONVERSATION_EVENT_CHANNEL, wrapped);
  },
  applyMemoryOperation: (request) => ipcRenderer.invoke(APPLY_MEMORY_OPERATION_CHANNEL, request)
};

contextBridge.exposeInMainWorld("brainBuddy", api);
