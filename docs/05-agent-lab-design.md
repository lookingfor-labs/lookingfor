# 05 Agent 实验室设计方案

状态：首版已实施，可进入页面验收
更新时间：2026-08-23

## 1. 评审目标

本文定义 BrainBuddy Demo 05「Agent 实验室」的产品行为、运行时边界、工具接口和验收标准。评审者应重点检查：

1. Agent 是否能完成受控的本地检索、Memory 读取和 Memory 修改闭环；
2. 自动写入模式是否具有足够的防误写和恢复能力；
3. `write_memory` 是否能表达局部修改，同时保持接口稳定、可审计；
4. Source、Credential 和 Memory 的隐私边界是否覆盖异常、日志、事件和 Revision 等旁路；
5. tool batch、工具调用和模型请求预算是否分别受限；
6. 审批、取消、恢复和终止协议是否由运行时控制，而非依赖事件消费者。

## 2. 当前基础

BrainBuddy 当前已经具备：

- 加密保存 Source 原文，并向 AI 提供保护后的 Source 内容；
- 单独保存 Credential，通过 `[CREDENTIAL:<id>]` 引用，并保留 Credential 与 Source 的来源关系；
- 使用受控 `memories/` 路径保存 AI 可读写的 Markdown Memory；
- Demo 04 通过 pi-ai 和 DeepSeek 完成一次流式调用；
- Demo 04 能展示模型输入、原始回复、动作意图、Memory 修改提案和调用审计；
- Demo 04 的 Memory 修改在模型调用结束后由用户确认执行；
- Demo 05 已接入 pi-agent-core 0.80.2、DeepSeek、受控工具、审批门、Revision 与撤销界面；
- `desktop-dev` 同时支持 Electron 和无图形会话下的浏览器验收。

Demo 05 不应复制 Demo 04。二者的核心差异是：

| Demo | 模型获取上下文的方式 | Memory 修改方式 |
|---|---|---|
| 04 AI 对话 | 调用前一次性装配候选内容，执行单次模型调用 | 调用结束后展示修改提案 |
| 05 Agent 实验室 | 模型在循环中按需调用受控工具 | 调用写入工具，按本次 Run 的策略审批或自动执行 |

## 3. 已确定的产品决策

### 3.1 Source 的生成

Demo 05 属于 AI 对话入口。每次用户提交后，本地系统先完成隐私分析、保存 conversation Source，再启动 Agent。是否生成 Source 由产品流程确定，不交给模型判断。

工具调用、工具查询和审批操作不额外生成 Source。

### 3.2 Agent 可见信息

Agent 可以看到：

- 本次用户输入经过用户策略处理后的内容；
- Source 的保护版本及 Source ID；
- Credential ID、掩码值和来源关系；
- Memory Path、Memory 内容和版本。

Memory 是 AI 可读写的本地文件。用户选择“保留原文”的内容可以出现在 Memory 中，不再叠加一套自动通用脱敏。运行时通过数据投影保证 Source 原文和 Credential 明文没有进入工具结果，而不是对所有 Memory 内容再次替换。

### 3.3 Memory 写入策略

页面提供一个用户可选开关：

```text
Memory 写入策略

● 写入前确认（默认）
○ Agent 自动写入
```

内部使用枚举表达，不使用布尔值：

```ts
type MemoryWritePolicy = "require_approval" | "auto_apply";
```

策略在 Agent Run 开始时形成快照。运行中改变页面开关只影响下一次 Run，不能改变正在执行的 Run。

- `require_approval`：Agent 请求写入后暂停，用户批准或拒绝后继续；
- `auto_apply`：写入通过运行时校验后立即执行，结果直接返回 Agent。

限制写入 `memories/` 只能控制影响范围，不能防止错误覆盖或内容污染。因此，启用 `auto_apply` 前必须具备版本校验、原子写入、修改审计、历史版本和撤销能力。

这是一条 Agent Runtime 硬约束，而不是 UI 显隐规则：

```ts
if (writePolicy === "auto_apply" && !revisionStore.isAvailable()) {
  throw new AgentRunRejectedError("REVISION_STORE_UNAVAILABLE");
}
```

任何入口都不能在 Revision Store 不可用时启动 `auto_apply` Run。

## 4. Agent 工具

