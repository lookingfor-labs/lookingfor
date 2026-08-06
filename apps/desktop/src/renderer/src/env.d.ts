import type { BrainBuddyApi } from "@brainbuddy/shared-contracts";

declare global {
  interface Window {
    readonly brainBuddy: BrainBuddyApi;
  }
}

export {};
