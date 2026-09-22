import { listPackage } from "@electron/asar";
import { resolve } from "node:path";

const archivePath = process.argv[2];

if (!archivePath) {
  throw new Error("Usage: npm run verify:package -- <path-to-app.asar>");
}

const packagedFiles = listPackage(resolve(process.env.INIT_CWD ?? process.cwd(), archivePath));
const requiredNativeModule = "/node_modules/better-sqlite3-multiple-ciphers/";
const bundledDependencies = [
  "@brainbuddy/agent-runtime",
  "@brainbuddy/ai-conversation",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@phosphor-icons/react",
  "dotenv",
  "react",
  "react-dom",
  "zod"
];

if (!packagedFiles.some((file) => file.startsWith(requiredNativeModule))) {
  throw new Error("The packaged app is missing its native encrypted database module");
}

const duplicates = bundledDependencies.filter((dependency) => {
  const prefix = `/node_modules/${dependency}/`;
  return packagedFiles.some((file) => file.startsWith(prefix));
});

if (duplicates.length > 0) {
  throw new Error(`Bundled dependencies were duplicated in app.asar: ${duplicates.join(", ")}`);
}

console.log("Packaged dependencies contain only runtime modules that must remain external");
