import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@brainbuddy/ai-query", "@brainbuddy/domain", "@brainbuddy/privacy-engine", "@brainbuddy/shared-contracts"]
      })
    ]
  },
  preload: {
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
    plugins: [react()]
  }
});
