# BrainBuddy Demo 开发说明

> 暂定项目名：BrainBuddy  
> 当前阶段：电脑端独立功能技术验证 Demo  
> 技术栈原则：全部使用 TypeScript  
> 本文用途：作为 Codex 开始实现该项目时的总上下文与约束说明

---

## 1. 产品背景

用户希望把个人知识、备忘、账号、密码、API Key、项目记录等信息长期交给 AI 辅助管理，以减少记忆负担。

但存在一个核心矛盾：

- 用户希望使用 OpenAI、Claude、Gemini 或其他 OpenAI-compatible API 的云端大模型能力；
- 用户又不希望密码、Token、身份信息、私人记录等敏感原文被发送给模型厂商；
- 用户不希望依赖昂贵、复杂的本地大模型部署；
- 用户希望所有个人知识和原始数据都保存在自己的设备上；
- 用户希望即使不使用 AI，也可以离线保存、浏览和检索数据；
- 用户希望数据格式和加密方案足够通用，避免被 BrainBuddy 锁定。

BrainBuddy 的核心目标不是“把用户全部数据上传给 AI”，而是：

> 让 AI 能够使用用户的记忆，但不能拥有用户的原始记忆。

---

## 2. 产品定位

BrainBuddy 是一个本地优先的个人记忆与隐私信息管理工具。

它帮助用户：

1. 保存普通备忘、项目记录、人物、公司等长期信息；
2. 保存密码、API Key、Token 等高敏感凭证；
3. 通过本地关键字快速查询已有信息；
4. 在本地查询不足时，利用外部大模型进行自然语言模糊检索、关联和总结；
5. 在调用外部 AI 前自动识别敏感信息并生成脱敏版本；
6. 在 AI 返回结果后，在本地按需还原真实信息；
7. 随时查看原始内容、AI 可见版本以及实际发送给模型的内容。

一句话原则：

> 本地保存是基础，离线检索是默认，AI 查询是增强，脱敏处理是边界，用户确认是最终权限。

---

## 3. 当前 Demo 的目标

当前不是开发完整产品，而是实现电脑端独立功能技术验证。

Demo 需要验证以下核心闭环：

```text
用户输入一段内容
    ↓
本地检测其中的敏感信息
    ↓
用户确认每个敏感项的处理策略
    ↓
原始内容加密保存在本地
    ↓
生成可供本地检索和 AI 使用的脱敏视图
    ↓
用户通过关键字离线查询
    ↓
关键字不足时，使用外部 AI 对脱敏候选进行模糊判断或总结
    ↓
AI 返回语义标记或脱敏答案
    ↓
BrainBuddy 在本地按需还原真实信息
```

Demo 成功的核心标准：

- 真实密码、Token、私钥不得进入 AI 请求；
- 用户可以清楚看到原文和 AI 可见版本；
- 常见查询可以完全离线完成；
- 模糊查询可以让 AI 从脱敏候选中找到正确记录；
- Agent 无法直接访问原始数据库、数据库密钥和凭证明文；
- 用户可以通过公开格式或独立工具导出自己的数据。

---

## 4. 当前明确不做的内容

Demo 阶段不做：

- 手机端；
- 多设备同步；
- 用户账号系统；
- 云端存储；
- 团队协作；
- 浏览器自动填充；
- 外部程序调用 BrainBuddy；
- BrainBuddy 主动调用其他应用；
- 定时提醒；
- 主动管家；
- 音频和视频脱敏；
- 图片隐私识别；
- 复杂多模态报表；
- 完整知识图谱；
- 完整密码管理器能力；
- 通用自主 Agent；
- 任意 Shell、SQL 或文件系统工具；
- 后台长期任务；
- 多 Agent 协同。

当前只聚焦文字内容和网站账号密码场景。

---

## 5. 核心设计理念

### 5.1 一份事实来源，两种内容视图，一个凭证保险库

BrainBuddy 不应维护两套互相独立的记忆文件。

正确的数据模型是：

```text
原始记忆
    ↓ 派生
AI 可用视图

高敏感值
    ↓ 抽离
凭证保险库
```

