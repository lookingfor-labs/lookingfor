import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import viteSvgr from "vite-plugin-svgr";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react(), viteSvgr()],
  resolve: {
    alias: {
      "@renderer": fileURLToPath(new URL("./apps/desktop/src/renderer/src", import.meta.url))
    }
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
    coverage: {
      reporter: ["text", "html"]
    }
  }
});
