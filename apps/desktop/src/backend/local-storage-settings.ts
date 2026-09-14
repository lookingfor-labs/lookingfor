import { accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from "node:path";
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
      databaseDirectory: join(options.applicationDataDirectory, "database"),
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
    try {
      validateStorageDirectories(normalized);
      mkdirSync(normalized.memoryDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(normalized.databaseDirectory, { recursive: true, mode: 0o700 });
      validateCreatedDirectories(normalized);
    } catch (error) {
      throw normalizeStoragePathError(error);
    }
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

function validateStorageDirectories(settings: LocalStorageSettings): void {
  const { memoryDirectory, databaseDirectory } = settings;
  for (const path of [memoryDirectory, databaseDirectory]) {
    if (path.includes("\0")) throw new Error("LOCAL_STORAGE_PATH_INVALID");
    const root = parse(path).root;
    if (samePath(path, root) || samePath(path, homedir())) throw new Error("LOCAL_STORAGE_PATH_TOO_BROAD");
    let stats;
    try {
      stats = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error("LOCAL_STORAGE_PATH_SYMLINK");
    if (!stats.isDirectory()) throw new Error("LOCAL_STORAGE_PATH_NOT_DIRECTORY");
  }
  assertSeparateDirectories(memoryDirectory, databaseDirectory);
  assertSeparateDirectories(join(dirname(memoryDirectory), "memory-revisions"), databaseDirectory);
}

function validateCreatedDirectories(settings: LocalStorageSettings): void {
  const memoryDirectory = realpathSync(settings.memoryDirectory);
  const databaseDirectory = realpathSync(settings.databaseDirectory);
  assertSeparateDirectories(memoryDirectory, databaseDirectory);
  assertSeparateDirectories(join(dirname(memoryDirectory), "memory-revisions"), databaseDirectory);
  try {
    const mode = process.platform === "win32" ? constants.R_OK | constants.W_OK : constants.R_OK | constants.W_OK | constants.X_OK;
    accessSync(memoryDirectory, mode);
    accessSync(databaseDirectory, mode);
  } catch {
    throw new Error("LOCAL_STORAGE_PATH_NOT_ACCESSIBLE");
  }
}

function assertSeparateDirectories(memoryDirectory: string, databaseDirectory: string): void {
  if (containsPath(memoryDirectory, databaseDirectory) || containsPath(databaseDirectory, memoryDirectory)) {
    throw new Error("LOCAL_STORAGE_PATHS_OVERLAP");
  }
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(normalizeForComparison(parent), normalizeForComparison(child));
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function samePath(left: string, right: string): boolean {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

function normalizeForComparison(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function normalizeStoragePathError(error: unknown): Error {
  if (error instanceof Error && error.message.startsWith("LOCAL_STORAGE_")) return error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return new Error("LOCAL_STORAGE_PATH_NOT_ACCESSIBLE");
  if (code === "ENOTDIR") return new Error("LOCAL_STORAGE_PATH_NOT_DIRECTORY");
  if (code === "EINVAL" || code === "ENAMETOOLONG") return new Error("LOCAL_STORAGE_PATH_INVALID");
  return error instanceof Error ? error : new Error(String(error));
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
