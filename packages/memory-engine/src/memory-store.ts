import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { MemoryFile, MemoryOperation } from "@brainbuddy/domain";

export interface MemoryStore {
  list(): readonly MemoryFile[];
  apply(operation: MemoryOperation): MemoryFile;
}

export class FileMemoryStore implements MemoryStore {
  readonly #rootDirectory: string;
  readonly #now: () => Date;

  constructor(options: { readonly rootDirectory: string; readonly now?: () => Date }) {
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#now = options.now ?? (() => new Date());
    mkdirSync(this.#rootDirectory, { recursive: true });
  }

  list(): readonly MemoryFile[] {
    return listMarkdownFiles(this.#rootDirectory)
      .map((filePath) => this.#read(filePath))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  apply(operation: MemoryOperation): MemoryFile {
    const logicalPath = validateMemoryPath(operation.path);
    const filePath = resolveMemoryFile(this.#rootDirectory, logicalPath);
    const exists = fileExists(filePath);
    if (operation.operation === "create" && exists) throw new Error("Memory already exists at this path");
    if (operation.operation === "update") {
      if (!exists) throw new Error("Memory does not exist at this path");
      if (!operation.expectedVersion) throw new Error("Updating Memory requires its expected version");
      const current = this.#read(filePath);
      if (current.version !== operation.expectedVersion) throw new Error("Memory changed after the proposal was created");
    }
    mkdirSync(dirname(filePath), { recursive: true });
    const temporaryPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, operation.content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
    const updatedAt = this.#now();
    utimesSync(filePath, updatedAt, updatedAt);
    return this.#read(filePath);
  }

  #read(filePath: string): MemoryFile {
    const content = readFileSync(filePath, "utf8");
    const relativePath = relative(this.#rootDirectory, filePath).split(sep).join("/");
    return memoryFile(`memories/${relativePath}`, content, statSync(filePath).mtime.toISOString());
  }
}

export class DemoMemorySession implements MemoryStore {
  readonly #now: () => Date;
  readonly #files = new Map<string, MemoryFile>();

  constructor(options: { readonly now?: () => Date; readonly initial?: readonly MemoryFile[] } = {}) {
    this.#now = options.now ?? (() => new Date());
    for (const file of options.initial ?? []) this.#files.set(validateMemoryPath(file.path), file);
  }

  list(): readonly MemoryFile[] {
    return [...this.#files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  apply(operation: MemoryOperation): MemoryFile {
    const path = validateMemoryPath(operation.path);
    const current = this.#files.get(path);
    if (operation.operation === "create" && current) throw new Error("Memory already exists at this path");
    if (operation.operation === "update") {
      if (!current) throw new Error("Memory does not exist at this path");
      if (!operation.expectedVersion) throw new Error("Updating Memory requires its expected version");
      if (current.version !== operation.expectedVersion) throw new Error("Memory changed after the proposal was created");
    }
    const next = memoryFile(path, operation.content, this.#now().toISOString());
    this.#files.set(path, next);
    return next;
  }
}

export function validateMemoryPath(input: string): string {
  const path = input.trim();
  if (!path || path.includes("\\") || path.startsWith("/") || !path.startsWith("memories/")) {
    throw new Error("Memory Path must be a relative path below memories/");
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error("Memory Path contains an invalid segment");
  if (!path.endsWith(".md")) throw new Error("Memory files must use the .md extension");
  return path;
}

function resolveMemoryFile(rootDirectory: string, logicalPath: string): string {
  const filePath = resolve(rootDirectory, ...logicalPath.split("/").slice(1));
  if (!filePath.startsWith(`${rootDirectory}${sep}`)) throw new Error("Memory Path escapes its controlled root");
  return filePath;
}

function listMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function memoryFile(path: string, content: string, updatedAt: string): MemoryFile {
  return {
    path,
    content,
    sourceIds: references(content, /\[SOURCE:(.+?)\]/gu),
    credentialIds: references(content, /\[CREDENTIAL:(.+?)\]/gu),
    updatedAt,
    version: createHash("sha256").update(content).digest("hex")
  };
}

function references(content: string, pattern: RegExp): readonly string[] {
  return [...new Set([...content.matchAll(pattern)].map((match) => match[1]).filter((value): value is string => Boolean(value)))];
}