#### 原始记忆

- 保存用户真实输入；
- 是唯一事实来源；
- 本地加密；
- 不直接发送给 AI；
- 用户可以查看、编辑和删除。

#### AI 可用视图

- 由原始记忆和隐私规则生成；
- 可以缓存，但必须可重建；
- 用于本地全文检索；
- 用于构造 AI 上下文；
- 不等于公开数据；
- 仍然只保存在本地；
- 只在用户真正发起 AI 查询时选择必要片段发送。

#### 凭证保险库

用于保存：

- 密码；
- API Key；
- Token；
- 私钥；
- 恢复码；
- 其他高敏感 Secret。

真实凭证值不应长期保留在普通记忆正文中。

示例：

```text
用户输入：
今天张伟给了我 Figma 密码 A9x!4mQ2#pL7，用于 AgentFlow 设计。

原始记忆：
今天张伟给了我 Figma 的登录凭证，用于 AgentFlow 设计。

AI 可用视图：
今天 [PERSON_A] 提供了 [CREDENTIAL_FIGMA]，用于 AgentFlow 设计。

凭证保险库：
[CREDENTIAL_FIGMA] → A9x!4mQ2#pL7
```

### 5.2 Agent 不是安全边界

Agent 只能作为模型协议和工具调用编排器。

Agent 不得：

- 直接打开数据库；
- 直接访问 SQLCipher 密钥；
- 直接访问凭证明文；
- 执行任意 SQL；
- 读取任意文件路径；
- 执行 Shell；
- 绕过 Privacy Engine；
- 永久写入或删除数据。

Agent 只能调用白名单业务工具，例如：

```text
search_protected_memories
get_protected_memory
search_credential_metadata
```

Agent 只能得到脱敏结果和凭证引用，不能得到真实 Secret。

### 5.3 应用主导，模型辅助

BrainBuddy 处理优先级：

```text
L0：纯本地
L1：本地检索 + 单次 AI
L2：受控 Agent Tool Loop
```

#### L0 纯本地

适用：

- 精确关键字查询；
- 密码、账号、Token 查询；
- 保存；
- 编辑；
- 删除；
- 分类浏览。

#### L1 本地检索 + 单次 AI

适用：

- 从脱敏候选中选择最相关记录；
- 总结若干相关记忆；
- 生成标题或标签；
- 简单模糊理解。

#### L2 受控 Agent Loop

仅用于需要多次查询和比较的复杂问题。

Demo 中最多允许 3 轮工具调用。

### 5.4 先规则识别，再考虑本地模型

Demo 第一阶段不引入 Core ML、自定义 NER 或本地小型 LLM。

优先使用：

- 正则表达式；
- 格式验证；
- 关键字上下文；
- 高熵字符串检测；
- 已有实体库；
- 用户历史策略。

需要优先覆盖的高风险场景：

- 密码；
- GitHub Token；
- 常见 API Key；
- JWT；
- 私钥块；
- 数据库连接字符串；
- 邮箱；
- 手机号；
- 身份证；
- 银行卡；
- IP、域名；
- 用户已知人物、公司和项目。

后续才考虑系统 NER 或轻量本地模型。

---

## 6. 统一交互原则

BrainBuddy 最终可能不是纯聊天产品，但 Demo 使用统一输入区。

输入模式：

```text
自动判断
保存
查询
```

它们是同一个输入框的处理意图，而不是三个独立页面。

### 输入内容触发保护建议

当用户输入：

```text
今天张伟把 Figma 登录密码发给我，
账号是 luyong@example.com，
密码是 A9x!4mQ2#pL7。
```

APP 应以内联方式展示：

```text
检测到保护建议

张伟
类型：人物
原因：命中实体库
建议：替换为 [PERSON_A]

luyong@example.com
类型：账号
原因：邮箱格式
建议：仅保留在原始记忆

A9x!4mQ2#pL7
类型：密码
原因：关键词 + 高熵字符串
建议：存入凭证保险库
```

用户可以为每个检测项选择：

