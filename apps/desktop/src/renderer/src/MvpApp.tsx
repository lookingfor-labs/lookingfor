import { useEffect, useMemo, useState } from "react";
import {
  ArrowClockwise,
  Brain,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  Database,
  Eye,
  FileMd,
  Flask,
  FloppyDisk,
  Folder,
  Gear,
  House,
  Key,
  LockKey,
  MagnifyingGlass,
  PaperPlaneRight,
  ShieldCheck,
  X
} from "@phosphor-icons/react";
import type {
  DemoCredentialSummary,
  DemoSaveReceipt,
  DemoSourceReveal,
  DemoSourceSummary,
  MemoryFile,
  PreparedMemoryWrite
} from "@brainbuddy/domain";
import type { AgentReference, AgentRuntimeEvent } from "@brainbuddy/agent-runtime";
import {
  cancelAgentRun,
  listMemoryFiles,
  prepareAgentRun,
  resolveAgentApproval,
  revealDemoSource,
  saveSuggestedProtectedText,
  searchDemoSources,
  streamAgentRun
} from "./App";

type MvpPage = "home" | "database" | "memories" | "settings";

const navigation = [
  { id: "home", label: "主页", icon: House },
  { id: "database", label: "本地数据库", icon: Database },
  { id: "memories", label: "浏览本地记忆", icon: Brain },
  { id: "settings", label: "设置", icon: Gear }
] as const;

const querySuggestions = ["最近保存的信息", "Figma", "设计账号", "AgentFlow", "GitHub"] as const;

export function MvpApp({ onOpenDemo }: { readonly onOpenDemo: () => void }): JSX.Element {
  const [page, setPage] = useState<MvpPage>("home");
  const [recordRefresh, setRecordRefresh] = useState(0);
  const [memoryRefresh, setMemoryRefresh] = useState(0);

  return <div className="mvp-app">
    <aside className="mvp-sidebar">
      <button className="mvp-brand" type="button" onClick={() => setPage("home")} aria-label="返回 BrainBuddy 主页">
        <span className="mvp-brand-mark">B</span><strong>BrainBuddy</strong>
      </button>
      <nav aria-label="产品导航">
        {navigation.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={page === id ? "active" : ""} onClick={() => setPage(id)}>
          <Icon size={20} weight={page === id ? "fill" : "regular"} aria-hidden="true" /><span>{label}</span>
        </button>)}
      </nav>
      <div className="mvp-sidebar-foot">
        <ShieldCheck size={20} weight="duotone" aria-hidden="true" />
        <div><strong>本地优先，隐私至上</strong><span>原始数据只保存在本机</span></div>
        <button type="button" onClick={onOpenDemo}><Flask size={16} aria-hidden="true" />打开验收 Demo</button>
      </div>
    </aside>
    <main className="mvp-main">
      {page === "home" && <HomePage onSaved={() => setRecordRefresh((value) => value + 1)} />}
      {page === "database" && <DatabasePage refreshToken={recordRefresh} />}
      {page === "memories" && <MemoriesPage refreshToken={memoryRefresh} onRefresh={() => setMemoryRefresh((value) => value + 1)} />}
      {page === "settings" && <SettingsPage />}
    </main>
  </div>;
}

function PageHeader({ title, copy }: { readonly title: string; readonly copy: string }): JSX.Element {
  return <header className="mvp-page-head"><h1>{title}</h1><p>{copy}</p></header>;
}