Demo 05 开放四个本地能力工具。另有一个不访问本地资源的终止输出协议 `brainbuddy_finish`。

### 4.1 `search_local_records`

用途：搜索 Source 的保护版本和 Credential 元数据。

```ts
interface SearchLocalRecordsInput {
  query: string;
  limit?: number;
}
```

返回内容限定为：

- Source ID、类型、保护后的内容、保存时间；
- Credential ID、类型、掩码值、关联 Source ID；
- 总命中数和是否截断。

该工具不能返回 Source 原文、Source 解密字段、Credential 明文或数据库密钥。

### 4.2 `search_memories`

用途：根据关键词搜索 Memory。

```ts
interface SearchMemoriesInput {
  query: string;
  limit?: number;
}
```

返回 Memory Path、匹配片段、当前版本、Source 引用和 Credential 引用。结果数量和单个片段长度必须受限。

### 4.3 `read_memory`

用途：读取一个已知 Memory Path。

```ts
interface ReadMemoryInput {
  path: string;
}
```

返回：

```ts
interface ReadMemoryResult {
  path: string;
  content: string;
  version: MemoryVersion;
  updatedAt: string;
  sourceIds: readonly string[];
  credentialIds: readonly string[];
}

type MemoryVersion = string;
```

`MemoryVersion` 对调用者是不透明字符串，由“单调递增 Revision + 内容哈希”组成。Revision 检测 BrainBuddy 内发生过的 A → B → A，内容哈希检测 BrainBuddy 外部对 Markdown 文件的直接修改。调用者只能原样回传，不能解析或构造版本。

路径必须通过统一的 Memory Path 校验，只允许 `memories/**/*.md`。Memory Store 还必须拒绝目标文件或任一父目录中的符号链接，并在最终访问前校验 canonical path 仍位于 Memory Root 内。

### 4.4 `write_memory`

用途：创建 Memory，或对现有 Memory 做一个或多个局部修改。

```ts
type WriteMemoryInput =
  | {
      operation: "create";
      path: string;
      content: string;
      reason: string;
    }
  | {
      operation: "edit";
      path: string;
      expectedVersion: string;
      edits: readonly MemoryEdit[];
      reason: string;
    };

type MemoryEdit =
  | {
      type: "replace";
      oldText: string;
      newText: string;
    }
  | {
      type: "insert_before" | "insert_after";
      anchor: string;
      content: string;
    }
  | {
      type: "append";
      content: string;
    };
```

#### 局部替换示例

```json
{
  "operation": "edit",
  "path": "memories/figma.md",
  "expectedVersion": "42:7f83b165...",
  "edits": [
    {
      "type": "replace",
      "oldText": "- 登录账号：old@example.com",
      "newText": "- 登录账号：new@example.com"
    }
  ],
  "reason": "用户更新了 Figma 登录账号"
}
```

指定行的修改使用准确旧文本作为锚点，而不只依赖行号。行号会随其他修改变化；旧文本配合 `expectedVersion` 可以同时验证修改位置和文件版本。界面可以展示行号，但行号不是写入接口的唯一定位依据。

运行时必须遵守：

1. `create` 在文件已经存在时失败；
2. `edit` 必须提供并匹配 `expectedVersion`；
3. `replace` 的 `oldText` 和插入操作的 `anchor` 在应用时必须恰好匹配一次；
4. 零次或多次匹配均拒绝写入，Agent 需要重新读取并提供更大的唯一文本块；
5. 多个 edits 按声明顺序应用到工作副本；
6. 所有 edits 成功后才原子落盘，任意一项失败则文件完全不变；
7. `newText` 为空可以删除局部内容，但首版不允许删除整个 Memory 文件；
8. 单次 edits 数量、输入字节数和结果文件大小必须有限制；
9. Memory 中的 Source/Credential 引用必须通过格式、存在性和本 Run 可见性校验；
10. 返回新版本、实际 diff、提取到的引用及历史版本标识。

不采用整文件覆盖作为常规编辑方式，因为小修改会扩大冲突面并增加无关内容漂移。不采用纯行号替换，因为它不能单独证明 Agent 修改的是预期内容。首版不采用 unified diff，因为解析、模糊匹配和失败诊断会显著增加实现复杂度；以后可以在现有写入模块内部增加 patch 适配器，而不改变外部审批和审计流程。

