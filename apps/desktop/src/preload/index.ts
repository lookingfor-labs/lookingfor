import { contextBridge, ipcRenderer } from "electron";
import type { BrainBuddyApi } from "@brainbuddy/shared-contracts";
import {
  ANALYZE_INPUT_CHANNEL,
  AGENT_RUN_EVENT_CHANNEL,
  AI_CONVERSATION_EVENT_CHANNEL,
  APPLY_MEMORY_OPERATION_CHANNEL,
  CANCEL_AI_CONVERSATION_CHANNEL,
  CANCEL_AGENT_RUN_CHANNEL,
  CONFIGURE_DATABASE_PASSWORD_CHANNEL,
  CONFIGURE_MODEL_CONNECTION_CHANNEL,
  GET_DATABASE_ACCESS_STATUS_CHANNEL,
  GET_MODEL_CONNECTION_STATUS_CHANNEL,
  LIST_MEMORY_FILES_CHANNEL,
  LOCK_DATABASE_CHANNEL,
  PREPARE_AI_CONVERSATION_CHANNEL,
  PREPARE_AGENT_RUN_CHANNEL,
  PREVIEW_PROTECTION_CHANNEL,
  REVEAL_DEMO_SOURCE_CHANNEL,
  RESOLVE_AGENT_APPROVAL_CHANNEL,
  RESET_MEMORY_CONTEXT_CHANNEL,
  RESET_DATABASE_CHANNEL,
  REVERT_MEMORY_REVISION_CHANNEL,
  SEARCH_DEMO_SOURCES_CHANNEL,
  SAVE_DEMO_CANDIDATE_CHANNEL,
  START_AI_CONVERSATION_CHANNEL,
  START_AGENT_RUN_CHANNEL,
  UNLOCK_DATABASE_CHANNEL
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
  applyMemoryOperation: (request) => ipcRenderer.invoke(APPLY_MEMORY_OPERATION_CHANNEL, request),
  prepareAgentRun: (request) => ipcRenderer.invoke(PREPARE_AGENT_RUN_CHANNEL, request),
  startAgentRun: (request) => ipcRenderer.invoke(START_AGENT_RUN_CHANNEL, request),
  resolveAgentApproval: (request) => ipcRenderer.invoke(RESOLVE_AGENT_APPROVAL_CHANNEL, request),
  cancelAgentRun: (request) => ipcRenderer.invoke(CANCEL_AGENT_RUN_CHANNEL, request),
  onAgentRunEvent: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on(AGENT_RUN_EVENT_CHANNEL, wrapped);
    return () => ipcRenderer.removeListener(AGENT_RUN_EVENT_CHANNEL, wrapped);
  },
  revertMemoryRevision: (request) => ipcRenderer.invoke(REVERT_MEMORY_REVISION_CHANNEL, request),
  resetMemoryTestContext: () => ipcRenderer.invoke(RESET_MEMORY_CONTEXT_CHANNEL),
  listMemoryFiles: () => ipcRenderer.invoke(LIST_MEMORY_FILES_CHANNEL),
  getDatabaseAccessStatus: () => ipcRenderer.invoke(GET_DATABASE_ACCESS_STATUS_CHANNEL),
  configureDatabasePassword: (request) => ipcRenderer.invoke(CONFIGURE_DATABASE_PASSWORD_CHANNEL, request),
  unlockDatabase: (request) => ipcRenderer.invoke(UNLOCK_DATABASE_CHANNEL, request),
  lockDatabase: () => ipcRenderer.invoke(LOCK_DATABASE_CHANNEL),
  resetDatabase: (request) => ipcRenderer.invoke(RESET_DATABASE_CHANNEL, request),
  getModelConnectionStatus: () => ipcRenderer.invoke(GET_MODEL_CONNECTION_STATUS_CHANNEL),
  configureModelConnection: (request) => ipcRenderer.invoke(CONFIGURE_MODEL_CONNECTION_CHANNEL, request)
};

contextBridge.exposeInMainWorld("brainBuddy", api);
