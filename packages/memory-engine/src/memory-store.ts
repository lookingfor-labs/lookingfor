import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  MemoryCommitMetadata,
  MemoryCommitResult,
  MemoryEdit,
  MemoryFile,
  MemoryOperation,
  MemoryResetResult,
  MemoryRevertResult,
  MemoryRevision,
  MemoryWriteRequest,
  PreparedMemoryWrite
} from "@brainbuddy/domain";

export interface MemoryStore {
  list(): readonly MemoryFile[];
  apply(operation: MemoryOperation): MemoryFile;
  prepare(request: MemoryWriteRequest): PreparedMemoryWrite;
  commit(prepared: PreparedMemoryWrite, metadata: MemoryCommitMetadata): MemoryCommitResult;
  revert(revisionId: string): MemoryRevertResult;
  reset(): MemoryResetResult;
  listRevisions(): readonly MemoryRevision[];
  revisionsAvailable(): boolean;
}

interface FileRevisionLedger {
  sequence: number;
  pathRevisions: Record<string, number>;
  revisions: MemoryRevision[];
}

export class FileMemoryStore implements MemoryStore {
  readonly #rootDirectory: string;
  readonly #revisionDirectory: string;
  readonly #ledgerPath: string;
  readonly #now: () => Date;
  readonly #ledger: FileRevisionLedger;

