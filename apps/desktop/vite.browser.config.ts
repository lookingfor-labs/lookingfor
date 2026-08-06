import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL("./src/renderer", import.meta.url)),
  server: {
    host: "0.0.0.0",
    port: 15174,
    strictPort: true
  },
  resolve: {
    alias: {
      "@renderer": fileURLToPath(new URL("./src/renderer/src", import.meta.url))
    }
  },
  plugins: [react()],
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite/brainbuddy-browser", import.meta.url)),
  envDir: desktopRoot
});
