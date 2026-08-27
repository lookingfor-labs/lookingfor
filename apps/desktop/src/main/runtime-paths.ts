import { fileURLToPath } from "node:url";

export interface MainRuntimePaths {
  readonly preload: string;
  readonly renderer: string;
}

export function resolveMainRuntimePaths(moduleUrl: string): MainRuntimePaths {
  return {
    preload: fileURLToPath(new URL("../preload/index.mjs", moduleUrl)),
    renderer: fileURLToPath(new URL("../renderer/index.html", moduleUrl))
  };
}