  constructor(options: {
    readonly rootDirectory: string;
    readonly revisionDirectory?: string;
    readonly now?: () => Date;
  }) {
    this.#rootDirectory = resolve(options.rootDirectory);
    this.#revisionDirectory = resolve(options.revisionDirectory ?? join(dirname(this.#rootDirectory), "memory-revisions"));
    this.#ledgerPath = join(this.#revisionDirectory, "revisions.json");
    this.#now = options.now ?? (() => new Date());
    mkdirSync(this.#rootDirectory, { recursive: true });
    if (lstatSync(this.#rootDirectory).isSymbolicLink()) throw new Error("Memory Root cannot be a symbolic link");
    mkdirSync(this.#revisionDirectory, { recursive: true });
    this.#ledger = readLedger(this.#ledgerPath);
    this.#recoverPreparedRevisions();
  }

  list(): readonly MemoryFile[] {
    return listMarkdownFiles(this.#rootDirectory)
      .map((filePath) => this.#read(filePath))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  apply(operation: MemoryOperation): MemoryFile {
    const path = validateMemoryPath(operation.path);
    const current = this.#readLogical(path);
    const prepared = operation.operation === "create"
      ? this.prepare(operation)
      : prepareMemoryContent({
          path,
          operation: "edit",
          expectedVersion: operation.expectedVersion,
          current,
          resultingContent: operation.content,
          reason: operation.reason
        });
    return this.commit(prepared, {
      runId: "legacy-memory-operation",
      toolCallId: randomUUID(),
      writePolicy: "require_approval"
    }).memory;
  }

  prepare(request: MemoryWriteRequest): PreparedMemoryWrite {
    const path = validateMemoryPath(request.path);
    const current = this.#readLogical(path);
    if (request.operation === "create") {
      return prepareMemoryContent({ path, operation: "create", current, resultingContent: request.content, reason: request.reason });
    }
    return prepareMemoryContent({
      path,
      operation: "edit",
      expectedVersion: request.expectedVersion,
      current,
      resultingContent: applyEdits(current?.content, request.edits),
      edits: request.edits,
      reason: request.reason
    });
  }

  commit(prepared: PreparedMemoryWrite, metadata: MemoryCommitMetadata): MemoryCommitResult {
    assertPreparedWrite(prepared);
    const current = this.#readLogical(prepared.path);
    assertBaseVersion(prepared, current);
    this.#ledger.sequence += 1;
    const updatedAt = this.#now().toISOString();
    const next = memoryFile(prepared.path, prepared.resultingContent, updatedAt, this.#ledger.sequence);
    const revision: MemoryRevision = {
      revisionId: randomUUID(),
      runId: metadata.runId,
      toolCallId: metadata.toolCallId,
      writePolicy: metadata.writePolicy,
      path: prepared.path,
      reason: prepared.reason,
      requestHash: prepared.requestHash,
      beforeContent: current?.content ?? null,
      beforeVersion: current?.version ?? null,
      afterContent: next.content,
      afterVersion: next.version,
      diff: prepared.diff,
      status: "prepared",
      createdAt: updatedAt
    };
    this.#ledger.revisions.push(revision);
    writeLedger(this.#ledgerPath, this.#ledger);
    this.#write(prepared.path, prepared.resultingContent, new Date(updatedAt));
    this.#ledger.pathRevisions[prepared.path] = this.#ledger.sequence;
    const applied = { ...revision, status: "applied" as const };
    this.#ledger.revisions[this.#ledger.revisions.length - 1] = applied;
    writeLedger(this.#ledgerPath, this.#ledger);
    return { memory: next, revision: applied };
  }

  revert(revisionId: string): MemoryRevertResult {
    const index = this.#ledger.revisions.findIndex((revision) => revision.revisionId === revisionId);
    const revision = this.#ledger.revisions[index];
    if (!revision || revision.status !== "applied") {
      throw new Error("Memory Revision is not available for revert");
    }
    const current = this.#readLogical(revision.path);
    if (!current || current.version !== revision.afterVersion) throw new Error("Memory changed after the Revision was applied");
    this.#ledger.sequence += 1;
    const updatedAt = this.#now().toISOString();
    const reverted = revision.beforeContent === null
      ? null
      : memoryFile(revision.path, revision.beforeContent, updatedAt, this.#ledger.sequence);
    const revertRevision: MemoryRevision = {
      revisionId: randomUUID(),
      runId: "user-revert",
      toolCallId: randomUUID(),
      writePolicy: "require_approval",
      path: revision.path,
      reason: `Revert ${revisionId}`,
      requestHash: contentHash(`${revisionId}:${reverted?.version ?? "deleted"}`),
      beforeContent: current.content,
      beforeVersion: current.version,
      afterContent: reverted?.content ?? null,
      afterVersion: reverted?.version ?? null,
      diff: memoryDiff(current.content, reverted?.content ?? ""),
      status: "prepared",
      createdAt: updatedAt,
      revertsRevisionId: revisionId
    };
    this.#ledger.revisions.push(revertRevision);
    writeLedger(this.#ledgerPath, this.#ledger);
    if (reverted) {
      this.#write(revision.path, reverted.content, new Date(updatedAt));
      this.#ledger.pathRevisions[revision.path] = this.#ledger.sequence;
    } else {
      unlinkSync(resolveMemoryFile(this.#rootDirectory, revision.path));
      delete this.#ledger.pathRevisions[revision.path];
    }
    this.#ledger.revisions[index] = { ...revision, status: "reverted" };
    this.#ledger.revisions[this.#ledger.revisions.length - 1] = { ...revertRevision, status: "applied" };
    writeLedger(this.#ledgerPath, this.#ledger);
    return { path: revision.path, deleted: reverted === null, memory: reverted };
  }

  reset(): MemoryResetResult {
    const files = listMarkdownFiles(this.#rootDirectory);
    const deletedRevisionCount = this.#ledger.revisions.length;
    files.forEach((filePath) => unlinkSync(filePath));
    this.#ledger.sequence = 0;
    this.#ledger.pathRevisions = {};
    this.#ledger.revisions = [];
    writeLedger(this.#ledgerPath, this.#ledger);
    return { deletedMemoryCount: files.length, deletedRevisionCount };
  }

  listRevisions(): readonly MemoryRevision[] {
    return this.#ledger.revisions.map((revision) => ({ ...revision }));
  }

  revisionsAvailable(): boolean {
    return true;
  }

  #read(filePath: string): MemoryFile {
    const content = readFileSync(filePath, "utf8");
    const relativePath = relative(this.#rootDirectory, filePath).split(sep).join("/");
    const logicalPath = `memories/${relativePath}`;
    return memoryFile(logicalPath, content, statSync(filePath).mtime.toISOString(), this.#ledger.pathRevisions[logicalPath] ?? 0);
  }

  #readLogical(logicalPath: string): MemoryFile | undefined {
    const filePath = resolveMemoryFile(this.#rootDirectory, logicalPath);
    assertNoSymlinkPath(this.#rootDirectory, filePath);
    if (!fileExistsWithoutSymlink(filePath)) return undefined;
    assertCanonicalMemoryPath(this.#rootDirectory, filePath);
    return this.#read(filePath);
  }

  #write(logicalPath: string, content: string, updatedAt: Date): void {
    const filePath = resolveMemoryFile(this.#rootDirectory, logicalPath);
    assertNoSymlinkPath(this.#rootDirectory, filePath);
    mkdirSync(dirname(filePath), { recursive: true });
    assertCanonicalMemoryPath(this.#rootDirectory, dirname(filePath));
    const temporaryPath = join(dirname(filePath), `.${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, filePath);
    utimesSync(filePath, updatedAt, updatedAt);
  }

  #recoverPreparedRevisions(): void {
    let changed = false;
    this.#ledger.revisions = this.#ledger.revisions.map((revision) => {
      if (revision.status !== "prepared") return revision;
      const file = this.#readLogical(revision.path);
      const recovered = revision.afterContent === null
        ? !file
        : Boolean(file && contentHash(file.content) === contentHash(revision.afterContent));
      if (recovered) {
        if (revision.afterVersion) this.#ledger.pathRevisions[revision.path] = versionRevision(revision.afterVersion);
        else delete this.#ledger.pathRevisions[revision.path];
        if (revision.revertsRevisionId) {
          const targetIndex = this.#ledger.revisions.findIndex(({ revisionId }) => revisionId === revision.revertsRevisionId);
          const target = this.#ledger.revisions[targetIndex];
          if (target) this.#ledger.revisions[targetIndex] = { ...target, status: "reverted" };
        }
        changed = true;
        return { ...revision, status: "applied" };
      }
      changed = true;
      return { ...revision, status: "failed" };
    });
    if (changed) writeLedger(this.#ledgerPath, this.#ledger);
  }
}

export class DemoMemorySession implements MemoryStore {
  readonly #now: () => Date;
  readonly #files = new Map<string, MemoryFile>();
  readonly #revisions = new Map<string, MemoryRevision>();
  #revisionSequence = 0;

  constructor(options: { readonly now?: () => Date; readonly initial?: readonly MemoryFile[] } = {}) {
    this.#now = options.now ?? (() => new Date());
    for (const file of options.initial ?? []) {
      this.#files.set(validateMemoryPath(file.path), file);
      this.#revisionSequence = Math.max(this.#revisionSequence, versionRevision(file.version));
    }
  }

  list(): readonly MemoryFile[] {
    return [...this.#files.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  apply(operation: MemoryOperation): MemoryFile {
    const prepared = operation.operation === "create"
      ? this.prepare(operation)
      : prepareMemoryContent({
          path: validateMemoryPath(operation.path),
          operation: "edit",
          expectedVersion: operation.expectedVersion,
          current: this.#files.get(validateMemoryPath(operation.path)),
          resultingContent: operation.content,
          reason: operation.reason
        });
    return this.commit(prepared, {
      runId: "legacy-memory-operation",
      toolCallId: randomUUID(),
      writePolicy: "require_approval"
    }).memory;
  }

  prepare(request: MemoryWriteRequest): PreparedMemoryWrite {
    const path = validateMemoryPath(request.path);
    const current = this.#files.get(path);
    if (request.operation === "create") {
      return prepareMemoryContent({ path, operation: "create", current, resultingContent: request.content, reason: request.reason });
    }
    return prepareMemoryContent({
      path,
      operation: "edit",
      expectedVersion: request.expectedVersion,
      current,
      resultingContent: applyEdits(current?.content, request.edits),
      edits: request.edits,
      reason: request.reason
    });
  }

  commit(prepared: PreparedMemoryWrite, metadata: MemoryCommitMetadata): MemoryCommitResult {
    assertPreparedWrite(prepared);
    const current = this.#files.get(prepared.path);
    assertBaseVersion(prepared, current);
    this.#revisionSequence += 1;
    const updatedAt = this.#now().toISOString();
    const next = memoryFile(prepared.path, prepared.resultingContent, updatedAt, this.#revisionSequence);
    const revision: MemoryRevision = {
      revisionId: randomUUID(),
      runId: metadata.runId,
      toolCallId: metadata.toolCallId,
      writePolicy: metadata.writePolicy,
      path: prepared.path,
      reason: prepared.reason,
      requestHash: prepared.requestHash,
      beforeContent: current?.content ?? null,
      beforeVersion: current?.version ?? null,
      afterContent: next.content,
      afterVersion: next.version,
      diff: prepared.diff,
      status: "applied",
      createdAt: updatedAt
    };
    this.#files.set(prepared.path, next);
    this.#revisions.set(revision.revisionId, revision);
    return { memory: next, revision };
  }

  revert(revisionId: string): MemoryRevertResult {
    const revision = this.#revisions.get(revisionId);
    if (!revision || revision.status !== "applied") throw new Error("Memory Revision is not available for revert");
    const current = this.#files.get(revision.path);
    if (!current || current.version !== revision.afterVersion) throw new Error("Memory changed after the Revision was applied");
    this.#revisionSequence += 1;
    const updatedAt = this.#now().toISOString();
    const reverted = revision.beforeContent === null
      ? null
      : memoryFile(revision.path, revision.beforeContent, updatedAt, this.#revisionSequence);
    if (reverted) this.#files.set(revision.path, reverted);
    else this.#files.delete(revision.path);
    this.#revisions.set(revisionId, { ...revision, status: "reverted" });
    const revertRevision: MemoryRevision = {
      revisionId: randomUUID(),
      runId: "user-revert",
      toolCallId: randomUUID(),
      writePolicy: "require_approval",
      path: revision.path,
      reason: `Revert ${revisionId}`,
      requestHash: contentHash(`${revisionId}:${reverted?.version ?? "deleted"}`),
      beforeContent: current.content,
      beforeVersion: current.version,
      afterContent: reverted?.content ?? null,
      afterVersion: reverted?.version ?? null,
      diff: memoryDiff(current.content, reverted?.content ?? ""),
      status: "applied",
      createdAt: updatedAt,
      revertsRevisionId: revisionId
    };
    this.#revisions.set(revertRevision.revisionId, revertRevision);
    return { path: revision.path, deleted: reverted === null, memory: reverted };
  }

  reset(): MemoryResetResult {
    const deletedMemoryCount = this.#files.size;
    const deletedRevisionCount = this.#revisions.size;
    this.#files.clear();
    this.#revisions.clear();
    this.#revisionSequence = 0;
    return { deletedMemoryCount, deletedRevisionCount };
  }

  listRevisions(): readonly MemoryRevision[] {
    return [...this.#revisions.values()];
  }

  revisionsAvailable(): boolean {
    return true;
  }
}

function prepareMemoryContent(options: {
  readonly path: string;
  readonly operation: "create" | "edit";
  readonly expectedVersion?: string;
  readonly current: MemoryFile | undefined;
  readonly resultingContent: string;
  readonly edits?: readonly MemoryEdit[];
  readonly reason: string;
}): PreparedMemoryWrite {
  if (options.operation === "create" && options.current) throw new Error("Memory already exists at this path");
  if (options.operation === "edit") {
    if (!options.current) throw new Error("Memory does not exist at this path");
    if (options.current.version !== options.expectedVersion) throw new Error("Memory changed after the proposal was created");
  }
  if (!options.resultingContent) throw new Error("Memory content cannot be empty");
  const resultingContentHash = contentHash(options.resultingContent);
  const sourceIds = references(options.resultingContent, /\[SOURCE:(.+?)\]/gu);
  const credentialIds = references(options.resultingContent, /\[CREDENTIAL:(.+?)\]/gu);
  const normalizedEdits = (options.edits ?? []).map((edit) => ({ ...edit }));
  const values = {
    path: options.path,
    operation: options.operation,
    baseVersion: options.current?.version ?? null,
    normalizedEdits,
    resultingContent: options.resultingContent,
    resultingContentHash,
    diff: memoryDiff(options.current?.content ?? "", options.resultingContent),
    sourceIds,
    credentialIds,
    reason: options.reason
  };
  return Object.freeze({
    approvalId: randomUUID(),
    ...values,
    normalizedEdits: Object.freeze(normalizedEdits),
    sourceIds: Object.freeze([...sourceIds]),
    credentialIds: Object.freeze([...credentialIds]),
    requestHash: preparedRequestHash(values)
  });
}

function applyEdits(content: string | undefined, edits: readonly MemoryEdit[]): string {
  if (content === undefined) throw new Error("Memory does not exist at this path");
  if (!edits.length) throw new Error("A Memory edit requires at least one change");
  if (edits.length > 50) throw new Error("A Memory edit exceeds the change limit");
  return edits.reduce((working, edit) => {
    if (edit.type === "append") return `${working}${edit.content}`;
    const anchor = edit.type === "replace" ? edit.oldText : edit.anchor;
    if (!anchor) throw new Error("A Memory edit anchor cannot be empty");
    const matches = working.split(anchor).length - 1;
    if (matches !== 1) throw new Error(matches === 0 ? "Memory edit anchor was not found" : "Memory edit anchor is ambiguous");
    if (edit.type === "replace") return working.replace(anchor, edit.newText);
    const replacement = edit.type === "insert_before" ? `${edit.content}${anchor}` : `${anchor}${edit.content}`;
    return working.replace(anchor, replacement);
  }, content);
}

function assertPreparedWrite(prepared: PreparedMemoryWrite): void {
  const expectedHash = preparedRequestHash({
    path: prepared.path,
    operation: prepared.operation,
    baseVersion: prepared.baseVersion,
    normalizedEdits: prepared.normalizedEdits,
    resultingContent: prepared.resultingContent,
    resultingContentHash: prepared.resultingContentHash,
    diff: prepared.diff,
    sourceIds: prepared.sourceIds,
    credentialIds: prepared.credentialIds,
    reason: prepared.reason
  });
  if (prepared.requestHash !== expectedHash || contentHash(prepared.resultingContent) !== prepared.resultingContentHash) {
    throw new Error("Prepared Memory write has changed after validation");
  }
}

function assertBaseVersion(prepared: PreparedMemoryWrite, current: MemoryFile | undefined): void {
  if (prepared.operation === "create") {
    if (current) throw new Error("Memory already exists at this path");
    return;
  }
  if (!current || current.version !== prepared.baseVersion) throw new Error("Memory changed after the write was prepared");
}

function preparedRequestHash(value: Omit<PreparedMemoryWrite, "approvalId" | "requestHash">): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function memoryDiff(before: string, after: string): string {
  const beforeLines = before.split("\n").map((line) => `-${line}`);
  const afterLines = after.split("\n").map((line) => `+${line}`);
  return ["--- before", "+++ after", ...beforeLines, ...afterLines].join("\n");
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function versionRevision(version: string): number {
  const parsed = Number.parseInt(version.split(":", 1)[0] ?? "0", 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
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

function assertNoSymlinkPath(rootDirectory: string, targetPath: string): void {
  const relativePath = relative(rootDirectory, targetPath);
  let current = rootDirectory;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error("Memory Path cannot contain a symbolic link");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function assertCanonicalMemoryPath(rootDirectory: string, targetPath: string): void {
  const canonicalRoot = realpathSync(rootDirectory);
  const canonicalTarget = realpathSync(targetPath);
  if (canonicalTarget !== canonicalRoot && !canonicalTarget.startsWith(`${canonicalRoot}${sep}`)) {
    throw new Error("Memory Path escapes its controlled root");
  }
}

function listMarkdownFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listMarkdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}

function fileExistsWithoutSymlink(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Memory Path cannot contain a symbolic link");
    return stat.isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function readLedger(path: string): FileRevisionLedger {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<FileRevisionLedger>;
    return {
      sequence: typeof parsed.sequence === "number" ? parsed.sequence : 0,
      pathRevisions: parsed.pathRevisions && typeof parsed.pathRevisions === "object" ? parsed.pathRevisions : {},
      revisions: Array.isArray(parsed.revisions) ? parsed.revisions : []
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sequence: 0, pathRevisions: {}, revisions: [] };
    throw error;
  }
}

function writeLedger(path: string, ledger: FileRevisionLedger): void {
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  writeFileSync(temporaryPath, JSON.stringify(ledger, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, path);
}

function memoryFile(path: string, content: string, updatedAt: string, revision = 0): MemoryFile {
  return {
    path,
    content,
    sourceIds: references(content, /\[SOURCE:(.+?)\]/gu),
    credentialIds: references(content, /\[CREDENTIAL:(.+?)\]/gu),
    updatedAt,
    version: `${revision}:${contentHash(content)}`
  };
}

function references(content: string, pattern: RegExp): readonly string[] {
  return [...new Set([...content.matchAll(pattern)].map((match) => match[1]).filter((value): value is string => Boolean(value)))];
}