function HomePage({ onSaved }: { readonly onSaved: () => void }): JSX.Element {
  const [question, setQuestion] = useState("");
  const [runId, setRunId] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const [answer, setAnswer] = useState<string>();
  const [references, setReferences] = useState<readonly AgentReference[]>([]);
  const [approval, setApproval] = useState<PreparedMemoryWrite>();
  const [error, setError] = useState<string>();
  const [saveForm, setSaveForm] = useState({ keyword: "Figma", account: "lu@example.com", secret: "", note: "UI 原型设计主账号" });
  const [isSaving, setIsSaving] = useState(false);
  const [receipt, setReceipt] = useState<DemoSaveReceipt>();

  async function runAgent(): Promise<void> {
    if (!question.trim()) return;
    setIsRunning(true);
    setAnswer(undefined);
    setReferences([]);
    setApproval(undefined);
    setError(undefined);
    try {
      const draft = await prepareAgentRun(question, "require_approval");
      await streamAgentRun(draft.draftId, (event: AgentRuntimeEvent) => {
        setRunId(event.runId);
        if (event.type === "approval_required") setApproval(event.prepared);
        if (event.type === "approved" || event.type === "denied") setApproval(undefined);
        if (event.type === "agent_completed") {
          setAnswer(event.result.message);
          if (event.result.status === "completed") setReferences(event.result.references);
        }
        if (event.type === "agent_failed" || event.type === "agent_cancelled") setAnswer(event.result.message);
      });
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setIsRunning(false);
      setApproval(undefined);
    }
  }

  async function decide(decision: "approve" | "deny"): Promise<void> {
    if (!runId || !approval) return;
    try {
      const result = await resolveAgentApproval(runId, approval.approvalId, decision);
      if (result.status === "expired") setError("这次写入审批已经过期，请重新发起任务。");
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  async function saveRecord(): Promise<void> {
    if (!saveForm.keyword.trim() || !saveForm.secret.trim()) return;
    setIsSaving(true);
    setError(undefined);
    setReceipt(undefined);
    const text = `${saveForm.keyword} 登录信息，账号是 ${saveForm.account || "未填写"}，密码是 ${saveForm.secret}。备注：${saveForm.note || "无"}`;
    try {
      const nextReceipt = await saveSuggestedProtectedText(text);
      setReceipt(nextReceipt);
      setSaveForm((current) => ({ ...current, secret: "" }));
      onSaved();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setIsSaving(false);
    }
  }

  return <div className="mvp-page">
    <PageHeader title="BrainBuddy" copy="本地优先的隐私 AI 记忆管理，让重要信息只属于你。" />
    {error && <p className="mvp-alert error" role="alert">{error}</p>}
    <div className="mvp-stack">
      <section className="mvp-card mvp-section">
        <SectionTitle icon={<ChatCircleDots size={21} weight="duotone" />} title="和你的记忆对话" copy="查询、整理或更新本地 Memory，任何写入都会先征求你的同意。" />
        <div className="mvp-chat-box">
          <label htmlFor="mvp-question">给 BrainBuddy 的任务</label>
          <textarea id="mvp-question" value={question} disabled={isRunning} onChange={(event) => setQuestion(event.target.value)} placeholder="例如：帮我找到 Figma 账号，或记住我正在使用 AgentFlow。" />
          <div className="mvp-chat-actions">
            {isRunning && runId && <button className="mvp-secondary" type="button" onClick={() => void cancelAgentRun(runId)}>取消</button>}
            <button className="mvp-primary" type="button" disabled={!question.trim() || isRunning} onClick={() => void runAgent()}>{isRunning ? "处理中" : <><PaperPlaneRight size={17} weight="bold" />发送</>}</button>
          </div>
        </div>
        <div className="mvp-suggestions">
          <div className="mvp-mini-panel"><h3>试着问这些</h3><div className="mvp-chips">{querySuggestions.map((item) => <button key={item} type="button" onClick={() => setQuestion(item)}>{item}</button>)}</div></div>
          <div className="mvp-mini-panel mvp-answer" aria-live="polite"><h3>{answer ? "本轮结果" : "回答会显示在这里"}</h3><p>{answer || "BrainBuddy 会先检索本地 Memory 与受保护记录，只向模型发送必要的安全视图。"}</p>{references.length > 0 && <div className="mvp-reference-list">{references.map((reference) => <code key={`${reference.kind}:${reference.id}`}>{reference.kind}: {reference.id}</code>)}</div>}</div>
        </div>
        {approval && <div className="mvp-approval"><div><strong>允许写入 {approval.path}？</strong><span>{approval.reason}</span></div><pre>{approval.diff}</pre><div><button className="mvp-secondary" type="button" onClick={() => void decide("deny")}>拒绝</button><button className="mvp-primary" type="button" onClick={() => void decide("approve")}>批准写入</button></div></div>}
      </section>

      <section className="mvp-card mvp-section">
        <SectionTitle icon={<LockKey size={21} weight="duotone" />} title="直接保存隐私记录" copy="原文与凭据保存在本地数据库，AI 只会看到受保护的引用。" />
        <div className="mvp-form-grid">
          <label htmlFor="record-keyword">关键词</label><input id="record-keyword" value={saveForm.keyword} onChange={(event) => setSaveForm({ ...saveForm, keyword: event.target.value })} />
          <label htmlFor="record-account">账号</label><input id="record-account" value={saveForm.account} onChange={(event) => setSaveForm({ ...saveForm, account: event.target.value })} />
          <label htmlFor="record-secret">保密信息</label><input id="record-secret" type="password" value={saveForm.secret} onChange={(event) => setSaveForm({ ...saveForm, secret: event.target.value })} placeholder="输入密码、Token 或 API Key" />
          <label htmlFor="record-note">备注</label><input id="record-note" value={saveForm.note} onChange={(event) => setSaveForm({ ...saveForm, note: event.target.value })} />
        </div>
        <div className="mvp-save-row"><button className="mvp-primary" type="button" disabled={isSaving || !saveForm.keyword.trim() || !saveForm.secret.trim()} onClick={() => void saveRecord()}><FloppyDisk size={17} weight="bold" />{isSaving ? "正在保护并保存" : "保存到 BrainBuddy"}</button></div>
        {receipt && <div className="mvp-save-note" role="status"><CheckCircle size={22} weight="fill" /><div><strong>已安全保存</strong><span>Source {receipt.sourceId}，生成 {receipt.credentialIds.length} 个凭据引用。你可以在对话中让 Agent 将引用整理到 Memory。</span></div></div>}
      </section>
    </div>
  </div>;
}

function SectionTitle({ icon, title, copy }: { readonly icon: JSX.Element; readonly title: string; readonly copy: string }): JSX.Element {
  return <header className="mvp-section-title"><span>{icon}</span><div><h2>{title}</h2><p>{copy}</p></div></header>;
}

function DatabasePage({ refreshToken }: { readonly refreshToken: number }): JSX.Element {
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<readonly DemoSourceSummary[]>([]);
  const [credentials, setCredentials] = useState<readonly DemoCredentialSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [revealed, setRevealed] = useState<DemoSourceReveal>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function load(search = query): Promise<void> {
    setIsLoading(true);
    setError(undefined);
    setRevealed(undefined);
    try {
      const result = await searchDemoSources(search);
      setSources(result.sources);
      setCredentials(result.credentials);
      setSelectedId((current) => result.sources.some(({ sourceId }) => sourceId === current) ? current : result.sources[0]?.sourceId);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => { void load(""); }, [refreshToken]);
  const selected = sources.find(({ sourceId }) => sourceId === selectedId);
  const linkedCredentials = credentials.filter(({ sourceIds }) => selectedId && sourceIds.includes(selectedId));

  async function reveal(): Promise<void> {
    if (!selected) return;
    try { setRevealed(await revealDemoSource(selected.sourceId)); }
    catch (cause) { setError(messageFrom(cause)); }
  }

  return <div className="mvp-page">
    <PageHeader title="本地数据库" copy="搜索受保护的 Source 与 Credential，原文只在你主动查看时解锁。" />
    <div className="mvp-toolbar"><div className="mvp-search"><MagnifyingGlass size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} placeholder="搜索内容、Source ID 或凭据 ID" /></div><button className="mvp-secondary" type="button" disabled={isLoading} onClick={() => void load()}>{isLoading ? "查询中" : "查询"}</button><span className="mvp-security-state"><LockKey size={17} weight="fill" />原文默认锁定</span></div>
    {error && <p className="mvp-alert error" role="alert">{error}</p>}
    <section className="mvp-card mvp-database-card">
      <div className="mvp-banner"><ShieldCheck size={21} weight="duotone" /><div><strong>本地数据已保护</strong><span>{window.brainBuddy ? "Source 与凭据保存在本地 SQLite。" : "浏览器开发模式使用当前服务进程的会话内存。"}</span></div></div>
      {isLoading && !sources.length
        ? <LoadingState label="正在读取本地记录" />
        : sources.length
          ? <div className="mvp-table-wrap"><table><thead><tr><th>Source</th><th>类型</th><th>安全视图</th><th>凭据</th><th>保存时间</th></tr></thead><tbody>{sources.map((source) => <tr key={source.sourceId} tabIndex={0} aria-selected={source.sourceId === selectedId} className={source.sourceId === selectedId ? "selected" : ""} onClick={() => { setSelectedId(source.sourceId); setRevealed(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(source.sourceId); setRevealed(undefined); } }}><td><code>{source.sourceId}</code></td><td>{sourceKind(source.kind)}</td><td className="mvp-protected-cell">{source.protectedContent}</td><td>{source.credentialIds.length}</td><td>{formatTime(source.savedAt)}</td></tr>)}</tbody></table></div>
          : <EmptyState icon={<Database size={30} />} title="没有找到本地记录" copy="回到主页保存一条隐私记录，或调整搜索条件。" />}
      {selected && <div className="mvp-source-detail"><div><h2>{sourceKind(selected.kind)}记录</h2><dl><dt>Source ID</dt><dd><code>{selected.sourceId}</code></dd><dt>AI 安全视图</dt><dd>{selected.protectedContent}</dd><dt>关联凭据</dt><dd>{linkedCredentials.length ? linkedCredentials.map((credential) => <code key={credential.credentialId}>[CREDENTIAL:{credential.credentialId}]</code>) : "无"}</dd></dl></div><div className="mvp-secret-panel"><div><span>用户输入原文</span>{revealed && <button type="button" aria-label="关闭原文" onClick={() => setRevealed(undefined)}><X size={18} /></button>}</div>{revealed ? <pre>{revealed.originalContent}</pre> : <><LockKey size={28} weight="duotone" /><p>原文不会发送给 AI。点击后只在当前界面临时显示。</p><button className="mvp-secondary" type="button" onClick={() => void reveal()}><Eye size={17} />手动查看原文</button></>}</div></div>}
    </section>
  </div>;
}

function MemoriesPage({ refreshToken, onRefresh }: { readonly refreshToken: number; readonly onRefresh: () => void }): JSX.Element {
  const [memories, setMemories] = useState<readonly MemoryFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [query, setQuery] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function load(): Promise<void> {
    setIsLoading(true);
    setError(undefined);
    try {
      const next = await listMemoryFiles();
      setMemories(next);
      setSelectedPath((current) => next.some(({ path }) => path === current) ? current : next[0]?.path);
    } catch (cause) { setError(messageFrom(cause)); }
    finally { setIsLoading(false); }
  }

  useEffect(() => { void load(); }, [refreshToken]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return memories.filter(({ path, content }) => !normalized || `${path}\n${content}`.toLocaleLowerCase().includes(normalized));
  }, [memories, query]);
  const selected = filtered.find(({ path }) => path === selectedPath) ?? filtered[0];

  return <div className="mvp-page">
    <PageHeader title="浏览本地记忆" copy="查看 AI 可以读取和更新的 Markdown，凭据只以引用形式出现。" />
    {error && <p className="mvp-alert error" role="alert">{error}</p>}
    <section className="mvp-card mvp-memory-card">
      <div className="mvp-memory-toolbar"><div className="mvp-search"><MagnifyingGlass size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Memory 路径或内容" /></div><button className="mvp-secondary" type="button" disabled={isLoading} onClick={onRefresh}><ArrowClockwise size={17} />{isLoading ? "刷新中" : "刷新"}</button></div>
      <div className="mvp-memory-shell">
        <aside className="mvp-memory-tree"><div className="mvp-tree-root"><Folder size={18} weight="fill" />memories/<span>{filtered.length}</span></div>{filtered.map((memory) => <button key={memory.path} type="button" className={memory.path === selected?.path ? "active" : ""} onClick={() => setSelectedPath(memory.path)}><FileMd size={17} /><span>{memory.path.replace(/^memories\//u, "")}</span><CaretRight size={14} /></button>)}</aside>
        <article className="mvp-memory-editor">{isLoading && !memories.length ? <LoadingState label="正在读取 Memory" /> : selected ? <><header><div><strong>{selected.path}</strong><span>版本 {selected.version.slice(0, 12)}</span></div><time>{formatTime(selected.updatedAt)}</time></header><div className="mvp-info-strip"><ShieldCheck size={18} />这是 AI 可见的本地记忆，不应包含真实 Secret。</div><pre>{selected.content}</pre></> : <EmptyState icon={<FileMd size={30} />} title="还没有 Memory" copy="在主页对话中让 Agent 记住一条信息，批准写入后会显示在这里。" />}</article>
      </div>
    </section>
  </div>;
}

function SettingsPage(): JSX.Element {
  const persistent = Boolean(window.brainBuddy);
  return <div className="mvp-page">
    <PageHeader title="设置" copy="查看当前本地存储、模型连接和隐私边界。" />
    <div className="mvp-settings-grid">
      <section className="mvp-card mvp-setting-card"><div className="mvp-setting-icon"><Folder size={22} weight="duotone" /></div><div><h2>本地记忆目录</h2><p>受控 Markdown 根目录，Agent 不能访问此目录之外的文件。</p><dl><dt>运行模式</dt><dd>{persistent ? "Electron 持久化" : "desktop-dev 会话内存"}</dd><dt>Memory Root</dt><dd><code>{persistent ? "userData/memories" : "DemoMemorySession"}</code></dd></dl></div></section>
      <section className="mvp-card mvp-setting-card"><div className="mvp-setting-icon"><Key size={22} weight="duotone" /></div><div><h2>AI 连接</h2><p>密钥由本地环境提供，界面和 Agent 工具都不能读取明文。</p><dl><dt>Provider</dt><dd>DeepSeek</dd><dt>API Key</dt><dd><code>由 SECRET_DEEPSEEK_API_KEY 提供</code></dd><dt>能力</dt><dd className="mvp-capabilities"><span><CheckCircle weight="fill" />流式对话</span><span><CheckCircle weight="fill" />Tool Calling</span></dd></dl></div></section>
      <section className="mvp-card mvp-setting-card mvp-security-settings"><div className="mvp-setting-icon"><ShieldCheck size={22} weight="duotone" /></div><div><h2>隐私与安全</h2><p>这些规则由运行时强制执行，不依赖模型自行遵守。</p><div className="mvp-policy-row"><div><strong>Memory 写入需要批准</strong><span>主页对话默认使用 require_approval。</span></div><CheckCircle size={22} weight="fill" /></div><div className="mvp-policy-row"><div><strong>凭据明文不发送给 AI</strong><span>Agent 只接收 Credential ID 和掩码。</span></div><CheckCircle size={22} weight="fill" /></div><div className="mvp-policy-row"><div><strong>受控 Memory 根目录</strong><span>路径逃逸和符号链接会被拒绝。</span></div><CheckCircle size={22} weight="fill" /></div></div></section>
    </div>
  </div>;
}

function EmptyState({ icon, title, copy }: { readonly icon: JSX.Element; readonly title: string; readonly copy: string }): JSX.Element {
  return <div className="mvp-empty">{icon}<strong>{title}</strong><p>{copy}</p></div>;
}

function LoadingState({ label }: { readonly label: string }): JSX.Element {
  return <div className="mvp-loading" role="status" aria-label={label}><span /><span /><span /></div>;
}

function sourceKind(kind: DemoSourceSummary["kind"]): string {
  return ({ capture: "保存", local_search: "本地查询", conversation: "AI 对话" } as const)[kind];
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : "操作失败，请稍后重试。";
}
