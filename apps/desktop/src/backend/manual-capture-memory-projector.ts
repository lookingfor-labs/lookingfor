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
  const title = protectedContent.split(/\r?\n/u).find((line) => line.trim())?.trim() || "主动保存的信息";
  const credentialReferences = receipt.credentialIds.length
    ? receipt.credentialIds.map((credentialId) => `[CREDENTIAL:${credentialId}]`).join("、")
    : "无";
  return `# ${title}\n\n用户于 ${receipt.savedAt} 主动保存了与“${title}”相关的信息。\n\n- 保密信息：${credentialReferences}\n- 原始记录：[SOURCE:${receipt.sourceId}]\n`;
}