#### 不可变写入计划

`write_memory` 的参数通过校验后先生成不可变的 `PreparedMemoryWrite`，审批和执行都引用同一个计划：

```ts
interface PreparedMemoryWrite {
  readonly approvalId: string;
  readonly path: string;
  readonly operation: "create" | "edit";
  readonly baseVersion: MemoryVersion | null;
  readonly normalizedEdits: readonly MemoryEdit[];
  readonly resultingContent: string;
  readonly resultingContentHash: string;
  readonly diff: string;
  readonly sourceIds: readonly string[];
  readonly credentialIds: readonly string[];
  readonly requestHash: string;
}
```

用户看到的 diff 必须由该计划生成。`approve(approvalId)` 从运行时取回原计划，重新检查当前版本，然后原样提交其 `resultingContent`；审批后不重新解释模型参数。计划内容、审批卡片和最终 Revision 通过 `requestHash` 关联。

#### Run Reference Set

每个 Run 维护 `seenSourceIds`、`seenCredentialIds` 和 `seenMemoryPaths`。本次 conversation Source，以及搜索或读取工具实际返回的 ID/Path，会进入对应集合。

Memory 新增的引用必须同时满足：记录真实存在，并且属于本 Run 的 seen reference set。目标 Memory 原来已有的引用可以继续保留。这样既防止模型枚举真实 ID，也防止把未检索过的记录错误挂到 Memory 上。

### 4.5 `brainbuddy_finish`

这是结构化终止输出协议，不是本地数据能力。它返回最终消息和本次实际引用：

```ts
interface BrainBuddyFinishInput {
  message: string;
  references: readonly {
    kind: "source" | "credential" | "memory";
    id: string;
  }[];
}
```

运行时拒绝本次 Run 未见过的引用。成功执行后结束 Agent 循环。

`brainbuddy_finish` 必须是所在 AssistantMessage 中唯一的 tool call。只要同一消息还包含其他工具，运行时就在 preflight 阶段拒绝整个 batch，不依赖 pi-agent-core 的混合 batch termination 行为。每个 Run 最多允许两次 finish 尝试；成功后由 Agent Runtime 直接进入 `Completed`，不再发起模型请求。

## 5. 写入执行模型

### 5.1 需要审批

```text
Agent 调用 write_memory
→ 参数、路径、版本和引用校验
→ 生成 diff 与 approval_required 事件
→ 暂停当前工具调用
→ 用户批准或拒绝
→ 批准：原子写入并返回新版本
→ 拒绝：返回结构化 denied 工具结果
→ Agent 根据结果继续下一轮
```

等待用户决策期间没有存活的模型 HTTP 请求，不增加 `modelRequestCount`。取消整个 Run 会终止待审批请求，且不产生写入。

审批等待由工具执行路径中的 `ApprovalGate` 控制：

```ts
const prepared = memoryStore.prepare(input, runReferenceSet);
await approvalGate.wait(prepared, signal);
return memoryStore.commit(prepared);
```

`approval_required` 事件只用于观察和渲染，事件监听器不承担阻塞 Agent 的职责。不能依赖低层 agent loop 事件消费者的异步行为实现审批。

### 5.2 自动写入

```text
Agent 调用 write_memory
→ 参数、路径、版本和引用校验
→ 创建 prepared Revision
→ 原子写入
→ Revision 标记 applied
→ 发出 auto_applied 事件
→ 返回新版本
→ Agent 继续下一轮
```

自动写入模式不跳过任何校验，只跳过人工决策步骤。

### 5.3 撤销

每次成功写入都生成不可由 Agent 修改的 Revision 记录，至少包含：

- Run ID、工具调用 ID、Memory Path；
- 写入策略、修改原因；
- 修改前后版本和内容快照；
- diff、时间和执行结果。

Revision 状态为：

```ts
type RevisionStatus = "prepared" | "applied" | "failed" | "reverted";
```

Memory 文件和 Revision Store 不共享事务，因此执行顺序固定为：创建 `prepared` Revision → 原子替换 Memory → 标记 `applied`。应用启动时检查遗留的 `prepared`，根据 before/after version 与内容哈希恢复为 `applied` 或 `failed`，并产生安全恢复记录。只有建立 `applied` Revision 后，写入工具才向 Agent 返回成功。

