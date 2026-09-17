# DuckDB 对 lookingfor 的适用性评估

评估日期：2026-09-17

## 结论

**DuckDB 不适合在当前阶段替换 lookingfor 的 SQLCipher 主库，也不值得立即加入正式依赖。** 当前主库承担的是小批量事务写入、按 ID 读取、外键完整性、密码解锁和 SQLCipher 4 文件兼容；DuckDB 的核心定位则是进程内 OLAP，擅长较少但较大的扫描、聚合和批量变更，而不是大量小查询与小事务。[DuckDB 的设计目标](https://duckdb.org/why_duckdb) · [工作负载调优说明](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads)

DuckDB 可以作为**未来可选、可重建、只读优先的搜索/分析索引**进入验证清单。它有官方 Node.js 客户端、原生加密、全文检索、固定长度向量和丰富的分析 SQL；但全文索引不会随底表自动更新，持久化 HNSW 仍不建议用于生产，而且项目目前没有足够明确的 OLAP 需求来抵消新二进制、扩展分发、异步接口和第二份敏感数据的成本。[Node.js Client (Neo)](https://duckdb.org/docs/current/clients/node_neo/overview) · [全文检索](https://duckdb.org/docs/current/core_extensions/full_text_search) · [VSS 扩展](https://duckdb.org/docs/current/core_extensions/vss)

因此建议：

1. 保留 `lookingfor.sqlite`、SQLCipher、现有 schema 与受控 Markdown Memory 作为事实来源；
2. 先抽象 `MemorySearchIndex`，继续以当前纯文本搜索为默认实现；
3. 只有当数据量和查询需求证明简单扫描不足时，才在隔离实验中评估 DuckDB；
4. 即使实验通过，也只让 DuckDB 保存可从 Markdown 或脱敏投影重建的数据，不保存 Credential 明文，不成为写入事实来源。

## 项目当前的数据与查询需求

### 加密关系数据

`SqliteSourceStore` 将 Source、Credential、二者的多对多来源关系和模型连接设置保存在 `lookingfor.sqlite` 中。数据库以用户密码解锁，启用 SQLCipher 4 兼容模式、外键和 WAL；一次保存会在 `BEGIN IMMEDIATE` 事务中完成 Credential 去重、Source 插入和关系写入。[存储实现](../packages/memory-engine/src/sqlite-source-store.ts) · [公开格式与 schema](database-format.md)

实际访问模式主要是：

- 单条 Source/Credential 按主键读取和存在性检查；
- 单条或少量新增、设置项 upsert、清空；
- 用 `lower(...) LIKE '%query%'` 在 ID、类别、脱敏内容和来源关系上做本地包含搜索；
- 结果按 `saved_at` 倒序，并在 Agent 边界处限制返回数量；
- Credential 明文只在用户显式 reveal 时读取，Agent 只能获得受保护的 Source 投影和不透明 Credential ID。[查询实现](../packages/memory-engine/src/sqlite-source-store.ts) · [Agent 边界](../packages/agent-runtime/src/index.ts)

这是小型本地应用的事务型、点查和文本检索负载。代码中目前没有大表聚合、窗口分析、跨文件联邦查询、Parquet/CSV 湖仓或批量 ETL 路径。

### Markdown Memory

长期 Memory 是数据库之外的 `memories/**/*.md`。`FileMemoryStore` 负责路径隔离、版本哈希、原子替换、Revision 审计和撤销；Agent 搜索则在每次请求时列出文件，把路径与内容转为小写后做词项包含匹配和简单计分。[Memory Store](../packages/memory-engine/src/memory-store.ts) · [Memory 搜索](../packages/agent-runtime/src/index.ts)

这里真正可能增长为需求的是关键词、语义或混合召回质量，而不是把 Markdown 的受控写入链改成数据库写入。现有架构文档也已建议把搜索放到可替换的只读索引接口之后，同时保持 Memory Store 为事实来源。[`pi-memory` 评估](pi-memory-evaluation.md)

## DuckDB 的适配点

### 1. 部署形态与桌面应用相符

DuckDB 是嵌入宿主进程、无需独立数据库服务的数据库，和本地优先 Electron 应用在运维形态上相容。[DuckDB 的进程内架构](https://duckdb.org/why_duckdb)

官方推荐的 `@duckdb/node-api`（Node Neo）提供 Promise API，并发布 Linux arm64/x64、macOS arm64/x64 和 Windows x64 二进制；这些平台覆盖项目当前主要桌面目标。旧 `duckdb` Node 包已经弃用，不应作为新实验基础。[Node Neo 功能与支持平台](https://duckdb.org/docs/current/clients/node_neo/overview) · [旧 Node 客户端弃用说明](https://duckdb.org/docs/current/clients/nodejs/overview)

### 2. 分析能力适合未来的本地洞察

DuckDB 的列式、向量化执行面向大范围扫描、连接、聚合和批量变更。如果以后出现“按时间、来源类别和实体统计”“从多份导出文件做本地报告”“批量分析对话历史”等明确需求，它会比把这些分析继续堆在 SQLite 查询或 TypeScript 循环中更匹配。[DuckDB 的 OLAP 定位](https://duckdb.org/why_duckdb)

DuckDB 还能直接查询 JSON、Parquet 等格式；这对未来的离线导入、导出和一次性诊断有价值，但并非当前产品路径已经需要的能力。[JSON 概览](https://duckdb.org/docs/current/data/json/overview) · [Parquet 概览](https://duckdb.org/docs/current/data/parquet/overview)

### 3. 可承载独立的关键词或向量实验

官方 `fts` 扩展可为字符串列建立全文索引，并提供 BM25 匹配；DuckDB 的固定长度 `ARRAY` 能保存 embedding，内置余弦距离、欧氏距离和内积计算。因此，单个引擎可以验证关键词召回、无索引向量扫描以及二者的重排组合。[FTS 扩展](https://duckdb.org/docs/current/core_extensions/full_text_search) · [`ARRAY` 类型](https://duckdb.org/docs/current/sql/data_types/array) · [数组距离函数](https://duckdb.org/docs/current/sql/functions/array)

这类索引适合作为 Markdown Memory 的派生物：写入仍通过 `MemoryStore.commit/revert/reset`，成功后异步刷新索引，索引不可用时回退到现有搜索。

### 4. 已有原生静态加密，但不能与 SQLCipher 画等号

DuckDB 当前支持原生数据库加密，默认使用 AES-256 GCM，并覆盖主数据库、WAL 和临时文件。这意味着“DuckDB 完全没有 at-rest encryption”已经不是有效反对理由。[数据库加密说明](https://duckdb.org/docs/current/sql/statements/attach#database-encryption) · [官方实现介绍](https://duckdb.org/2025/11/19/encryption-in-duckdb)

不过官方仍注明该加密尚未满足正式 NIST 要求；密钥管理也仍由嵌入应用负责。若派生索引包含用户 Memory，实验必须使用加密库、私有文件权限，并验证错误密钥、WAL、临时文件和崩溃恢复行为。[加密限制](https://duckdb.org/docs/current/sql/statements/attach#database-encryption)

### 5. Electron 主进程单写者模式基本吻合

DuckDB 在单进程内支持多线程并发读写；当前生产架构也把持久化放在 Electron 主进程后端，因此单写者假设本身不是障碍。[DuckDB 并发模型](https://duckdb.org/docs/current/connect/concurrency) · [LocalBackend](../apps/desktop/src/backend/local-backend.ts)

## 不适配点与风险

### 1. 当前主负载并不是 DuckDB 的优势区

DuckDB 官方明确说明：其目标不是快速并发执行大量小查询，而是较少、较大的分析查询；默认 row group 为 122,880 行，真正发挥多核并行还需要足够多的行组。[工作负载调优](https://duckdb.org/docs/current/guides/performance/how_to_tune_workloads)

lookingfor 当前每次保存通常只新增一个 Source 和少量 Credential/link，查询多为按 ID、存在性、设置项和少量文本结果。这些路径已经与嵌入式行存 SQLite/SQLCipher 匹配。换用 DuckDB 会增加迁移和打包风险，却没有已证实的查询收益。

### 2. 会破坏现有 SQLCipher 4 文件兼容契约

项目明确承诺 `lookingfor.sqlite` 是 SQLCipher 4 兼容文件，授权程序在获得密码后可用 SQLCipher 客户端访问。[数据库格式](database-format.md)

DuckDB 原生加密使用自己的数据库格式和 `ATTACH ... (ENCRYPTION_KEY ...)` 接口。即使两者都能加密，也不能原地互换；替换意味着新文件格式、全量迁移、外部工具迁移、备份/恢复验证和文档契约变更。[DuckDB 加密数据库接口](https://duckdb.org/docs/current/sql/statements/attach#database-encryption)

DuckDB 的 SQLite 扩展可以读写普通 SQLite 文件，但官方文档没有声明 SQLCipher 兼容。因此不能把“可 attach SQLite”推断成“可直接查询项目现有加密库”。[SQLite 扩展](https://duckdb.org/docs/current/core_extensions/sqlite)

### 3. 现有 schema 不能直接照搬

当前 `credential_sources` 的两个外键都使用 `ON DELETE CASCADE`，数据库 reset 也依赖事务与外键语义保持关系表一致。[当前 schema](../packages/memory-engine/src/sqlite-source-store.ts)

DuckDB 支持外键，但官方明确不支持级联删除。迁移时必须把 link 删除改成显式应用逻辑或触发另一套完整性方案，并补齐异常中断、部分失败和恢复测试；这不是无损驱动替换。[DuckDB 外键限制](https://duckdb.org/docs/current/sql/statements/create_table#foreign-key-constraints)

### 4. FTS 对实时、中英混合 Memory 不是开箱即用

DuckDB 的全文索引不会随底表变化自动更新，官方建议通过 drop/recreate 刷新。lookingfor 的 Memory 写入、撤销和 reset 都要求很快反映到下一次 Agent 搜索，因此必须增加索引失效、重建、搜索降级和状态诊断。[FTS 更新限制](https://duckdb.org/docs/current/core_extensions/full_text_search)

FTS 默认 `ignore` 规则为 `(\.|[^a-z])+`，默认 stemmer/stopwords 也面向英文。由这些默认值可推断，它不能直接承担项目的中文和中英混合检索；需用真实语料验证自定义规则的分词、短词、Credential/Source 引用和召回率，而不能只测英文 demo。[FTS 参数](https://duckdb.org/docs/current/core_extensions/full_text_search#usage)

此外，`fts` 在官方扩展列表中是 Secondary 支持级别，意味着 best-effort 支持；若它成为核心用户路径，需要准备纯文本回退。[核心扩展支持级别](https://duckdb.org/docs/current/core_extensions/overview)

### 5. 持久化向量索引尚不适合作为生产依赖

不使用索引时，可以直接用数组距离函数扫描向量，适合小规模实验。但官方 `vss` 扩展仍标为 experimental；磁盘数据库的 HNSW 持久化默认关闭，打开实验开关后仍存在 WAL 恢复导致数据丢失或索引损坏的已知问题，官方明确不建议用于生产环境。索引还必须整体驻留内存，且不计入 `memory_limit`。[VSS 持久化与限制](https://duckdb.org/docs/current/core_extensions/vss#persistence)

因此 DuckDB 暂时不能凭自身提供“生产可用的持久化语义索引”。embedding 生成、模型分发、索引同步和隐私边界也仍需项目自行解决。

### 6. 会引入新的接口、打包和安全面

当前 `SqliteSourceStore` 与 `LocalBackend` 是同步接口，而官方 Node Neo 客户端采用 Promise API。若替换主库，异步会向后端、IPC 和调用方传播；若只做后台索引，则应把异步限制在独立的搜索适配器中。[Node Neo API](https://duckdb.org/docs/current/clients/node_neo/overview) · [LocalBackend](../apps/desktop/src/backend/local-backend.ts)

FTS/VSS 等扩展是平台相关二进制。DuckDB 默认会从官方仓库自动安装/加载已知扩展，默认安装位置在用户目录；离线桌面产品则需要固定版本、随包提供受信扩展或明确首次下载体验，并覆盖 macOS/Windows 签名和打包测试。[扩展安装位置](https://duckdb.org/docs/current/extensions/installing_extensions#installation-location) · [扩展安全配置](https://duckdb.org/docs/current/operations_manual/securing_duckdb/securing_extensions)

DuckDB SQL 还能访问文件、网络和扩展，官方建议把不可信 SQL 视同可执行代码。项目不应把任意 Agent SQL 暴露给 DuckDB；所有查询必须由应用构造并参数化，同时关闭不需要的外部访问、自动安装和社区扩展，并限制 CPU、内存和临时目录。[嵌入式安全建议](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)

### 7. 多进程外部访问能力比当前预期更窄

DuckDB 原生文件在读写模式下只允许一个写入进程；多个进程能同时打开的稳定模式是全部只读。项目若保留“应用运行时也可由外部授权工具查询”的产品期望，需要单独验证锁行为，而不能假设与 SQLite WAL 相同。[DuckDB 并发模型](https://duckdb.org/docs/current/connect/concurrency)

## 与当前技术路线的共存建议

建议保持以下边界：

```text
受控写入
  ├─ Source / Credential / Settings ──> SQLCipher（唯一关系数据事实源）
  └─ Memory + Revision ───────────────> Markdown（唯一 Memory 事实源）

派生读取（未来可选）
  Markdown / 脱敏 Source 投影 ──> DuckDB 索引 ──> keyword / vector / analytics
                                      │
                                      └─ 失败、过期或未安装时回退到现有搜索
```

具体约束：

- 不让 DuckDB 参与 Credential 明文存储、reveal、密码轮换或主库迁移；
- 不让 Agent 执行任意 SQL，只暴露固定参数的 `search`/`status` 接口；
- DuckDB 文件必须可由事实源完全重建，不进入 Revision 或备份的权威路径；
- `commit/revert/reset` 成功后只发布索引失效事件，索引刷新失败不能回滚事实源写入；
- 搜索结果继续通过现有 `seenSourceIds`/`seenCredentialIds` 和 Memory 引用校验，不因更换检索后端绕开安全边界；
- 第一阶段只索引 AI 本来可读的 Markdown。若以后索引 Source，只允许 `protected_content` 等脱敏投影，绝不复制 `original_content`、`secret` 或模型 API key。

若未来真正出现大量本地分析需求，可以在同一适配器后增加独立的分析投影；这仍不要求替换 SQLCipher 主库。

## 低风险验证方案

验证目标不是证明“DuckDB 能运行”，而是回答“它能否以可接受成本明显改善 Memory 搜索或新增本地分析能力”。整个实验只使用合成数据和独立临时目录，不读取、迁移或修改真实 `lookingfor.sqlite`。

### 阶段 A：集成与安全冒烟

1. 在隔离实验中使用官方 `@duckdb/node-api`，不使用已弃用的 `duckdb` 包。
2. 创建独立加密 `.duckdb` 文件，验证正确/错误密钥、关闭重开、WAL 恢复、临时文件加密和文件权限。
3. 禁用社区扩展、自动安装和不需要的外部访问，固定 `threads`、`memory_limit` 和临时目录限制。
4. 仅加载固定版本的官方 `fts`；分别验证在线安装、完全离线启动和已打包扩展加载。
5. 在 macOS arm64 与 Windows x64 上运行开发、`pack` 和安装包冒烟，记录 native binary、asar、代码签名和升级后的兼容结果。

任一平台必须联网才能启动搜索、扩展无法随应用可靠加载、或加密/恢复不符合预期，即停止正式接入。

### 阶段 B：真实形态的搜索对比

从合成模板生成 1k、10k、100k 份中英混合 Memory 文档，包含同义表达、短词、路径词、`[SOURCE:...]` 与 `[CREDENTIAL:...]` 引用，但不含真实秘密。对比：

- 当前 `PlainText` 包含搜索；
- DuckDB 表扫描；
- 自定义中文规则后的 FTS/BM25；
- 小规模 embedding 的无索引数组距离扫描；
- 关键词 + 向量的简单混合重排。

记录冷/热启动时间、p50/p95 延迟、峰值 RSS、磁盘尺寸、增量写入后的可见延迟、FTS 全量重建时间，以及一组人工标注查询的 Recall@8/MRR。必须专门覆盖 Memory edit、revert、reset、崩溃中断、索引过期时回退和取消查询。

### 阶段 C：基于门槛做决定

仅当以下条件同时成立才实现可选 `DuckDbMemorySearchIndex`：

- 在目标规模和中英混合查询上，召回质量相对现有实现有稳定、可解释的提升；
- p95 延迟、启动时间、内存、索引重建和安装包增量符合桌面体验预算；
- macOS/Windows 安装包可完全离线工作，升级与崩溃后能自动恢复或无损重建；
- 索引只含允许 AI 读取的数据，日志、临时文件和错误信息不泄露明文；
- 索引故障不影响保存、撤销、reset 和当前搜索回退。

即使通过，也先以 feature flag 和诊断页灰度；不启用持久化 HNSW，不替换 SQLCipher，不改变 `MemoryStore` 写入协议。若实验只证明分析 SQL 有价值而搜索收益不足，则保留为开发/诊断工具，不随正式应用分发。

## 最终判断

| 方案 | 判断 | 原因 |
| --- | --- | --- |
| DuckDB 替换 SQLCipher 主库 | 不采用 | 工作负载错位，破坏 SQLCipher 文件契约，外键级联不兼容，异步迁移面大 |
| DuckDB 直接读现有 SQLCipher 文件 | 不采用 | 官方 SQLite 扩展未声明 SQLCipher 兼容，不能据此建立安全承诺 |
| DuckDB 替换 Markdown Memory Store | 不采用 | 会破坏现有文件可读性、Revision、原子写入、审批和引用校验链 |
| DuckDB 作为可重建 Memory 搜索索引 | 有条件验证 | FTS/数组距离有潜力，但中文分词、刷新、离线扩展和资源成本需实测 |
| DuckDB 持久化 HNSW 用于生产语义搜索 | 暂不采用 | 官方仍标为 experimental，持久化与 WAL 恢复存在已知风险 |
| DuckDB 用于未来本地分析/导入导出 | 需求出现后再引入 | 能力匹配，但当前没有足以承担依赖成本的产品需求 |

一句话结论：**现在继续用 SQLCipher + Markdown；把 DuckDB 留在“可重建搜索/分析投影”的实验位，而不是事实存储位。**
