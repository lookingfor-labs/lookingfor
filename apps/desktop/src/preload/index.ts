import { contextBridge, ipcRenderer } from "electron";
import type { BrainBuddyApi } from "@brainbuddy/shared-contracts";
import { ANALYZE_INPUT_CHANNEL } from "@brainbuddy/shared-contracts";

const api: BrainBuddyApi = {
  analyzeInput: (request) => ipcRenderer.invoke(ANALYZE_INPUT_CHANNEL, request)
};

contextBridge.exposeInMainWorld("brainBuddy", api);