Revision 存放在 Agent 无法访问的运行时存储中。撤销通过本地运行时执行，并再次校验当前版本，避免覆盖撤销发生前的新修改。

## 6. 运行时模块与接口

建议新增独立的 `agent-runtime` 模块。对桌面主进程暴露较小的接口，把模型循环、工具注册、审批等待、轮次限制和事件归一化隐藏在实现中：

```ts
interface AgentRuntime {
  prepare(input: PrepareAgentRunInput): AgentRunDraft;
  start(draftId: string, onEvent: (event: AgentRunEvent) => void): AgentRunHandle;
  resolveApproval(
    runId: string,
    approvalId: string,
    decision: "approve" | "deny"
  ): Promise<ApprovalResolution>;
  cancel(runId: string): Promise<void>;
}

interface AgentRunHandle {
  readonly runId: string;
  readonly done: Promise<AgentRunResult>;
}
```

内部依赖两个受控数据接口：

- Protected Record 读取适配器：只返回可提供给 Agent 的 Source/Credential 投影；
- Memory Store 适配器：负责路径安全、读取、写入计划、版本控制、原子落盘、Revision 和撤销；
- Approval Gate：负责不可变写入计划的等待、一次性决策、过期和取消。

审批策略属于 Agent Run，文件一致性规则属于 Memory Store。两者不能混在 UI 或工具回调中重复实现。

Protected Record 适配器只能产生 Safe DTO。数据库实体不能跨过该接缝进入 Agent Runtime；工具结果、事件、调试面板、审计、异常上下文和 Revision 元数据都只能从 Safe DTO 或 Memory DTO 构造。

