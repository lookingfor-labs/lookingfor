import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall as coreFauxToolCall } from "@earendil-works/pi-ai";
import { DemoMemorySession } from "@brainbuddy/memory-engine/memory";
import {
  createAgentRuntime,
  createFileAgentRunRecorder,
  requiresDurableMemory,
  type AgentRuntimeEvent,
  type ProtectedRecordReader
} from "./index";

function fauxToolCall(...args: Parameters<typeof coreFauxToolCall>): ReturnType<typeof coreFauxToolCall> {
  const [name, input, options] = args;
  if (name !== "brainbuddy_finish") return coreFauxToolCall(name, input, options);
  const finish = input as Record<string, unknown>;
  const references = Array.isArray(finish.references) ? finish.references as Array<{ kind?: string }> : [];
  return coreFauxToolCall(name, {
    ...finish,
    memoryDecision: finish.memoryDecision ?? {
      action: references.some(({ kind }) => kind === "memory") ? "written" : "not_needed",
      reason: "Scripted test decision"
    }
  }, options);
}

describe("AgentRuntime", () => {
  it("separates required writes, read-only queries, and model-chosen Memory decisions", async () => {
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
      message: "已了解这项临时安排。",
      references: [{ kind: "source", id: "SOURCE_QUERY" }],
      memoryDecision: { action: "not_needed", reason: "这只是临时上下文，不值得写入长期记忆。" }
    }, { id: "model-choice-finish" }), { stopReason: "toolUse" })]);
    const runtime = createAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
      records: protectedRecords(),
      memories: new DemoMemorySession()
    });

    const writeDraft = runtime.prepare({
      message: "记录一下 agentflow 的密码是 [CREDENTIAL:CREDENTIAL_FIGMA]",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "auto_apply"
    });
    const queryDraft = runtime.prepare({
      message: "帮我查找 Figma 登录信息",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "auto_apply"
    });
    const modelChoiceDraft = runtime.prepare({
      message: "我下周五要去体检",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "auto_apply"
    });

    expect(writeDraft.memoryIntent.type).toBe("write_required");
    expect(queryDraft.memoryIntent.type).toBe("read_only");
    expect(modelChoiceDraft.memoryIntent.type).toBe("model_choice");
    await expect(runtime.start(modelChoiceDraft.draftId, () => undefined).done).resolves.toMatchObject({
      status: "completed",
      memoryDecision: { action: "not_needed" }
    });
  });

  it("prevents a pure query from changing Memory even when the model requests a write", async () => {
    const memories = new DemoMemorySession();
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "create",
        path: "memories/query.md",
        content: "A query must not create Memory.",
        reason: "Incorrectly persist a query"
      }, { id: "query-write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "没有找到匹配信息。",
        references: [
          { kind: "source", id: "SOURCE_QUERY" },
          { kind: "credential", id: "CREDENTIAL_FIGMA" }
        ],
        memoryDecision: { action: "not_needed", reason: "本轮是纯查询。" }
      }, { id: "query-finish" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
      records: protectedRecords(),
      memories
    });
    const draft = runtime.prepare({
      message: "帮我查找与 [CREDENTIAL:CREDENTIAL_FIGMA] 有关的 Figma 登录信息",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "auto_apply"
    });
    const errors: unknown[] = [];

    const result = await runtime.start(draft.draftId, (event) => {
      if (event.type === "tool_result" && event.isError) errors.push(event.result);
    }).done;

    expect(result).toMatchObject({ status: "completed", memoryDecision: { action: "not_needed" } });
    expect(memories.list()).toEqual([]);
    expect(errors).toContainEqual({
      code: "MEMORY_WRITE_NOT_ALLOWED",
      message: "A read-only query must not change Memory",
      retryable: true
    });
  });

  it("persists one safe JSONL audit record for a complete Run", async () => {
    const directory = mkdtempSync(join(tmpdir(), "brainbuddy-agent-runs-"));
    try {
      const faux = createFauxCore({ tokensPerSecond: 0 });
      faux.setResponses([fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "No matching record was found.",
        references: [{ kind: "source", id: "SOURCE_QUERY" }]
      }, { id: "audit-finish" }), { stopReason: "toolUse" })]);
      const runtime = createAgentRuntime({
        model: faux.getModel(),
        streamFn: (model, context, options) => {
          void options?.onPayload?.({ model: model.id, messages: context.messages }, model);
          return faux.streamSimple(model, context, options);
        },
        records: protectedRecords(),
        memories: new DemoMemorySession(),
        getApiKey: () => "ORIGINAL_SECRET_SENTINEL",
        recorder: createFileAgentRunRecorder({ directory, now: () => new Date("2026-08-24T08:00:00.000Z") })
      });
      const draft = runtime.prepare({
        message: "Find protected Figma records [SOURCE:SOURCE_QUERY]",
        conversationSourceId: "SOURCE_QUERY",
        writePolicy: "require_approval"
      });
      const handle = runtime.start(draft.draftId, () => undefined);

      await expect(handle.done).resolves.toMatchObject({ status: "completed" });

      const path = join(directory, `${handle.runId}.jsonl`);
      const text = readFileSync(path, "utf8");
      const entries = text.trim().split("\n").map((line) => JSON.parse(line) as { type: string; event?: { type: string } });
      expect(entries[0]?.type).toBe("run_snapshot");
      expect(entries.some(({ event }) => event?.type === "provider_payload")).toBe(true);
      expect(entries.some(({ event }) => event?.type === "agent_completed")).toBe(true);
      expect(text).toContain("Find protected Figma records");
      expect(text).not.toContain("ORIGINAL_SECRET_SENTINEL");
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("completes the Run when debug recording is unavailable", async () => {
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
      message: "Completed without audit storage.", references: [{ kind: "source", id: "SOURCE_QUERY" }]
    }, { id: "recorder-failure-finish" }), { stopReason: "toolUse" })]);
    const runtime = createAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
      records: protectedRecords(),
      memories: new DemoMemorySession(),
      recorder: {
        start() { throw new Error("disk is read-only"); },
        record() { throw new Error("disk is read-only"); }
      }
    });
    const draft = runtime.prepare({ message: "Finish safely", conversationSourceId: "SOURCE_QUERY", writePolicy: "require_approval" });

    await expect(runtime.start(draft.draftId, () => undefined).done).resolves.toMatchObject({
      status: "completed",
      message: "Completed without audit storage."
    });
  });

  it("searches protected local records and finishes with references seen in this Run", async () => {
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("search_local_records", { query: "Figma", limit: 5 }, { id: "search-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "Figma 登录信息来自 SOURCE_FIGMA，凭据为 CREDENTIAL_FIGMA。",
        references: [
          { kind: "source", id: "SOURCE_FIGMA" },
          { kind: "credential", id: "CREDENTIAL_FIGMA" }
        ]
      }, { id: "finish-1" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({
      model: faux.getModel(),
      streamFn: faux.streamSimple,
      records: protectedRecords(),
      memories: new DemoMemorySession()
    });
    const draft = runtime.prepare({
      message: "帮我找到 Figma 登录信息",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "require_approval"
    });
    const events: string[] = [];

    const result = await runtime.start(draft.draftId, (event) => events.push(event.type)).done;

    expect(result).toMatchObject({
      status: "completed",
      message: "Figma 登录信息来自 SOURCE_FIGMA，凭据为 CREDENTIAL_FIGMA。",
      references: [
        { kind: "source", id: "SOURCE_FIGMA" },
        { kind: "credential", id: "CREDENTIAL_FIGMA" }
      ],
      budgets: { toolBatchCount: 1, toolCallCount: 1, modelRequestCount: 2, finishAttemptCount: 1 }
    });
    expect(events).toContain("tool_result");
    expect(events.at(-1)).toBe("agent_completed");
  });

  it("pauses the same Run for approval before committing an exact Prepared Write", async () => {
    const memories = new DemoMemorySession();
    const current = memories.apply({
      operation: "create",
      path: "memories/profile.md",
      content: "Name: Ada",
      reason: "Create profile"
    });
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "edit",
        path: current.path,
        expectedVersion: current.version,
        edits: [{ type: "insert_after", anchor: "Name: Ada", content: "\nTool: Figma" }],
        reason: "Remember the design tool"
      }, { id: "write-1" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "Memory updated.",
        references: [{ kind: "memory", id: current.path }]
      }, { id: "finish-write" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories });
    const draft = runtime.prepare({ message: "Remember that I use Figma", conversationSourceId: "SOURCE_QUERY", writePolicy: "require_approval" });
    let notifyApproval: ((event: Extract<AgentRuntimeEvent, { type: "approval_required" }>) => void) | undefined;
    const approval = new Promise<Extract<AgentRuntimeEvent, { type: "approval_required" }>>((resolve) => { notifyApproval = resolve; });
    const handle = runtime.start(draft.draftId, (event) => {
      if (event.type === "approval_required") notifyApproval?.(event);
    });

    const pending = await approval;
    expect(memories.list()[0]?.content).toBe("Name: Ada");
    expect(pending.prepared.diff).toContain("+Tool: Figma");
    expect(await runtime.resolveApproval(handle.runId, pending.prepared.approvalId, "approve")).toEqual({ status: "approved" });

    await expect(handle.done).resolves.toMatchObject({ status: "completed", message: "Memory updated." });
    expect(memories.list()[0]?.content).toBe("Name: Ada\nTool: Figma");
    expect(memories.listRevisions().at(-1)).toMatchObject({ runId: handle.runId, toolCallId: "write-1", status: "applied" });
  });

  it("auto-applies a validated write only when Revisions are available", async () => {
    const unavailable = new class extends DemoMemorySession {
      override revisionsAvailable(): boolean { return false; }
    }();
    const faux = createFauxCore({ tokensPerSecond: 0 });
    const blockedRuntime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories: unavailable });
    expect(() => blockedRuntime.prepare({ message: "Remember this", conversationSourceId: "SOURCE_QUERY", writePolicy: "auto_apply" }))
      .toThrow("REVISION_STORE_UNAVAILABLE");

    const memories = new DemoMemorySession();
    const current = memories.apply({ operation: "create", path: "memories/auto.md", content: "A", reason: "Create" });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "edit",
        path: current.path,
        expectedVersion: current.version,
        edits: [{ type: "append", content: "B" }],
        reason: "Append B"
      }, { id: "auto-write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "Automatically updated.", references: [{ kind: "memory", id: current.path }]
      }, { id: "auto-finish" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories });
    const events: string[] = [];
    const draft = runtime.prepare({ message: "Append B", conversationSourceId: "SOURCE_QUERY", writePolicy: "auto_apply" });

    await expect(runtime.start(draft.draftId, (event) => events.push(event.type)).done).resolves.toMatchObject({ status: "completed" });
    expect(memories.list()[0]?.content).toBe("AB");
    expect(events).toContain("auto_applied");
    expect(events).not.toContain("approval_required");
  });

  it("requires a Memory write for a newly stated account fact before finishing", async () => {
    expect(requiresDurableMemory("figma 的账号有 aaa@qq.com 和 vvv@qq.com")).toBe(true);
    expect(requiresDurableMemory("帮我查找 GitHub 账号")).toBe(false);
    const memories = new DemoMemorySession();
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "Account received without writing Memory.",
        references: [{ kind: "source", id: "SOURCE_QUERY" }]
      }, { id: "premature-finish" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "create",
        path: "memories/accounts.md",
        content: "Figma accounts: aaa@qq.com, vvv@qq.com\n\nSource: [SOURCE:SOURCE_QUERY]",
        reason: "Remember reusable Figma accounts"
      }, { id: "required-write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "Figma accounts were written to memories/accounts.md.",
        references: [
          { kind: "source", id: "SOURCE_QUERY" },
          { kind: "memory", id: "memories/accounts.md" }
        ]
      }, { id: "finish-after-write" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories });
    const draft = runtime.prepare({
      message: "figma 的账号有 aaa@qq.com 和 vvv@qq.com",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "auto_apply"
    });

    await expect(runtime.start(draft.draftId, () => undefined).done).resolves.toMatchObject({
      status: "completed",
      budgets: { finishAttemptCount: 2 }
    });
    expect(memories.list()).toEqual([
      expect.objectContaining({ path: "memories/accounts.md", content: expect.stringContaining("aaa@qq.com") })
    ]);
  });

  it("allows a durable Memory task to complete after four tool batches and seven calls", async () => {
    const memories = new DemoMemorySession();
    const faux = createFauxCore({ tokensPerSecond: 0 });
    const searchBatch = (prefix: string) => fauxAssistantMessage([
      fauxToolCall("search_memories", { query: `${prefix}-one` }, { id: `${prefix}-one` }),
      fauxToolCall("search_memories", { query: `${prefix}-two` }, { id: `${prefix}-two` })
    ], { stopReason: "toolUse" });
    faux.setResponses([
      searchBatch("batch-1"),
      searchBatch("batch-2"),
      searchBatch("batch-3"),
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "create",
        path: "memories/health-checkups.md",
        content: "下周五去体检\n\n来源：[SOURCE:SOURCE_QUERY]",
        reason: "记录体检安排"
      }, { id: "batch-4-write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "体检安排已写入本地记忆。",
        references: [
          { kind: "source", id: "SOURCE_QUERY" },
          { kind: "memory", id: "memories/health-checkups.md" }
        ]
      }, { id: "finish-after-four-batches" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories });
    const draft = runtime.prepare({
      message: "记一下：下周五去体检\n\n来源：[SOURCE:SOURCE_QUERY]",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "auto_apply"
    });

    await expect(runtime.start(draft.draftId, () => undefined).done).resolves.toMatchObject({
      status: "completed",
      budgets: { toolBatchCount: 4, toolCallCount: 7, modelRequestCount: 5 }
    });
    expect(memories.list()).toEqual([
      expect.objectContaining({ path: "memories/health-checkups.md", content: expect.stringContaining("下周五去体检") })
    ]);
  });

  it("preserves protected Credential and Source references when writing a durable fact", async () => {
    const memories = new DemoMemorySession();
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "create",
        path: "memories/figma.md",
        content: "Figma password is protected.\n\nSource: [SOURCE:SOURCE_QUERY]",
        reason: "Remember the protected Figma password"
      }, { id: "write-without-credential" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "create",
        path: "memories/figma.md",
        content: "Figma password: [CREDENTIAL:CREDENTIAL_FIGMA]\n\nSource: [SOURCE:SOURCE_QUERY]",
        reason: "Preserve the protected Figma password reference"
      }, { id: "write-protected-reference" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "The protected Figma password reference was saved.",
        references: [
          { kind: "source", id: "SOURCE_QUERY" },
          { kind: "credential", id: "CREDENTIAL_FIGMA" },
          { kind: "memory", id: "memories/figma.md" }
        ]
      }, { id: "finish-protected-reference" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories });
    const errors: unknown[] = [];
    const draft = runtime.prepare({
      message: "Figma：[CREDENTIAL:CREDENTIAL_FIGMA]\n\n来源：[SOURCE:SOURCE_QUERY]",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "auto_apply"
    });

    const result = await runtime.start(draft.draftId, (event) => {
      if (event.type === "tool_result" && event.isError) errors.push(event.result);
    }).done;

    expect(result).toMatchObject({ status: "completed" });
    expect(errors).toContainEqual({
      code: "REQUIRED_REFERENCE_MISSING",
      message: "A protected reference required by this durable fact is missing from the Memory write",
      retryable: true
    });
    expect(memories.list()).toEqual([
      expect.objectContaining({
        path: "memories/figma.md",
        content: "Figma password: [CREDENTIAL:CREDENTIAL_FIGMA]\n\nSource: [SOURCE:SOURCE_QUERY]"
      })
    ]);
  });

  it("reports that a durable fact was not saved after the user denies its Memory write", async () => {
    const memories = new DemoMemorySession();
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "create",
        path: "memories/figma.md",
        content: "Figma password: [CREDENTIAL:CREDENTIAL_FIGMA]\n\nSource: [SOURCE:SOURCE_QUERY]",
        reason: "Remember the protected Figma password"
      }, { id: "denied-write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "The Figma password was saved.",
        references: [{ kind: "source", id: "SOURCE_QUERY" }],
        memoryDecision: { action: "denied", reason: "The user denied the prepared Memory write." }
      }, { id: "finish-after-denial" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories });
    const draft = runtime.prepare({
      message: "Figma 密码是 [CREDENTIAL:CREDENTIAL_FIGMA]\n\n来源：[SOURCE:SOURCE_QUERY]",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "require_approval"
    });
    let notifyApproval: ((event: Extract<AgentRuntimeEvent, { type: "approval_required" }>) => void) | undefined;
    const approval = new Promise<Extract<AgentRuntimeEvent, { type: "approval_required" }>>((resolve) => { notifyApproval = resolve; });
    const handle = runtime.start(draft.draftId, (event) => {
      if (event.type === "approval_required") notifyApproval?.(event);
    });
    const pending = await approval;

    expect(await runtime.resolveApproval(handle.runId, pending.prepared.approvalId, "deny")).toEqual({ status: "denied" });
    await expect(handle.done).resolves.toMatchObject({
      status: "completed",
      message: "Memory 写入未获批准，本轮没有修改本地记忆。"
    });
    expect(memories.list()).toEqual([]);
  });

  it("does not complete a durable fact after an approved Memory write loses a version race", async () => {
    const memories = new DemoMemorySession();
    const current = memories.apply({
      operation: "create",
      path: "memories/figma.md",
      content: "Figma account: old@example.com\n\nSource: [SOURCE:SOURCE_QUERY]",
      reason: "Create Figma account Memory"
    });
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("write_memory", {
        operation: "edit",
        path: current.path,
        expectedVersion: current.version,
        edits: [{ type: "replace", oldText: "old@example.com", newText: "new@example.com" }],
        reason: "Update the Figma account"
      }, { id: "racing-write" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "The Figma account was saved.",
        references: [{ kind: "source", id: "SOURCE_QUERY" }]
      }, { id: "finish-after-conflict" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories });
    const errors: unknown[] = [];
    const draft = runtime.prepare({
      message: "Figma 的账号是 new@example.com\n\n来源：[SOURCE:SOURCE_QUERY]",
      conversationSourceId: "SOURCE_QUERY",
      writePolicy: "require_approval"
    });
    let notifyApproval: ((event: Extract<AgentRuntimeEvent, { type: "approval_required" }>) => void) | undefined;
    const approval = new Promise<Extract<AgentRuntimeEvent, { type: "approval_required" }>>((resolve) => { notifyApproval = resolve; });
    const handle = runtime.start(draft.draftId, (event) => {
      if (event.type === "approval_required") notifyApproval?.(event);
      if (event.type === "tool_result" && event.isError) errors.push(event.result);
    });
    const pending = await approval;
    memories.apply({
      operation: "update",
      path: current.path,
      expectedVersion: current.version,
      content: "Figma account: external@example.com\n\nSource: [SOURCE:SOURCE_QUERY]",
      reason: "Simulate a concurrent edit"
    });

    await runtime.resolveApproval(handle.runId, pending.prepared.approvalId, "approve");

    await expect(handle.done).resolves.toMatchObject({ status: "failed" });
    expect(errors).toContainEqual({
      code: "MEMORY_WRITE_REQUIRED",
      message: "A durable fact must be handled with write_memory before finishing",
      retryable: true
    });
    expect(memories.list()[0]?.content).toContain("external@example.com");
  });

  it("cancels an approval wait and expires a late decision", async () => {
    const memories = new DemoMemorySession();
    const current = memories.apply({ operation: "create", path: "memories/cancel.md", content: "before", reason: "Create" });
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([fauxAssistantMessage(fauxToolCall("write_memory", {
      operation: "edit",
      path: current.path,
      expectedVersion: current.version,
      edits: [{ type: "replace", oldText: "before", newText: "after" }],
      reason: "Change"
    }, { id: "cancel-write" }), { stopReason: "toolUse" })]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories });
    const draft = runtime.prepare({ message: "Change it", conversationSourceId: "SOURCE_QUERY", writePolicy: "require_approval" });
    let notifyApproval: ((event: Extract<AgentRuntimeEvent, { type: "approval_required" }>) => void) | undefined;
    const approval = new Promise<Extract<AgentRuntimeEvent, { type: "approval_required" }>>((resolve) => { notifyApproval = resolve; });
    const handle = runtime.start(draft.draftId, (event) => {
      if (event.type === "approval_required") notifyApproval?.(event);
    });
    const pending = await approval;

    await runtime.cancel(handle.runId);

    await expect(handle.done).resolves.toMatchObject({ status: "cancelled", code: "RUN_CANCELLED" });
    expect(await runtime.resolveApproval(handle.runId, pending.prepared.approvalId, "approve")).toEqual({ status: "expired" });
    expect(memories.list()[0]?.content).toBe("before");
  });

  it("rejects a mixed finish batch as a whole before executing another tool", async () => {
    let searches = 0;
    const records: ProtectedRecordReader = {
      search() { searches += 1; return { sources: [], credentials: [], total: 0, truncated: false }; },
      sourceExists(id) { return id === "SOURCE_QUERY"; },
      credentialExists() { return false; }
    };
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("search_local_records", { query: "secret" }, { id: "mixed-search" }),
        fauxToolCall("brainbuddy_finish", {
          message: "Not valid", references: [{ kind: "source", id: "SOURCE_QUERY" }]
        }, { id: "mixed-finish" })
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "Finished safely", references: [{ kind: "source", id: "SOURCE_QUERY" }]
      }, { id: "valid-finish" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records, memories: new DemoMemorySession() });
    const draft = runtime.prepare({ message: "Finish", conversationSourceId: "SOURCE_QUERY", writePolicy: "require_approval" });

    const result = await runtime.start(draft.draftId, () => undefined).done;

    expect(searches).toBe(0);
    expect(result).toMatchObject({ status: "completed", message: "Finished safely", budgets: { finishAttemptCount: 2 } });
  });

  it("rejects an unseen reference and exposes only a safe structured error", async () => {
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "Guessed", references: [{ kind: "source", id: "SOURCE_GUESSED" }]
      }, { id: "guessed-finish" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "No guessed references", references: [{ kind: "source", id: "SOURCE_QUERY" }]
      }, { id: "safe-finish" }), { stopReason: "toolUse" })
    ]);
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records: protectedRecords(), memories: new DemoMemorySession() });
    const draft = runtime.prepare({ message: "Answer", conversationSourceId: "SOURCE_QUERY", writePolicy: "require_approval" });
    const errors: unknown[] = [];

    const result = await runtime.start(draft.draftId, (event) => {
      if (event.type === "tool_result" && event.isError) errors.push(event.result);
    }).done;

    expect(result).toMatchObject({ status: "completed", message: "No guessed references" });
    expect(errors).toContainEqual({ code: "REFERENCE_NOT_SEEN", message: "The reference was not seen in this Run", retryable: true });
  });

  it("redacts unexpected local exceptions before returning them to the model or UI", async () => {
    const faux = createFauxCore({ tokensPerSecond: 0 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("search_local_records", { query: "leak", limit: 5 }, { id: "failing-search" }), { stopReason: "toolUse" }),
      fauxAssistantMessage(fauxToolCall("brainbuddy_finish", {
        message: "Search failed safely", references: [{ kind: "source", id: "SOURCE_QUERY" }]
      }, { id: "finish-after-error" }), { stopReason: "toolUse" })
    ]);
    const records: ProtectedRecordReader = {
      search() { throw new Error("database row contains PLAINTEXT_PASSWORD"); },
      sourceExists(id) { return id === "SOURCE_QUERY"; },
      credentialExists() { return false; }
    };
    const runtime = createAgentRuntime({ model: faux.getModel(), streamFn: faux.streamSimple, records, memories: new DemoMemorySession() });
    const draft = runtime.prepare({ message: "Search", conversationSourceId: "SOURCE_QUERY", writePolicy: "require_approval" });
    const events: AgentRuntimeEvent[] = [];

    const result = await runtime.start(draft.draftId, (event) => events.push(event)).done;
    const serialized = JSON.stringify(events);

    expect(result).toMatchObject({ status: "completed", message: "Search failed safely" });
    expect(serialized).not.toContain("PLAINTEXT_PASSWORD");
    expect(serialized).toContain("TOOL_FAILED");
  });
});

function protectedRecords(): ProtectedRecordReader {
  return {
    search(query, limit) {
      expect(query).toBe("Figma");
      expect(limit).toBe(5);
      return {
        sources: [{
          sourceId: "SOURCE_FIGMA",
          kind: "capture",
          protectedContent: "Figma credential [CREDENTIAL:CREDENTIAL_FIGMA]",
          credentialIds: ["CREDENTIAL_FIGMA"],
          savedAt: "2026-08-08T08:00:00.000Z"
        }],
        credentials: [{
          credentialId: "CREDENTIAL_FIGMA",
          entityType: "password",
          maskedValue: "••••••••",
          sourceIds: ["SOURCE_FIGMA"],
          savedAt: "2026-08-08T08:00:00.000Z"
        }],
        total: 2,
        truncated: false
      };
    },
    sourceExists(sourceId) {
      return sourceId === "SOURCE_QUERY" || sourceId === "SOURCE_FIGMA";
    },
    credentialExists(credentialId) {
      return credentialId === "CREDENTIAL_FIGMA";
    }
  };
}
