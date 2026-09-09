import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import viteSvgr from "vite-plugin-svgr";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@brainbuddy/agent-runtime", "@brainbuddy/ai-conversation", "@brainbuddy/domain", "@brainbuddy/memory-engine", "@brainbuddy/privacy-engine", "@brainbuddy/shared-contracts"]
      })
    ]
  },
  preload: {
    build: {
      rollupOptions: {
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs"
        }
      }
    },
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@brainbuddy/shared-contracts"]
      })
    ]
  },
  renderer: {
    server: {
      host: "0.0.0.0",
      port: 15174,
      strictPort: true
    },
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src")
      }
    },
    plugins: [react(), viteSvgr()]
  }
});
