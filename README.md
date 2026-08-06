# BrainBuddy

BrainBuddy 是一个本地优先的个人记忆与隐私信息管理工具。本仓库当前处于电脑端技术验证 Demo 的第一阶段：识别用户输入中的敏感信息，并在 Electron 界面中给出保护建议。

## 开始使用

需要 Node.js 20 或更高版本。

```bash
npm install
npm test
npm run dev
```

其他命令：

```bash
npm run typecheck
npm run build
```

## 当前边界

- 所有识别均在本地完成，不调用外部 API。
- Renderer 启用沙箱和上下文隔离，通过窄 IPC 请求主进程分析文本。
- 当前不包含持久化、凭证保险库、AI Gateway 或 Agent。
- Demo 阶段请勿使用真实密码或 Token 测试。

## 工作区

- `apps/desktop`：Electron 主进程、preload 与 React 界面。
- `packages/domain`：核心领域类型。
- `packages/shared-contracts`：跨进程 Zod 协议。
- `packages/privacy-engine`：纯 TypeScript 敏感信息识别器与分析管线。
