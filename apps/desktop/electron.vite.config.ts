import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ["@brainbuddy/domain", "@brainbuddy/privacy-engine", "@brainbuddy/shared-contracts"]
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
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src")
      }
    },
    plugins: [react()]
  }
});
