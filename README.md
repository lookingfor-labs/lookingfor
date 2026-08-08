# BrainBuddy

BrainBuddy 是一个本地优先的个人记忆与隐私信息管理工具。当前 Demo 可以识别并保护敏感输入、加密保存 Source 与 Credential、离线查询记录，并通过 pi-ai 对接 DeepSeek 完成一次受控的流式 AI 查询。

## 开始使用

需要 Node.js 22.19 或更高版本。

```bash
npm install
npm test
npm run dev
```

启用 04「AI 查询」前，在仓库根目录创建 `.env`：

```dotenv
SECRET_DEEPSEEK_API_KEY=your-key
```

密钥只由 Electron 主进程或浏览器验收模式的 Vite 服务端中间件读取，不会注入 Renderer。不要使用 `VITE_` 前缀保存密钥。

其他命令：

```bash
npm run typecheck
npm run build
```

## 当前边界

- 敏感信息识别、Source 保存和离线查询在本地完成。
- 只有 04 页面在用户核对 pi-ai 输入原文并确认后调用 DeepSeek。
- Renderer 启用沙箱和上下文隔离，通过窄 IPC 请求主进程分析文本。
- DeepSeek 回复中的工具和文件动作只是可观察的意图，04 不执行任何动作。
- headless 浏览器模式用于开发验收，不应输入真实密码或 Token。

## 工作区

- `apps/desktop`：Electron 主进程、preload 与 React 界面。
- `packages/domain`：核心领域类型。
- `packages/shared-contracts`：跨进程 Zod 协议。
- `packages/privacy-engine`：纯 TypeScript 敏感信息识别器与分析管线。
- `packages/memory-engine`：加密 SQLite 与浏览器会话存储。
- `packages/ai-query`：pi-ai、DeepSeek 流、结构化回复与动作意图校验。