```text
保留原文
替换标记
仅保留在原始记忆
存入凭证保险库
```

高风险信息默认禁止发送给 AI。

---

## 7. Demo 技术栈

全部使用 TypeScript。

建议技术栈：

```text
Electron
React
TypeScript
Zod
pi-ai
pi-agent-core
SQLite / SQLCipher
Vitest
Playwright
```

功能验证早期可以先使用普通 SQLite 和假凭证数据，验证交互、数据模型和 Agent 流程。

在安全存储实验阶段必须切换到 SQLCipher，不得使用真实密码测试普通 SQLite 版本。

---

## 8. 推荐进程与权限架构

即使全部使用 TypeScript，也不能把所有能力放进同一个 Electron 上下文。

建议至少划分为三个边界：

```text
Renderer Process
    ↓ 窄 IPC
Private Core
    ↓ 只返回脱敏数据
Agent Worker
```

### 8.1 Renderer

负责：

- React UI；
- 用户输入；
- 保护建议展示；
- 用户确认；
- 搜索结果展示；
- AI 流式结果；
- 原文和 AI 视图对照；
- 调试和信任面板。

限制：

- 禁止 Node Integration；
- 启用 Context Isolation；
- 启用沙箱；
- 不得直接访问数据库；
- 不得读取密钥；
- 不得读取文件系统；
- 不得持有 API Key。

### 8.2 Private Core

唯一允许访问：

- SQLCipher；
- 数据库密钥；
- 原始记忆；
- 凭证明文；
- 系统 Keychain；
- Privacy Engine；
- Protected View Builder。

Private Core 提供窄业务接口：

```text
memory.saveCandidate
memory.searchProtected
memory.getOriginal
privacy.analyzeInput
privacy.buildProtectedView
credential.save
credential.searchMetadata
credential.reveal
audit.list
```

其中高风险接口必须要求明确授权。

### 8.3 Agent Worker

使用：

```text
pi-ai
pi-agent-core
```

Agent Worker 负责：

- 外部模型调用；
- 流式响应；
- 工具调用解析；
- 最多 3 轮工具循环；
- Provider 适配。

Agent Worker 不得：

- 打开数据库；
- 持有数据库密钥；
- 持有凭证明文；
- 读取任意文件；
- 执行 SQL；
- 执行 Shell。

它只能通过 Tool Gateway 调用：

```text
search_protected_memories
get_protected_memory
search_credential_metadata
```

---

## 9. 推荐项目目录

```text
brainbuddy-lab/
├── apps/
│   └── desktop/
│       ├── main/
│       ├── renderer/
│       ├── preload/
│       └── agent-worker/
│
├── packages/
│   ├── domain/
│   ├── shared-contracts/
│   ├── privacy-engine/
│   ├── memory-engine/
│   ├── credential-vault/
│   ├── search-engine/
│   ├── tool-gateway/
│   ├── ai-gateway/
│   ├── agent-runtime-pi/
│   ├── persistence/
│   ├── key-manager/
│   └── audit/
│
├── tests/
│   ├── privacy-corpus/
│   ├── retrieval-corpus/
│   ├── agent/
│   └── security/
│
└── tools/
    ├── brainbuddy-inspect/
    └── brainbuddy-export/
```

---

## 10. 包职责

### domain

定义核心领域对象：

```ts
Memory
ProtectedMemory
DetectedEntity
EntityMapping
Credential
CredentialMetadata
ProtectionPolicy
AgentRequest
AgentEvent
AuditEvent
```

不得依赖 Electron、数据库和 Pi。

### shared-contracts

定义：

- IPC 输入输出；
- Tool Schema；
- Zod Schema；
- Renderer 与 Main 共享事件；
- Private Core 与 Agent Worker 共享协议。

### privacy-engine

负责：

- KeywordRecognizer；
- RegexRecognizer；
- FormatValidator；
- EntropyRecognizer；
- KnownEntityRecognizer；
- RiskScorer；
- PolicyEngine；
- Tokenizer；
- ProtectedViewBuilder。

输出必须包含：

