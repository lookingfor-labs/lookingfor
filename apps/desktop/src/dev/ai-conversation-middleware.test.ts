import { describe, expect, it } from "vitest";
import { requiresBrowserBackendRestart } from "./ai-conversation-middleware";

describe("browser backend hot reload", () => {
  it("restarts for server-side sources but not renderer-only changes", () => {
    expect(requiresBrowserBackendRestart("/repo/packages/privacy-engine/src/recognizers.ts")).toBe(true);
    expect(requiresBrowserBackendRestart("C:\\repo\\apps\\desktop\\src\\backend\\local-backend.ts")).toBe(true);
    expect(requiresBrowserBackendRestart("/repo/apps/desktop/src/renderer/src/MvpApp.tsx")).toBe(false);
  });
});
