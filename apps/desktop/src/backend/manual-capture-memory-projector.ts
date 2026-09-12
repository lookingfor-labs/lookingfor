import { randomUUID } from "node:crypto";
import type { DemoSaveReceipt, MemoryFile } from "@brainbuddy/domain";
import type { MemoryStore } from "@brainbuddy/memory-engine/memory";

export class ManualCaptureMemoryProjector {
  readonly #memories: MemoryStore;

  constructor(memories: MemoryStore) {
    this.#memories = memories;
  }

  project(receipt: DemoSaveReceipt): MemoryFile {
    if (receipt.kind !== "capture") throw new Error("Only manually captured Sources can be projected to Memory");
    const path = manualCaptureMemoryPath(receipt.sourceId);
    const prepared = this.#memories.prepare({
      operation: "create",
      path,
      content: manualCaptureMemoryContent(receipt),
      reason: "为主动保存的信息创建 AI 可读索引"
    });
    return this.#memories.commit(prepared, {
      runId: `manual-capture:${receipt.sourceId}`,
      toolCallId: randomUUID(),
      writePolicy: "auto_apply"
    }).memory;
  }
}

export function manualCaptureMemoryPath(sourceId: string): string {
  const fileName = sourceId.replace(/^SOURCE_/u, "");
  return `memories/manual-captures/${fileName}.md`;
}

export function manualCaptureMemoryContent(receipt: DemoSaveReceipt): string {
  const protectedContent = receipt.preview.protectedContent.trim();
  const lines = protectedContent.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const title = lines[0] || "主动保存的信息";
  const sourceReference = `[SOURCE:${receipt.sourceId}]`;
  const details = lines.slice(1).filter((line) => line !== `来源：${sourceReference}` && line !== `来源:${sourceReference}`);
  const detailItems = details.map((line) => `- ${line}`).join("\n");
  return `# ${title}\n\n- 记录方式：用户主动保存\n- 记录时间：${formatManualCaptureSavedAt(receipt.savedAt)}${detailItems ? `\n${detailItems}` : ""}\n- 原始记录：${sourceReference}\n`;
}

export function formatManualCaptureSavedAt(savedAt: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  const date = new Date(savedAt);
  if (Number.isNaN(date.getTime())) return savedAt;
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}（${timeZone}）`;
}
