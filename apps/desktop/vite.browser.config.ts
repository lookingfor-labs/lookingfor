import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { config as loadDotEnv } from "dotenv";
import { defineConfig } from "vite";
import { aiConversationMiddleware } from "./src/dev/ai-conversation-middleware";

const desktopRoot = fileURLToPath(new URL(".", import.meta.url));
loadDotEnv({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

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
  plugins: [
    aiConversationMiddleware({
      apiKey: process.env.SECRET_DEEPSEEK_API_KEY ?? "",
      ...(process.env.SECRET_DEEPSEEK_MODEL ? { modelId: process.env.SECRET_DEEPSEEK_MODEL } : {})
    }),
    react()
  ],
  cacheDir: fileURLToPath(new URL("../../node_modules/.vite/brainbuddy-browser", import.meta.url)),
  envDir: desktopRoot
});
