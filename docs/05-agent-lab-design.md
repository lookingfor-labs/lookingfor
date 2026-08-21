# 05 Agent 实验室设计方案

状态：待评审
更新时间：2026-08-21

## 1. 评审目标

本文定义 BrainBuddy Demo 05「Agent 实验室」的产品行为、运行时边界、工具接口和验收标准。评审者应重点检查：

1. Agent 是否能完成受控的本地检索、Memory 读取和 Memory 修改闭环；
2. 自动写入模式是否具有足够的防误写和恢复能力；
3. `write_memory` 是否能表达局部修改，同时保持接口稳定、可审计；
4. Source、Credential 和 Memory 的隐私边界是否与现有领域定义一致；
5. 三轮工具调用限制是否定义清楚且可执行。

## 2. 当前基础

BrainBuddy 当前已经具备：

- 加密保存 Source 原文，并向 AI 提供保护后的 Source 内容；
- 单独保存 Credential，通过 `[CREDENTIAL:<id>]` 引用，并保留 Credential 与 Source 的来源关系；
- 使用受控 `memories/` 路径保存 AI 可读写的 Markdown Memory；
- Demo 04 通过 pi-ai 和 DeepSeek 完成一次流式调用；
- Demo 04 能展示模型输入、原始回复、动作意图、Memory 修改提案和调用审计；
- Demo 04 的 Memory 修改在模型调用结束后由用户确认执行；
- Demo 05 当前只有静态界面，没有 Agent 运行时。

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
  version: string;
  updatedAt: string;
  sourceIds: readonly string[];
  credentialIds: readonly string[];
}
```

路径必须通过统一的 Memory Path 校验，只允许 `memories/**/*.md`。

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
  "expectedVersion": "当前文件的 SHA-256 版本",
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
9. Memory 中的 Source/Credential 引用必须通过格式与存在性校验；
10. 返回新版本、实际 diff、提取到的引用及历史版本标识。

不采用整文件覆盖作为常规编辑方式，因为小修改会扩大冲突面并增加无关内容漂移。不采用纯行号替换，因为它不能单独证明 Agent 修改的是预期内容。首版不采用 unified diff，因为解析、模糊匹配和失败诊断会显著增加实现复杂度；以后可以在现有写入模块内部增加 patch 适配器，而不改变外部审批和审计流程。

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

等待用户决策不计入模型轮次，也不占用模型请求超时。取消整个 Run 会终止待审批请求，且不产生写入。

### 5.2 自动写入

```text
Agent 调用 write_memory
→ 参数、路径、版本和引用校验
→ 保存修改前版本
→ 原子写入
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

Revision 存放在 Agent 无法访问的运行时存储中。撤销通过本地运行时执行，并再次校验当前版本，避免覆盖撤销发生前的新修改。

## 6. 运行时模块与接口

建议新增独立的 `agent-runtime` 模块。对桌面主进程暴露较小的接口，把模型循环、工具注册、审批等待、轮次限制和事件归一化隐藏在实现中：

```ts
interface AgentRuntime {
  prepare(input: PrepareAgentRunInput): AgentRunDraft;
  start(draftId: string, onEvent: (event: AgentRunEvent) => void): AgentRunHandle;
  resolveApproval(runId: string, approvalId: string, decision: "approve" | "deny"): void;
  cancel(runId: string): void;
}
```

内部依赖两个受控数据接口：

- Protected Record 读取适配器：只返回可提供给 Agent 的 Source/Credential 投影；
- Memory Store 适配器：负责路径校验、读取、局部修改、版本控制、原子落盘和 Revision。

审批策略属于 Agent Run，文件一致性规则属于 Memory Store。两者不能混在 UI 或工具回调中重复实现。

建议使用与当前 pi-ai 对齐的 `@earendil-works/pi-agent-core@0.80.2`，并使用顺序工具执行模式，以保证写入、审批和审计事件顺序确定。

## 7. 轮次与限制

一个“工具轮次”定义为：一条 AssistantMessage 中的一个或多个工具请求，以及对应的一批 ToolResult。最终 `brainbuddy_finish` 不计入工具轮次。

首版限制：

- 最多 3 个工具轮次；
- 工具总调用数另设上限，建议 8 次；
- 写入工具顺序执行；
- 同一时间最多存在一个待审批写入；
- 第 3 个工具轮次结束后，只允许模型调用 `brainbuddy_finish`；
- 未注册工具、越界路径、无效参数和未知引用全部返回结构化失败，不执行副作用。

## 8. 页面设计

### 8.1 输入与策略

展示：

- 用户输入框；
- Memory 写入策略开关；
- “准备 Agent Run”和“确认调用 DeepSeek”；
- 准备后生成的 conversation Source ID；
- 本次策略、模型、轮次预算和状态。

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
2. Agent 只能读取和写入合法 Memory Path；
3. 自动写入与审批写入执行完全相同的校验；
4. 每次更新使用乐观版本校验，过期操作不会覆盖新内容；
5. 文件写入是原子的，失败不会留下部分内容；
6. Agent 提供的未知引用不能进入 Memory；
7. 工具输出有数量和大小上限；
8. 未注册工具没有执行路径；
9. 每次写入都可审计；自动写入可撤销；
10. 用户取消 Run 后不会继续模型调用或执行待审批写入。

## 10. 实施顺序

### 阶段 A：Memory 局部修改模块

- 扩展 Memory Store 的修改接口；
- 实现精确替换、前后插入、追加、版本冲突和原子写入；
- 实现 Revision 与撤销；
- 使用内存适配器和文件适配器运行相同契约测试。

完成标准：所有修改方式、冲突、歧义匹配、部分失败回滚和撤销均有自动化测试。

### 阶段 B：只读 Agent 闭环

- 引入 pi-agent-core；
- 实现 `search_local_records`、`search_memories` 和 `read_memory`；
- 实现三轮限制、取消、结构化终止与事件归一化；
- 使用伪模型验证工具循环，不调用真实付费接口。

完成标准：Agent 可以按需搜索、读取并完成回答，且越界工具和未知引用被拒绝。

### 阶段 C：审批和自动写入

- 接入 `write_memory`；
- 实现审批等待和决策 IPC；
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
- Agent 暂停，页面展示 diff；
- 用户批准后写入，并将新版本返回 Agent；
- Agent 根据成功结果完成回答。

### 11.3 自动写入与撤销

在 `auto_apply` 模式执行同一请求。

期望：

- 不出现审批阻塞；
- 所有校验仍执行；
- 页面实时显示 `auto_applied` 和 diff；
- 用户可以撤销，撤销后内容和版本符合预期；
- 修改和撤销都有安全审计记录。

### 11.4 冲突与歧义

期望：

- `expectedVersion` 过期时拒绝写入；
- 旧文本出现多次时拒绝写入；
- Agent 获得结构化错误后可以重新读取并重试；
- 失败期间文件内容没有变化。

## 12. 请评审者回答的问题

1. `write_memory` 的精确文本编辑是否足以覆盖 Demo，还是首版就应支持 unified diff？
2. `auto_apply` 是否必须以 Revision 和撤销能力完成为启用前置条件？
3. 三个工具轮次、八次工具调用的双重限制是否合理？
4. `brainbuddy_finish` 作为输出协议不计入工具轮次是否清晰？
5. 写入审批应该阻塞同一个 Agent Run，还是结束 Run 并由新 Run 接续？
6. 工具和事件中是否还存在可能泄露 Source 原文或 Credential 明文的字段？
7. Memory 引用存在性校验是否还需要更强的内容规则？
8. 当前模块接口是否把审批策略、Agent 循环和文件一致性放在了正确的接缝上？