```ts
{
  text: string;
  start: number;
  end: number;
  type: string;
  risk: "low" | "medium" | "high" | "critical";
  reason: string[];
  suggestedPolicy: ProtectionPolicy;
}
```

### memory-engine

负责：

- 保存原始记忆；
- 生成和保存保护视图；
- 版本管理；
- 来源关系；
- 实体关联；
- 编辑和删除；
- 保证保护视图可重建。

### credential-vault

负责：

- 保存高敏感值；
- 返回凭证元数据；
- 本地显示；
- 复制；
- 剪贴板过期清理；
- 高风险授权检查。

Agent 不得依赖此包。

### search-engine

负责：

- SQLite FTS5；
- 关键字检索；
- 类型过滤；
- 时间过滤；
- 实体别名；
- 凭证元数据查询；
- 查询结果排序。

搜索索引不得包含真实密码、Token 和私钥。

### tool-gateway

负责 Agent 工具调用的安全边界：

- 白名单检查；
- Zod 参数校验；
- 查询长度限制；
- 返回数量限制；
- 隐私策略；
- 二次脱敏；
- 审计；
- 拒绝未知工具。

### ai-gateway

负责：

- OpenAI-compatible API 配置；
- Base URL、API Key、Model；
- 流式输出；
- 超时；
- 重试；
- 能力检测；
- 结构化输出；
- 普通文本降级。

必须支持三种模式：

```text
A. 原生 Tool Calling
B. 结构化 JSON
C. 本地预检索后普通 Prompt
```

### agent-runtime-pi

只封装：

- pi-ai；
- pi-agent-core；
- Agent Loop；
- Tool Event；
- 流式事件；
- 最大工具调用次数；
- 取消；
- Provider 适配。

该包不得直接依赖 persistence 或 credential-vault。

### persistence

负责：

- SQLite / SQLCipher；
- schema；
- migration；
- repository adapter；
- transaction；
- FTS5。

### key-manager

负责：

- 生成随机数据库密钥 DEK；
- 主密码派生 KEK；
- 解密和包装 DEK；
- 后续接入系统 Keychain。

Demo 安全阶段建议：

```text
用户主密码
    ↓ Argon2id
KEK
    ↓ 解密
随机 DEK
    ↓
SQLCipher
```

用户主密码不得直接作为 SQLCipher 数据库密钥。

### audit

记录：

- 输入检测；
- 用户确认；
- 保护视图生成；
- 本地查询；
- AI 请求；
- 实际发送内容；
- Agent 工具调用；
- 本地还原行为。

审计日志不得记录：

- 密码明文；
- Token 明文；
- 私钥；
- 数据库密钥；
- 用户主密码。

---

## 11. 数据模型建议

### memories

```text
id
original_content
created_at
updated_at
version
status
```

### protected_memories

```text
id
source_memory_id
protected_content
privacy_rule_version
entity_mapping_version
generated_at
```

### detected_entities

```text
id
memory_id
start
end
original_text
entity_type
risk
reason
selected_policy
mapping_id
credential_id
```

### entity_mappings

```text
id
canonical_name
entity_type
token
default_policy
aliases
```

### credentials

```text
id
service
account_hint
encrypted_secret
metadata
created_at
updated_at
```

### audit_logs

```text
id
event_type
safe_payload
created_at
```

---

## 12. 初步 Demo 计划

### Demo 1：敏感信息检测器

实现：

- 关键字检测；
- 正则检测；
- 格式验证；
- 高熵字符串；
- 已有实体库；
- 风险评分；
- 处理建议。

测试数据至少 100 条：

- 50 条含敏感信息；
- 25 条普通文本；
- 25 条容易误判文本。

要求：

- 私钥、明确 Token 基本不得漏报；
- 普通项目名不得大量误报；
- 短文本检测基本无感。

### Demo 2：原文、保护视图与凭证抽离

实现：

- 原始内容；
- AI 可用版本；
- 凭证抽离；
- 四种处理策略；
- 保存前预览；
- 用户修改策略；
- 稳定语义标记。

要求：

- 高风险 Secret 不得进入 AI 视图；
- 编辑原文后可重新生成保护视图；
- Token 与原始实体关系可追踪。

