# `pi-memory` 对 BrainBuddy 的适用性评估

评估日期：2026-09-01

## 结论

`pi-memory` **不能作为 npm 扩展直接接入或替换 BrainBuddy 现有 Memory Store**，但其中三类机制值得移植：

1. 分层记忆（长期记忆、每日记录、临时清单）；
2. 有预算、可保持 KV cache 稳定的上下文快照；
3. 基于 qmd 或等价组件的关键词、语义和混合检索。

推荐的接入方式是：保留 BrainBuddy 的文件存储与写入控制，把搜索实现放在一个可替换的只读索引适配器之后。

```text
Agent Runtime
  ├─ write_memory ──> PreparedWrite / Approval / Revision ──> Memory Store
  └─ search_memories ───────────────────────────────────────> Memory Search Index
                                                                  │
Markdown Memory <─────────────── 受控写入 ─────────────────────────┘ 增量索引
```

短期不建议增加 `pi-memory` 依赖。可以先借鉴它的上下文快照与 `memory_status`；需要语义检索时，再验证 qmd 作为独立进程的 Electron 打包、索引目录和隐私边界。

## `pi-memory` 实际是什么

截至评估时，Pi 包目录展示的是 `pi-memory@0.4.2`。它是第三方 `pi-coding-agent` 扩展，而不是 `pi-agent-core` 的通用 Memory Store。包清单把 `index.ts` 声明为 Pi extension；其 peer dependencies 是 `@earendil-works/pi-ai >= 0.81.1` 和 `@earendil-works/pi-coding-agent >= 0.81.1`。[Pi 包目录](https://pi.dev/packages/pi-memory) · [v0.4.2 package.json](https://github.com/jayzeng/pi-memory/blob/v0.4.2/package.json)

它默认在 `~/.pi/agent/memory/` 管理四类文件：

- `MEMORY.md`：精选的长期事实、决策和偏好；
- `daily/YYYY-MM-DD.md`：每日追加日志；
- `SCRATCHPAD.md`：待办式临时清单；
- `recovery/*.json`：删除恢复记录。

它注册 `memory_write`、`memory_forget`、`memory_restore`、`memory_read`、`scratchpad`、`memory_search` 和 `memory_status` 等工具，并通过 `session_start`、`before_agent_start`、`session_before_compact`、`session_shutdown` 等 `pi-coding-agent` 生命周期事件工作。[README](https://github.com/jayzeng/pi-memory/blob/v0.4.2/README.md) · [源码](https://github.com/jayzeng/pi-memory/blob/v0.4.2/index.ts)

## 能带来的价值

### 1. 比当前简单文本匹配更强的召回

BrainBuddy 当前 `search_memories` 在内存中按路径和内容词项计分。`pi-memory` 可选使用 qmd，提供关键词（BM25）、语义（向量）和 deep（混合加重排）三种查询模式；没有 qmd 时，其核心读写工具仍能运行。[搜索说明](https://github.com/jayzeng/pi-memory/blob/v0.4.2/README.md#memory_search-modes)

这适合解决以下问题：

- 用户用不同措辞查询同一事实；
- Memory 文件增多后，逐文件扫描的相关性下降；
- 需要按概念而不是精确关键词召回。

### 2. 上下文预算与稳定快照值得借鉴

它按优先级注入未完成清单、今天日志、长期 Memory 和昨天日志，并把总注入量限制在 16K 字符。默认的 stable 模式只在 session start、压缩前、长期记忆写入和日期切换等检查点刷新快照，以减少提示词前缀变化造成的 KV cache 失效。[上下文注入](https://github.com/jayzeng/pi-memory/blob/v0.4.2/README.md#context-injection) · [稳定快照](https://github.com/jayzeng/pi-memory/blob/v0.4.2/README.md#kv-cache-stable-snapshot-default)

BrainBuddy 目前主要依赖 Agent 主动调用 `search_memories` / `read_memory`。未来可以增加一个受预算约束的“背景 Memory 摘要”，但它只能包含 AI 本来就有权读取的 Markdown，不能包含 Source 原文或 Credential 明文。

### 3. 运行状态诊断适合产品化

`memory_status` 会报告文件位置、qmd、collection、embedding 和配置状态。这对 Electron 用户定位“为何查不到”很有价值。[工具列表](https://github.com/jayzeng/pi-memory/blob/v0.4.2/README.md#tools)

BrainBuddy 可以设计自己的状态页，至少显示：

- Memory Root 与可读写状态；
- Markdown 文件数量和最近更新时间；
- 搜索后端类型；
- 索引文档数、最后更新时间、待索引数量；
- 语义模型是否就绪；
- 最近一次索引错误。

### 4. 删除可恢复的产品语义值得吸收

`memory_forget` 会先写完整 recovery record，再删除匹配块；`memory_restore` 用 recovery ID 恢复。[源码](https://github.com/jayzeng/pi-memory/blob/v0.4.2/index.ts)

BrainBuddy 已有更通用的 Revision 与 revert，因此不应复制第二套 recovery 存储，但可以增加面向 Agent 的 `forget_memory` 工具，把删除表达为受审批的空替换，并返回现有 Revision ID 供撤销。

## 为什么不能直接安装使用

### 1. 运行时接缝不兼容

BrainBuddy 当前锁定 `@earendil-works/pi-agent-core@0.84.4` 与 `pi-ai@0.84.4`，自行注册 Agent 工具和控制 Run；项目没有 `pi-coding-agent`。`pi-memory@0.4.2` 则通过 `ExtensionAPI` 和 coding-agent 生命周期事件注入工具与系统提示。当前 `pi-ai` 已满足其最低版本，但 `pi-coding-agent` 仍不存在，运行时接缝也依然不同。

因此它不是传入当前 `createAgentRuntime()` 的一个 Store，也不能仅靠 `npm install pi-memory` 自动生效。为了加载原扩展而引入整个 coding-agent，会改变现有 Runtime 架构与依赖版本，不应与 Memory 搜索优化绑在一起。

### 2. 它会绕过 BrainBuddy 的写入安全链

`pi-memory` 的写入实现直接调用同步文件 API，长期记忆还支持整份 `overwrite`。它没有 BrainBuddy 已有的：

- `PreparedMemoryWrite` 和用户看到的 exact diff；
- 每 Run 的批准/自动应用策略；
- Revision + content hash 版本冲突检测；
- prepared/applied/failed/reverted 审计状态；
- 临时文件 + rename 原子写入；
- `memories/**/*.md` 路径与 symlink 防逃逸；
- 新 Source/Credential 引用必须属于本 Run seen set 的校验；
- 写入结果与 Run/tool call 的审计关联。

直接启用它的 `memory_write`、`memory_forget` 或生命周期自动写入，会形成一条绕过 `MemoryStore.commit()` 的第二写入通道。这与 BrainBuddy 的核心隐私和可恢复性目标冲突。

### 3. 它不理解 Source / Credential 边界

`pi-memory` 面向普通编码 Agent，Memory 内容默认就是模型可见文本。它不会验证 `[SOURCE:<id>]`、`[CREDENTIAL:<id>]`，也不会阻止 Agent 写入猜测的引用或意外明文。

BrainBuddy 必须继续保持：

- Source 原文和 Credential 明文只在加密数据库；
- Markdown Memory 只保存 AI 可见信息与 opaque 引用；
- 明文凭据只由用户在前端显式触发解密；
- Memory 搜索索引只能索引受控 Markdown，不能索引数据库明文。

### 4. qmd 不是开箱即用的 Electron 内嵌能力

`pi-memory` 通过外部 `qmd` 命令工作，并会创建 collection、执行 `qmd update` / `qmd embed`。首次语义索引还可能下载 embedding 模型；README 也单独说明了 Windows 命令 shim 的处理。[qmd 安装与运行方式](https://github.com/jayzeng/pi-memory/blob/v0.4.2/README.md#optional-enable-search-with-qmd) · [故障排查](https://github.com/jayzeng/pi-memory/blob/v0.4.2/README.md#troubleshooting)

对 BrainBuddy 来说，这会新增：

- macOS/Windows 二进制或 Node CLI 的打包问题；
- 首次下载模型与离线可用性的冲突；
- 索引数据位置、清除数据库/重置 Memory 时的联动；
- 后台进程取消、超时、崩溃与日志脱敏；
- qmd 索引副本的文件权限和隐私审计。

这些需要独立做技术验证，不能把“本机安装了全局 qmd”作为最终 Electron 产品的前提。

## 推荐实施顺序

### 阶段 1：只借鉴，不增加依赖

1. 给现有 Memory 搜索定义 `MemorySearchIndex` 接口，保持 Runtime 不感知具体索引实现。
2. 将当前词项搜索移到默认 `PlainTextMemorySearchIndex`。
3. 增加 `memory_status`/设置页诊断数据。
4. 设计固定字符/token 预算的 Memory Context Snapshot，但默认仍以按需搜索为主。
5. 所有写入、删除和撤销继续只经过现有 Memory Store。

建议接口：

```ts
interface MemorySearchIndex {
  search(query: string, options: {
    mode: "keyword" | "semantic" | "hybrid";
    limit: number;
    signal: AbortSignal;
  }): Promise<readonly MemorySearchHit[]>;

  sync(files: readonly MemoryFile[]): Promise<MemoryIndexStatus>;
  reset(): Promise<void>;
  status(): Promise<MemoryIndexStatus>;
}
```

### 阶段 2：qmd 可行性实验

仅在开发分支做只读适配器，不暴露 `pi-memory` 的写入工具：

1. qmd collection 只指向配置后的 BrainBuddy Memory Root；
2. `MemoryStore.commit/revert/reset` 成功后发索引失效事件；
3. 索引异步更新，失败不影响文件写入；
4. 搜索超时或 qmd 不可用时回退到纯文本搜索；
5. 重置 Memory 时同步清理索引；
6. 验证 macOS arm64、Windows x64 的无全局依赖打包；
7. 检查 qmd 索引和日志不含 Credential 明文。

### 阶段 3：根据实验决定搜索后端

如果 qmd 能稳定随 Electron 分发，则实现 `QmdMemorySearchIndex`；否则选择可嵌入 Node/Electron、数据目录可控的本地全文/向量方案。无论后端为何，Agent 工具协议、Memory Store 和审批链都不变。

## 最终判断

| 方案 | 判断 | 原因 |
| --- | --- | --- |
| 直接安装 `pi-memory` 并加载扩展 | 不采用 | 依赖与生命周期不兼容，并绕过现有安全写入链 |
| 用它替换 BrainBuddy Memory Store | 不采用 | 丢失审批、Revision、原子写入、引用校验和 Run 审计 |
| 移植其全部工具 | 不建议 | 工具语义重复，且会产生第二套删除/恢复模型 |
| 借鉴上下文预算、稳定快照、状态诊断 | 建议 | 与现有架构兼容，能降低上下文成本并改善可观测性 |
| 把 qmd 作为只读搜索索引适配器 | 有条件建议 | 召回收益明确，但需先解决 Electron 分发、索引隐私和重置联动 |
| 借鉴 daily / scratchpad 分层 | 后续可选 | 有产品价值，但应由 BrainBuddy Memory Store 实现和审计 |

一句话结论：**把 `pi-memory` 当作设计参考和搜索实验来源，不把它当作可直接安装的 BrainBuddy Memory 子系统。**
