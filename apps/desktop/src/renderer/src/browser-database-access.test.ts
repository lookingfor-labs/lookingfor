import { afterEach, describe, expect, it, vi } from "vitest";
import { configureDatabasePassword } from "./App";

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
});
