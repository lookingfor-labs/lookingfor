import { describe, expect, it } from "vitest";
import { resolveMainRuntimePaths } from "./runtime-paths";

describe("resolveMainRuntimePaths", () => {
  it("resolves packaged assets from an ESM module URL without __dirname", () => {
    expect(resolveMainRuntimePaths(
      "file:///Applications/brainbuddy.app/Contents/Resources/app.asar/out/main/index.js"
    )).toEqual({
      preload: "/Applications/brainbuddy.app/Contents/Resources/app.asar/out/preload/index.mjs",
      renderer: "/Applications/brainbuddy.app/Contents/Resources/app.asar/out/renderer/index.html"
    });
  });
});