### Demo 3：本地存储

第一步：

- 普通 SQLite；
- 假数据；
- 不保存真实密码。

第二步：

- SQLCipher；
- 主密码；
- KEK / DEK；
- 数据导出；
- 日志检查。

要求：

- 普通 SQLite 工具无法读取数据库；
- 正确密码可通过独立 CLI 导出；
- 错误密码无法打开；
- FTS 中不存在 Secret。

### Demo 4：本地关键字检索

实现：

- FTS5；
- 关键字查询；
- 实体别名；
- 时间过滤；
- 类型过滤；
- 凭证元数据命中。

要求：

- 精确查询不调用 AI；
- 查询过程完全离线；
- 密码结果默认遮罩；
- 搜索索引中没有凭证明文。

### Demo 5：AI 模糊查询

示例：

```text
用户：
找一下之前做界面原型时常用的那个网站账号。

本地候选：
[CREDENTIAL_FIGMA]
类型：设计工具
备注：用于界面原型

[CREDENTIAL_CANVA]
类型：海报工具
```

AI 只能返回允许的候选 ID：

```json
{
  "credentialRef": "CREDENTIAL_FIGMA",
  "confidence": 0.91
}
```

客户端本地再决定是否解锁凭证。

要求：

- AI 请求中没有真实 Secret；
- 模型返回未知 ID 时拒绝；
- 用户可以查看本次实际发送内容；
- API 失败不影响本地能力。

### Demo 6：最小 Pi Agent

只开放：

```text
search_protected_memories
get_protected_memory
search_credential_metadata
```

不开放：

```text
read_file
write_file
bash
execute_sql
get_original_memory
get_credential_plaintext
```

要求：

- 最多 3 轮工具调用；
- 未注册工具不能执行；
- 所有参数必须通过 Zod；
- 工具结果返回前二次脱敏；
- 工具调用写入安全审计日志；
- Agent 无法获取数据库密钥和凭证明文。

---

## 13. 首版 UI 范围

只需要一个主窗口。

### 顶部/左侧

- 最近记录或会话；
- 保存 / 查询模式；
- 当前本地状态。

### 主输入区

- 统一文本输入；
- 保存；
- 查询；
- AI 查询。

### 内联保护建议

展示：

- 检测内容；
- 类型；
- 原因；
- 风险；
- 建议策略；
- 用户可修改选项。

### 结果区

按内容显示：

- 保存成功卡片；
- 本地搜索结果；
- 凭证卡片；
- AI 模糊查询结果；
- AI 总结；
- 可本地还原的语义标记。

### 信任与调试面板

必须能查看：

```text
原始内容
AI 可用视图
本次实际发送给 AI 的内容
AI 原始返回
本地还原结果
工具调用记录
```

该面板在 Demo 阶段优先级很高。

---

## 14. 安全约束

### 必须做到

- Renderer 无 Node 权限；
- Agent 无数据库权限；
- Agent 无 Keychain 权限；
- Agent 无凭证明文接口；
- 所有工具白名单；
- 所有参数 Schema 校验；
- AI 请求前检查高风险模式；
- AI 返回标记必须校验；
- 数据库和 API 日志不得记录 Secret；
- 搜索索引不得包含 Secret；
- 原始数据不得进入异常上报；
- 禁止远程加载不受信任页面；
- 禁止任意导航和新窗口；
- API Key 不进入 Renderer。

### 高风险信息默认策略

以下内容默认不得发送给 AI：

- 密码；
- Token；
- 私钥；
- API Key；
- 恢复码；
- 数据库凭证；
- 银行卡安全信息。

---

## 15. 依赖方向

必须遵守：

```text
Renderer
    ↓
IPC Contracts
    ↓
Application Services
    ↓
Domain Interfaces
    ↓
Persistence / Vault
```

Agent：

```text
Agent Runtime
    ↓
Tool Gateway
    ↓
Protected Interfaces
```

禁止：

```text
Agent Runtime → Persistence
Agent Runtime → Credential Vault
Renderer → Persistence
Renderer → Key Manager
Renderer → API Key
```

