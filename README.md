# BrainBuddy

BrainBuddy 是一个本地优先的个人记忆与隐私信息管理工具。当前 MVP 可以保护并保存敏感输入、查询 Source 与 Credential、浏览本地 Memory，并通过受控 Agent 与本地记忆对话。

## 开始使用

需要 Node.js 22.19 或更高版本。

```bash
npm install
npm test
npm run dev
```

启用 MVP 对话或 Demo 04/05 前，在仓库根目录创建 `.env`：

```dotenv
SECRET_DEEPSEEK_API_KEY=your-key
```

密钥只由 Electron 主进程或浏览器验收模式的 Vite 服务端中间件读取，不会注入 Renderer。不要使用 `VITE_` 前缀保存密钥。

其他命令：

```bash
npm run typecheck
npm run build
```

开发服务器默认打开 MVP：

```text
http://localhost:15174/
```

原五阶段验收界面保留在：

```text
http://localhost:15174/demo
```

## 当前边界

- 敏感信息识别、Source 保存和离线查询在本地完成。
- MVP 主页和 Demo 04/05 会在用户主动发起后调用 DeepSeek。
- MVP 主页默认要求用户批准 Agent 的每次 Memory 写入。
- AI 只能通过受控工具搜索记录、读取 Memory 和精确修改 `memories/` 下的 Markdown。
- Renderer 启用沙箱和上下文隔离，通过窄 IPC 请求主进程分析文本。
- DeepSeek 回复中的工具和文件动作只是可观察的意图，04 不执行任何动作。
- headless 浏览器模式用于开发验收，不应输入真实密码或 Token。

## 工作区

- `apps/desktop`：Electron 主进程、preload 与 React 界面。
- `packages/domain`：核心领域类型。
- `packages/shared-contracts`：跨进程 Zod 协议。
- `packages/privacy-engine`：纯 TypeScript 敏感信息识别器与分析管线。
- `packages/memory-engine`：加密 SQLite 与浏览器会话存储。
- `packages/ai-conversation`：pi-ai、DeepSeek 流、结构化回复与 Memory 操作提案校验。
- `packages/agent-runtime`：受控 Agent 循环、工具预算、审批、引用校验与调试记录。
