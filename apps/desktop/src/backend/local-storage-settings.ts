import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import type { LocalStorageSettings } from "@brainbuddy/domain";

interface StoredLocalStorageSettings extends LocalStorageSettings {
  readonly version: 1;
}

export class LocalStorageSettingsStore {
  readonly #metadataPath: string;
  readonly #defaults: LocalStorageSettings;

  constructor(options: { readonly applicationDataDirectory: string }) {
    mkdirSync(options.applicationDataDirectory, { recursive: true });
    this.#metadataPath = join(options.applicationDataDirectory, "local-storage-settings.json");
    this.#defaults = {
      memoryDirectory: join(options.applicationDataDirectory, "memories"),
      databaseDirectory: options.applicationDataDirectory,
      memoryWritePolicy: "auto_apply"
    };
    if (existsSync(this.#metadataPath)) chmodSync(this.#metadataPath, 0o600);
  }

  get(): LocalStorageSettings {
    if (!existsSync(this.#metadataPath)) return this.#defaults;
    try {
      const stored = JSON.parse(readFileSync(this.#metadataPath, "utf8")) as StoredLocalStorageSettings;
      if (stored.version !== 1) throw new Error("invalid version");
      return normalizeSettings(stored);
    } catch {
      throw new Error("LOCAL_STORAGE_CONFIG_INVALID");
    }
  }

  configure(settings: LocalStorageSettings): LocalStorageSettings {
    const normalized = normalizeSettings(settings);
    mkdirSync(normalized.memoryDirectory, { recursive: true });
    mkdirSync(normalized.databaseDirectory, { recursive: true });
    writePrivateJsonAtomically(this.#metadataPath, { version: 1, ...normalized });
    return normalized;
  }
}

function normalizeSettings(settings: LocalStorageSettings): LocalStorageSettings {
  const memoryDirectory = normalize(settings.memoryDirectory.trim());
  const databaseDirectory = normalize(settings.databaseDirectory.trim());
  if (!isAbsolute(memoryDirectory) || !isAbsolute(databaseDirectory)) {
    throw new Error("LOCAL_STORAGE_PATH_NOT_ABSOLUTE");
  }
  return {
    memoryDirectory,
    databaseDirectory,
    memoryWritePolicy: settings.memoryWritePolicy === "auto_apply" ? "auto_apply" : "require_approval"
  };
}

function writePrivateJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* Nothing to clean up. */ }
    throw error;
  }
}