建议使用与当前 pi-ai 对齐的 `@earendil-works/pi-agent-core@0.80.2`，并使用顺序工具执行模式，以保证写入、审批和审计事件顺序确定。实现必须以 [`v0.80.2` 标签文档](https://github.com/earendil-works/pi/blob/v0.80.2/packages/agent/README.md)、实际类型、源码和定向测试为依据，不能直接按当前 main 文档或更新版本开发。升级 pi 依赖是独立决策，不与 Demo 05 实施绑定。

## 7. Run 预算

pi-agent-core 的 `turn` 是一次模型请求及其后续工具执行。本文把“一条 AssistantMessage 中的一个或多个本地工具请求及对应 ToolResult”称为 `tool batch`，不使用“工具轮次”，避免两种计数混淆。

首版限制：

- `toolBatchCount <= 3`；
- `toolCallCount <= 8`；
- `modelRequestCount <= 5`；
- `finishAttemptCount <= 2`；
- `pendingApprovalCount <= 1`；
- 写入工具顺序执行；
- 第 3 个 tool batch 结束后，只允许模型单独调用 `brainbuddy_finish`；
- 未注册工具、越界路径、无效参数和未知引用全部返回结构化失败，不执行副作用。

所有计数由 Agent Runtime 在模型请求和工具 preflight 前执行硬校验。达到 `modelRequestCount` 或 `finishAttemptCount` 上限后直接结束为预算失败，不能通过向模型追加错误消息继续形成无界循环。

## 8. 页面设计

### 8.1 输入与策略

展示：

- 用户输入框；
- Memory 写入策略开关；
- “准备 Agent Run”和“确认调用 DeepSeek”；
- 准备后生成的 conversation Source ID；
- 本次策略、模型、tool batch/调用/模型请求预算和状态。

启用自动写入时显示持续可见的说明：

> Agent 可以在本次 Run 中直接修改 `memories/` 下的文件。所有修改都会保留历史版本并可撤销。

### 8.2 权限区

列出四个本地工具及状态，并单独列出硬限制：

```text
允许：搜索保护记录、搜索 Memory、读取 Memory、受控修改 Memory
隔离：Source 原文、Credential 明文、数据库密钥
范围：memories/**/*.md
禁止：任意文件访问、Shell、SQL、删除 Memory 文件
```

### 8.3 事件时间线

至少展示：

```text
agent_started
turn_started
model_message_delta
tool_call
tool_result
approval_required
approved / denied / auto_applied
memory_changed
turn_completed
agent_completed / agent_failed / agent_cancelled
```

每个工具事件可展开查看发送给模型的参数、返回给模型的安全结果、耗时和错误。Credential 明文与 Source 原文在任何调试视图中都不可出现。

Run 状态至少包括：`RunningModel`、`RunningTool`、`AwaitingApproval`、`Completed`、`Failed` 和 `Cancelled`。状态一旦进入终态就不能恢复到运行态。

### 8.4 写入检查

审批卡片和自动写入记录都显示：

- Memory Path；
- Agent 修改原因；
- 修改前后 diff；
- Source/Credential 引用；
- 旧版本与预期版本；
- 批准、拒绝或撤销操作；
- 最终工具结果。

## 9. 安全不变量

以下条件必须由运行时保证，不能只依赖系统提示词：

1. Agent 无法取得 Source 原文、Credential 明文和数据库密钥；
2. Agent 只能读取和写入 canonical path 位于 Memory Root 且路径链不含符号链接的合法 Memory Path；
3. 自动写入与审批写入执行完全相同的校验；
4. 每次更新使用 Revision + 内容哈希的乐观版本校验，过期操作和 A → B → A 不会覆盖新内容；
5. 文件写入是原子的，失败不会留下部分内容；
6. Agent 提供的未知引用或本 Run 未见过的新引用不能进入 Memory；
7. 工具输出有数量和大小上限；
8. 未注册工具没有执行路径；
9. 每次成功写入都有 applied Revision；自动写入可撤销；
10. Safe DTO 是 Protected Record 数据跨入 Agent Runtime 的唯一形式；
11. 工具、事件、日志、调试信息和 Revision 元数据不序列化内部数据库实体；
12. 用户取消 Run 后不会继续模型调用或执行待审批写入。

工具失败统一映射为安全错误，不把底层 exception、SQL、文件系统绝对路径或内部对象原样返回给模型和 UI：

```ts
interface SafeToolError {
  readonly code:
    | "VERSION_CONFLICT"
    | "AMBIGUOUS_MATCH"
    | "INVALID_PATH"
    | "UNKNOWN_REFERENCE"
    | "REFERENCE_NOT_SEEN"
    | "LIMIT_EXCEEDED"
    | "APPROVAL_EXPIRED"
    | "RUN_CANCELLED";
  readonly message: string;
  readonly retryable: boolean;
}
```

取消语义固定为：

- `RunningModel`：中止 provider request；
- `RunningTool`：将同一个 `AbortSignal` 传播给工具；
- `AwaitingApproval`：拒绝 Approval Gate promise，并使 Prepared Write 失效；
- 任意状态进入 `Cancelled` 后，迟到的 `resolveApproval` 只返回已过期结果，不能重新激活写入。

## 10. 实施顺序

### 阶段 A：Memory 局部修改模块

- 扩展 Memory Store 的修改接口；
- 实现精确替换、前后插入、追加、不可变 Prepared Write 和原子写入；
- 实现 Revision + 内容哈希版本、Revision 状态恢复与撤销；
- 实现 canonical path 与符号链接防逃逸；
- 使用内存适配器和文件适配器运行相同契约测试。

完成标准：所有修改方式、ABA/外部修改冲突、歧义匹配、部分失败回滚、崩溃恢复、路径逃逸和撤销均有自动化测试。

### 阶段 B：只读 Agent 闭环

- 引入 pi-agent-core；
- 实现 `search_local_records`、`search_memories` 和 `read_memory`；
- 实现 Run Reference Set、Safe DTO 和 Safe Tool Error；
- 实现 tool batch/调用/模型请求预算、取消、唯一 finish 与事件归一化；
- 使用伪模型验证工具循环，不调用真实付费接口。

完成标准：Agent 可以按需搜索、读取并完成回答，且越界工具、混合 finish、未知/未见引用和超预算请求被拒绝；定向测试证明行为符合 pi-agent-core `0.80.2`。

### 阶段 C：审批和自动写入

- 接入 `write_memory`；
- 实现独立 Approval Gate、审批等待和决策 IPC；
- 实现 Run 级写入策略快照；
- 将写入结果送回 Agent 继续推理。

完成标准：批准、拒绝、自动写入、取消、版本冲突和撤销均能完成端到端测试。

### 阶段 D：05 页面与真实 DeepSeek 验收

- 将静态页面替换为可运行界面；
- 展示提示词、模型消息、工具调用、工具结果、审批和审计；
- 接入 DeepSeek 流式运行；
- 通过 it-runner 启动开发环境完成手动验收。

完成标准：下述验收用例可以在页面中复现，且安全载荷可由用户逐项检查。

## 11. 核心验收用例

### 11.1 只读查询

输入：

```text
帮我找到 Figma 的登录信息，并告诉我来自哪条记录。
```

期望：

- 创建本次 conversation Source；
- Agent 搜索本地记录或 Memory；
- 最终回答只包含允许的账号信息、`[CREDENTIAL:...]` 和 `[SOURCE:...]`；
- Source 原文和 Credential 明文没有进入模型载荷；
- 没有修改 Memory。

### 11.2 审批写入

输入：

```text
把新的 Figma 账号更新到记忆里。
```

期望：

- Agent 先读取目标 Memory；
- `write_memory` 使用当前版本和唯一旧文本提出局部替换；
- Agent 暂停，页面展示由不可变 Prepared Write 生成的 diff；
- 用户批准后写入，并将新版本返回 Agent；
- Agent 根据成功结果完成回答。

### 11.3 自动写入与撤销

在 `auto_apply` 模式执行同一请求。

期望：

- 不出现审批阻塞；
- Revision Store 不可用时，Runtime 拒绝启动 Run；
- 所有校验仍执行；
- 页面实时显示 `auto_applied` 和 diff；
- 用户可以撤销，撤销后内容和版本符合预期；
- 修改和撤销都有安全审计记录。

### 11.4 冲突与歧义

期望：

- `expectedVersion` 过期时拒绝写入；
- 文件经历 A → B → A 或被外部直接修改时拒绝旧写入；
- 旧文本出现多次时拒绝写入；
- Agent 获得结构化错误后可以重新读取并重试；
- 失败期间文件内容没有变化。

### 11.5 预算、终止与取消

期望：

- `brainbuddy_finish` 与其他工具混合出现时整个 batch 被拒绝；
- 超过 tool batch、工具调用、模型请求或 finish 尝试上限时 Run 有界失败；
- AwaitingApproval 状态取消后，迟到的批准不能执行 Prepared Write；
- 运行中的 provider request 和工具都收到取消信号。

### 11.6 路径与旁路泄露

期望：

- 文件或父目录为符号链接时读写被拒绝；
- Source 原文和 Credential 明文不出现在工具结果、异常、事件、日志、Revision 元数据和调试序列化中；
- 新引用真实存在但未被本 Run 看见时仍被拒绝；已有 Memory 引用可以原样保留。

## 12. 评审结论与实施前核对

已接受的结论：

- 首版使用精确文本编辑，不实现 unified diff；
- Revision、恢复和撤销是 `auto_apply` 的运行时硬前置条件；
- 审批阻塞同一个 Run，由 Approval Gate 控制；
- `brainbuddy_finish` 独占一个 AssistantMessage，并受尝试次数和模型请求总数限制；
- 新引用同时通过存在性与 Run Reference Set 校验；
- Memory Store、Agent Runtime、Approval Gate 和 Protected Record 适配器各自保持单一职责。

实施时已完成以下核对：

1. MemoryVersion 使用 Revision 序号与内容哈希组成的 opaque version，Revision 使用独立 JSON ledger 持久化；
2. Protected Record 只通过 Source/Credential Safe DTO 进入 Runtime；
3. 使用 `v0.80.2` 实际 API 和伪模型固定 sequential batch、AbortSignal、terminate 与事件顺序行为；
4. tool batch、工具调用、模型请求、finish 尝试分别计数，混合 finish batch 在执行前整体拒绝；
5. 已覆盖符号链接、ABA、外部修改、歧义编辑、异常脱敏、迟到审批、取消和 Run Reference Set 回归测试；
6. Revision Store 不可用时 Runtime 会在准备阶段拒绝 `auto_apply`；
7. DeepSeek function schema 顶层统一为 object，create/edit 的条件约束由 Runtime 二次校验；
8. 创建和编辑产生的 Revision 都可撤销；撤销创建会删除对应 Memory 文件。

当前实现验证基线：仓库测试 50 项通过，所有 workspace 类型检查通过，桌面生产构建通过，真实 DeepSeek 只读 Agent Run 完成并产生 `brainbuddy_finish`。写入审批与自动撤销通过伪模型端到端测试，保留给页面手动验收。