---

## 16. 编码要求

- TypeScript 开启 strict；
- 不使用 `any`，除非有明确隔离和注释；
- 外部输入全部使用 Zod 校验；
- 所有敏感类型使用明确领域类型；
- 错误信息不得包含 Secret；
- 所有异步操作支持取消或超时；
- Repository 通过接口注入；
- 核心领域逻辑不得依赖 Electron；
- 所有规则识别器必须可单元测试；
- 所有 Agent 工具必须有安全测试；
- 所有数据库 migration 必须可重复执行；
- 重要安全假设必须写代码注释。

---

## 17. 第一阶段实施顺序

严格按以下顺序推进：

```text
1. 建立 monorepo 和领域类型
2. 实现 Privacy Engine
3. 实现原文 / 保护视图 / 凭证抽离
4. 实现普通 SQLite Repository
5. 实现 FTS5 本地查询
6. 实现统一输入和保护建议 UI
7. 实现 AI Gateway 单次调用
8. 实现 AI 模糊候选选择
9. 接入 Pi Agent
10. 拆分 Agent Worker
11. 接入 SQLCipher 和主密码
12. 实现独立导出 CLI
13. 增加安全测试
```

不要优先实现完整 Agent，不要优先做视觉细节，不要优先做跨平台安装器。

---

## 18. 第一阶段交付内容

完成后应提供：

1. 可运行的 Electron Demo；
2. 一套敏感检测测试集；
3. 一个本地 SQLite / SQLCipher 数据库；
4. 原文和 AI 视图对照；
5. 关键字离线查询；
6. AI 模糊查询；
7. Pi Agent 最小工具调用；
8. AI 请求检查器；
9. 安全审计日志；
10. 独立数据导出 CLI；
11. README；
12. 架构说明；
13. 已知风险和未完成项。

---

## 19. Go / No-Go 验收标准

只有同时满足以下条件，Demo 才算成功：

1. 明确 Token、私钥和密码高风险场景基本不漏报；
2. 真实 Secret 不进入保护视图、FTS 或 AI 请求；
3. 用户可以查看原文、AI 视图和实际发送内容；
4. 精确查询完全离线并快速返回；
5. 模糊查询可以从脱敏候选中找到正确记录；
6. Agent 无法访问原始数据库、密钥和凭证明文；
7. 未注册工具和非法参数会被拒绝；
8. 模型返回未知引用时不会执行本地还原；
9. 用户可通过独立 CLI 导出自己的数据；
10. API 不可用时，本地保存和查询仍可正常工作。

---

## 20. 最终架构原则

开发过程中始终遵守：

```text
APP 持有记忆，Agent 只是受限消费者。

原始记忆是事实来源，
保护视图是可重建派生数据，
凭证保险库保存真实 Secret。

加密保护磁盘数据，
权限架构防止运行时越权。

本地能完成的操作不调用 AI，
需要 AI 时只发送最小脱敏上下文。

用户永远可以看到：
本地找到了什么，
AI 实际看到了什么，
本地最终还原了什么。
```

---

## 21. Codex 当前任务

从建立项目骨架开始，不要一次实现所有功能。

第一步应完成：

1. 创建 TypeScript monorepo；
2. 创建 `domain`、`shared-contracts`、`privacy-engine` 包；
3. 定义核心领域类型；
4. 实现第一批 Recognizer；
5. 为 Privacy Engine 编写测试；
6. 创建最简 Electron 主窗口；
7. 在 UI 中输入文本并展示检测结果。

第一批 Recognizer 至少包括：

```text
KeywordRecognizer
EmailRecognizer
PrivateKeyRecognizer
GitHubTokenRecognizer
JwtRecognizer
HighEntropySecretRecognizer
KnownEntityRecognizer
```

完成第一步后，输出：

- 当前目录结构；
- 已实现内容；
- 测试结果；
- 下一步建议；
- 当前发现的风险和技术阻塞。

不要在没有明确需要时增加新的框架、数据库、服务端或复杂抽象。
