import { useEffect, useMemo, useRef, useState } from "react";
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
  LockOpen,
  MagnifyingGlass,
  PaperPlaneRight,
  ShieldCheck,
  Trash,
  Warning,
  X
} from "@phosphor-icons/react";
import type {
  DetectedEntity,
  DemoCredentialSummary,
  DatabaseAccessStatus,
  DemoSaveReceipt,
  DemoSourceReveal,
  DemoSourceSummary,
  MemoryFile,
  LocalStorageSettings,
  MemoryWritePolicy,
  ModelConnectionStatus,
  PreparedMemoryWrite,
  PrivacyAnalysis,
  ProtectionPolicy,
  ProtectionPreview
} from "@brainbuddy/domain";
import type { AgentReference, AgentRuntimeEvent } from "@brainbuddy/agent-runtime";
import type { ProtectionRequest } from "@brainbuddy/shared-contracts";
import {
  analyzeInput,
  cancelAgentRun,
  configureLocalStorageSettings,
  configureModelConnection,
  configureDatabasePassword,
  getDatabaseAccessStatus,
  getLocalStorageSettings,
  getModelConnectionStatus,
  listMemoryFiles,
  lockDatabase,
  prepareAgentRun,
  previewProtection,
  resolveAgentApproval,
  revealDemoSource,
  resetDatabase,
  saveSuggestedProtectedText,
  searchDemoSources,
  streamAgentRun,
  testModelConnection,
  unlockDatabase
} from "./App";

type MvpPage = "home" | "database" | "memories" | "settings";
type DatabaseRecordTab = "saved" | "conversation";

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
  const [runtimeSettings, setRuntimeSettings] = useState<LocalStorageSettings>();

  useEffect(() => {
    void getLocalStorageSettings().then(setRuntimeSettings).catch(() => undefined);
  }, []);

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
      <div hidden={page !== "home"}><HomePage memoryWritePolicy={runtimeSettings?.memoryWritePolicy ?? "require_approval"} onSaved={() => setRecordRefresh((value) => value + 1)} /></div>
      <div hidden={page !== "database"}><DatabasePage refreshToken={recordRefresh} /></div>
      <div hidden={page !== "memories"}><MemoriesPage refreshToken={memoryRefresh} onRefresh={() => setMemoryRefresh((value) => value + 1)} /></div>
      <div hidden={page !== "settings"}><SettingsPage runtimeSettings={runtimeSettings} onRuntimeSettingsChange={setRuntimeSettings} /></div>
    </main>
  </div>;
}

function PageHeader({ title, copy }: { readonly title: string; readonly copy: string }): JSX.Element {
  return <header className="mvp-page-head"><h1>{title}</h1><p>{copy}</p></header>;
}

function HomePage({ memoryWritePolicy, onSaved }: { readonly memoryWritePolicy: MemoryWritePolicy; readonly onSaved: () => void }): JSX.Element {
  const [question, setQuestion] = useState("");
  const [questionAnalysis, setQuestionAnalysis] = useState<PrivacyAnalysis>();
  const [questionPreview, setQuestionPreview] = useState<ProtectionPreview>();
  const [questionDecisions, setQuestionDecisions] = useState<Record<string, ProtectionPolicy>>({});
  const [questionCredentialIds, setQuestionCredentialIds] = useState<Record<string, string>>({});
  const [isCheckingQuestion, setIsCheckingQuestion] = useState(false);
  const [questionProtectionError, setQuestionProtectionError] = useState<string>();
  const [runId, setRunId] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const [answer, setAnswer] = useState<string>();
  const [references, setReferences] = useState<readonly AgentReference[]>([]);
  const [approval, setApproval] = useState<PreparedMemoryWrite>();
  const [error, setError] = useState<string>();
  const [saveForm, setSaveForm] = useState({ keyword: "Figma", account: "lu@example.com", secret: "", note: "UI 原型设计主账号" });
  const [isSaving, setIsSaving] = useState(false);
  const [receipt, setReceipt] = useState<DemoSaveReceipt>();
  const questionSequence = useRef(0);

  useEffect(() => {
    const sequence = ++questionSequence.current;
    if (!question.trim()) {
      setQuestionAnalysis(undefined);
      setQuestionPreview(undefined);
      setQuestionDecisions({});
      setQuestionCredentialIds({});
      setQuestionProtectionError(undefined);
      setIsCheckingQuestion(false);
      return;
    }
    setIsCheckingQuestion(true);
    setQuestionProtectionError(undefined);
    const timeout = window.setTimeout(() => void analyzeQuestion(question, sequence), 240);
    return () => window.clearTimeout(timeout);
  }, [question]);

  async function analyzeQuestion(text: string, sequence: number): Promise<void> {
    try {
      const analysis = await analyzeInput(text);
      const decisions = Object.fromEntries(analysis.entities.map((entity) => [questionEntityKey(entity), entity.suggestedPolicy]));
      const preview = await previewProtection({
        text,
        decisions: buildQuestionProtectionDecisions(analysis, decisions, {})
      });
      if (questionSequence.current !== sequence) return;
      setQuestionAnalysis(analysis);
      setQuestionDecisions(decisions);
      setQuestionCredentialIds(questionCredentialIdsFrom(preview));
      setQuestionPreview(preview);
    } catch {
      if (questionSequence.current === sequence) {
        setQuestionAnalysis(undefined);
        setQuestionPreview(undefined);
        setQuestionProtectionError("本地保护检查失败，请修改输入后重试。");
      }
    } finally {
      if (questionSequence.current === sequence) setIsCheckingQuestion(false);
    }
  }

  function updateQuestion(text: string): void {
    ++questionSequence.current;
    setQuestion(text);
    setQuestionAnalysis(undefined);
    setQuestionPreview(undefined);
    setQuestionDecisions({});
    setQuestionCredentialIds({});
    setQuestionProtectionError(undefined);
    setIsCheckingQuestion(Boolean(text.trim()));
  }

  async function changeQuestionPolicy(entity: DetectedEntity, policy: ProtectionPolicy): Promise<void> {
    if (!questionAnalysis) return;
    const sequence = ++questionSequence.current;
    const text = question;
    const decisions = { ...questionDecisions, [questionEntityKey(entity)]: policy };
    setQuestionDecisions(decisions);
    setIsCheckingQuestion(true);
    setQuestionProtectionError(undefined);
    try {
      const preview = await previewProtection({
        text,
        decisions: buildQuestionProtectionDecisions(questionAnalysis, decisions, questionCredentialIds)
      });
      if (questionSequence.current !== sequence) return;
      setQuestionCredentialIds((current) => ({ ...current, ...questionCredentialIdsFrom(preview) }));
      setQuestionPreview(preview);
    } catch {
      if (questionSequence.current === sequence) setQuestionProtectionError("无法应用这项保护策略，请重新选择。");
    } finally {
      if (questionSequence.current === sequence) setIsCheckingQuestion(false);
    }
  }

  async function runAgent(): Promise<void> {
    if (!question.trim() || !questionAnalysis || !questionPreview?.readyToSave || isCheckingQuestion) return;
    setIsRunning(true);
    setAnswer(undefined);
    setReferences([]);
    setApproval(undefined);
    setError(undefined);
    try {
      const draft = await prepareAgentRun(
        question,
        memoryWritePolicy,
        buildQuestionProtectionDecisions(questionAnalysis, questionDecisions, questionCredentialIds)
      );
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
        <SectionTitle
          icon={<ChatCircleDots size={21} weight="duotone" />}
          title="和你的记忆对话"
          copy={memoryWritePolicy === "require_approval"
            ? "查询、整理或更新本地 Memory，写入前会征求你的同意。"
            : "查询、整理或更新本地 Memory，Agent 可自动写入并保留 Revision。"}
        />
        <div className="mvp-chat-box">
          <label htmlFor="mvp-question">给 BrainBuddy 的任务</label>
          <textarea id="mvp-question" value={question} disabled={isRunning} onChange={(event) => updateQuestion(event.target.value)} placeholder="例如：帮我找到 Figma 账号，或记住我正在使用 AgentFlow。" />
          <QuestionProtectionNotice analysis={questionAnalysis} preview={questionPreview} decisions={questionDecisions} isChecking={isCheckingQuestion} error={questionProtectionError} onPolicyChange={changeQuestionPolicy} />
          <div className="mvp-chat-actions">
            {isRunning && runId && <button className="mvp-secondary" type="button" onClick={() => void cancelAgentRun(runId)}>取消</button>}
            <button className="mvp-primary" type="button" disabled={!question.trim() || !questionPreview?.readyToSave || isCheckingQuestion || Boolean(questionProtectionError) || isRunning} onClick={() => void runAgent()}>{isRunning ? "处理中" : isCheckingQuestion ? "检查中" : <><PaperPlaneRight size={17} weight="bold" />发送</>}</button>
          </div>
        </div>
        <div className="mvp-suggestions">
          <div className="mvp-mini-panel"><h3>试着问这些</h3><div className="mvp-chips">{querySuggestions.map((item) => <button key={item} type="button" onClick={() => updateQuestion(item)}>{item}</button>)}</div></div>
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

function QuestionProtectionNotice({ analysis, preview, decisions, isChecking, error, onPolicyChange }: {
  readonly analysis: PrivacyAnalysis | undefined;
  readonly preview: ProtectionPreview | undefined;
  readonly decisions: Readonly<Record<string, ProtectionPolicy>>;
  readonly isChecking: boolean;
  readonly error: string | undefined;
  readonly onPolicyChange: (entity: DetectedEntity, policy: ProtectionPolicy) => Promise<void>;
}): JSX.Element | null {
  if (isChecking) return <div className="mvp-protection-state checking" role="status"><ShieldCheck size={17} weight="duotone" /><span>正在本地检查敏感信息</span></div>;
  if (error) return <div className="mvp-protection-state error" role="alert"><Warning size={17} weight="duotone" /><span>{error}</span></div>;
  if (!analysis || !preview) return null;
  if (!analysis.entities.length) return <div className="mvp-protection-state safe" role="status"><ShieldCheck size={17} weight="fill" /><span>本地检查完成，未发现需要保护的字段</span></div>;

  const keptCount = analysis.entities.filter((entity) => decisions[questionEntityKey(entity)] === "keep_original").length;
  return <section className="mvp-protection-notice" aria-label="本地保护提示">
    <header><Warning size={19} weight="duotone" /><div><strong>检测到 {analysis.entities.length} 个敏感字段</strong><span>{keptCount ? `${keptCount} 个字段会保留原文并发送给 AI。` : "默认抽离为凭据，原文不会发送给 AI。"}</span></div></header>
    <div className="mvp-protection-entities">{analysis.entities.map((entity) => {
      const key = questionEntityKey(entity);
      const selected = decisions[key] ?? entity.suggestedPolicy;
      return <div className="mvp-protection-entity" key={key}><div><span>{questionEntityTypeLabel(entity.type)} · {questionRiskLabel(entity.risk)}风险</span><code>{maskQuestionEntity(entity.text)}</code></div><div className="mvp-protection-policy" role="group" aria-label={`${questionEntityTypeLabel(entity.type)}保护策略`}><button type="button" aria-pressed={selected === "keep_original"} onClick={() => void onPolicyChange(entity, "keep_original")}>保留原文</button><button type="button" aria-pressed={selected === "move_to_vault"} onClick={() => void onPolicyChange(entity, "move_to_vault")}>抽离为凭据</button></div></div>;
    })}</div>
    <div className="mvp-protection-preview"><span>AI 可见版本</span><code>{preview.protectedContent}</code></div>
  </section>;
}

function SectionTitle({ icon, title, copy }: { readonly icon: JSX.Element; readonly title: string; readonly copy: string }): JSX.Element {
  return <header className="mvp-section-title"><span>{icon}</span><div><h2>{title}</h2><p>{copy}</p></div></header>;
}

function DatabasePage({ refreshToken }: { readonly refreshToken: number }): JSX.Element {
  const [activeTab, setActiveTab] = useState<DatabaseRecordTab>("saved");
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<readonly DemoSourceSummary[]>([]);
  const [credentials, setCredentials] = useState<readonly DemoCredentialSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string>();
  const [revealed, setRevealed] = useState<DemoSourceReveal>();
  const [access, setAccess] = useState<DatabaseAccessStatus>();
  const [unlockPassword, setUnlockPassword] = useState("");
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function load(search = query): Promise<void> {
    setIsLoading(true);
    setError(undefined);
    setRevealed(undefined);
    try {
      const result = await searchDemoSources(search);
      const nextVisibleSources = result.sources.filter(({ kind }) => databaseRecordTab(kind) === activeTab);
      setSources(result.sources);
      setCredentials(result.credentials);
      setSelectedId((current) => nextVisibleSources.some(({ sourceId }) => sourceId === current) ? current : nextVisibleSources[0]?.sourceId);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void load("");
    void getDatabaseAccessStatus().then(setAccess).catch((cause) => setError(messageFrom(cause)));
  }, [refreshToken]);
  const savedSources = sources.filter(({ kind }) => databaseRecordTab(kind) === "saved");
  const conversationSources = sources.filter(({ kind }) => databaseRecordTab(kind) === "conversation");
  const visibleSources = activeTab === "saved" ? savedSources : conversationSources;
  const selected = visibleSources.find(({ sourceId }) => sourceId === selectedId);
  const linkedCredentials = credentials.filter(({ sourceIds }) => selectedId && sourceIds.includes(selectedId));

  function selectTab(tab: DatabaseRecordTab): void {
    const nextSources = tab === "saved" ? savedSources : conversationSources;
    setActiveTab(tab);
    setSelectedId(nextSources[0]?.sourceId);
    setRevealed(undefined);
  }

  async function reveal(): Promise<void> {
    if (!selected) return;
    if (access && !access.unlocked) {
      setError("请先输入数据库密码解锁原文。");
      return;
    }
    try { setRevealed(await revealDemoSource(selected.sourceId)); }
    catch (cause) { setError(messageFrom(cause)); }
  }

  async function unlock(): Promise<void> {
    if (!unlockPassword) return;
    setIsUnlocking(true);
    setError(undefined);
    try {
      setAccess(await unlockDatabase(unlockPassword));
      setUnlockPassword("");
    } catch (cause) { setError(messageFrom(cause)); }
    finally { setIsUnlocking(false); }
  }

  async function lock(): Promise<void> {
    setRevealed(undefined);
    setAccess(await lockDatabase());
  }

  return <div className="mvp-page">
    <PageHeader title="本地数据库" copy="搜索受保护的 Source 与 Credential，原文只在你主动查看时解锁。" />
    <div className="mvp-toolbar"><div className="mvp-search"><MagnifyingGlass size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} placeholder="搜索内容、Source ID 或凭据 ID" /></div><button className="mvp-secondary" type="button" disabled={isLoading} onClick={() => void load()}>{isLoading ? "查询中" : "查询"}</button>{access?.passwordConfigured && access.unlocked ? <button className="mvp-security-state is-button" type="button" onClick={() => void lock()}><LockOpen size={17} weight="fill" />已解锁 · 点击锁定</button> : <span className="mvp-security-state"><LockKey size={17} weight="fill" />{access?.passwordConfigured ? "原文已锁定" : "未设置访问密码"}</span>}</div>
    {error && <p className="mvp-alert error" role="alert">{error}</p>}
    {access?.passwordConfigured && !access.unlocked && <form className="mvp-unlock-bar" onSubmit={(event) => { event.preventDefault(); void unlock(); }}><LockKey size={19} weight="duotone" /><div><strong>数据库已锁定</strong><span>输入设置页配置的密码后，才能临时查看原文或重置数据库。</span></div><label className="mvp-visually-hidden" htmlFor="database-unlock-password">数据库密码</label><input id="database-unlock-password" type="password" autoComplete="current-password" value={unlockPassword} onChange={(event) => setUnlockPassword(event.target.value)} placeholder="数据库密码" /><button className="mvp-primary" type="submit" disabled={!unlockPassword || isUnlocking}>{isUnlocking ? "解锁中" : "解锁"}</button></form>}
    <section className="mvp-card mvp-database-card">
      <nav className="mvp-database-tabs" aria-label="数据库记录分类">
        <button type="button" className={activeTab === "saved" ? "active" : ""} aria-pressed={activeTab === "saved"} onClick={() => selectTab("saved")}><FloppyDisk size={18} weight={activeTab === "saved" ? "fill" : "regular"} /><span><strong>信息保存</strong><small>主动保存的隐私信息</small></span><em>{savedSources.length}</em></button>
        <button type="button" className={activeTab === "conversation" ? "active" : ""} aria-pressed={activeTab === "conversation"} onClick={() => selectTab("conversation")}><ChatCircleDots size={18} weight={activeTab === "conversation" ? "fill" : "regular"} /><span><strong>AI 对话</strong><small>对话及查询产生的记录</small></span><em>{conversationSources.length}</em></button>
      </nav>
      <div className="mvp-banner"><ShieldCheck size={21} weight="duotone" /><div><strong>本地数据已保护</strong><span>{window.brainBuddy ? "Source 与凭据保存在 Electron userData 的本地 SQLite。" : "Source 与凭据保存在 desktop-dev 专用的本地 SQLite。"}</span></div></div>
      {isLoading && !sources.length
        ? <LoadingState label="正在读取本地记录" />
        : visibleSources.length
          ? <div className="mvp-table-wrap"><table><thead><tr><th>Source</th><th>类型</th><th>安全视图</th><th>凭据</th><th>保存时间</th></tr></thead><tbody>{visibleSources.map((source) => <tr key={source.sourceId} tabIndex={0} aria-selected={source.sourceId === selectedId} className={source.sourceId === selectedId ? "selected" : ""} onClick={() => { setSelectedId(source.sourceId); setRevealed(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedId(source.sourceId); setRevealed(undefined); } }}><td><code>{source.sourceId}</code></td><td>{sourceKind(source.kind)}</td><td className="mvp-protected-cell">{source.protectedContent}</td><td>{source.credentialIds.length}</td><td>{formatTime(source.savedAt)}</td></tr>)}</tbody></table></div>
          : <EmptyState icon={activeTab === "saved" ? <FloppyDisk size={30} /> : <ChatCircleDots size={30} />} title={query.trim() ? "当前分类没有匹配记录" : activeTab === "saved" ? "还没有保存的信息" : "还没有 AI 对话记录"} copy={query.trim() ? "可以调整搜索条件，或切换另一个分类查看。" : activeTab === "saved" ? "回到主页直接保存一条隐私信息，记录会显示在这里。" : "在主页与 BrainBuddy 对话后，本轮 Source 会显示在这里。"} />}
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

function SettingsPage({ runtimeSettings, onRuntimeSettingsChange }: {
  readonly runtimeSettings: LocalStorageSettings | undefined;
  readonly onRuntimeSettingsChange: (settings: LocalStorageSettings) => void;
}): JSX.Element {
  const [access, setAccess] = useState<DatabaseAccessStatus>();
  const [modelConnection, setModelConnection] = useState<ModelConnectionStatus>();
  const [modelForm, setModelForm] = useState({ apiKey: "", baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash" });
  const [storageForm, setStorageForm] = useState<LocalStorageSettings>({ memoryDirectory: "", databaseDirectory: "", memoryWritePolicy: "require_approval" });
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPhrase, setResetPhrase] = useState("");
  const [resetPassword, setResetPassword] = useState("");
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [isSavingModel, setIsSavingModel] = useState(false);
  const [isTestingModel, setIsTestingModel] = useState(false);
  const [isSavingStorage, setIsSavingStorage] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: "success" | "error"; readonly text: string }>();

  useEffect(() => {
    void getDatabaseAccessStatus().then(setAccess).catch((cause) => setMessage({ tone: "error", text: messageFrom(cause) }));
    void getModelConnectionStatus().then((status) => {
      setModelConnection(status);
      setModelForm((current) => ({ ...current, baseUrl: status.baseUrl, modelId: status.modelId }));
    }).catch((cause) => setMessage({ tone: "error", text: messageFrom(cause) }));
  }, []);

  useEffect(() => {
    if (runtimeSettings) setStorageForm(runtimeSettings);
  }, [runtimeSettings]);

  async function saveModelConnection(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSavingModel(true);
    setMessage(undefined);
    try {
      const status = await configureModelConnection(modelForm.apiKey, modelForm.baseUrl, modelForm.modelId);
      setModelConnection(status);
      setModelForm({ apiKey: "", baseUrl: status.baseUrl, modelId: status.modelId });
      setMessage({ tone: "success", text: modelConnection?.configured ? "AI 连接配置已更新。" : "AI 连接配置已保存。" });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
    finally { setIsSavingModel(false); }
  }

  async function checkModelConnection(): Promise<void> {
    setIsTestingModel(true);
    setMessage(undefined);
    try {
      const result = await testModelConnection(modelForm.apiKey.trim() || undefined, modelForm.baseUrl, modelForm.modelId);
      setMessage({
        tone: result.success ? "success" : "error",
        text: `${result.message}（${result.latencyMs} ms，最多 1 个输出 token）`
      });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
    finally { setIsTestingModel(false); }
  }

  async function saveStorageSettings(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setIsSavingStorage(true);
    setMessage(undefined);
    try {
      const settings = await configureLocalStorageSettings(storageForm);
      setStorageForm(settings);
      onRuntimeSettingsChange(settings);
      setMessage({ tone: "success", text: "本地存储路径已更新，数据库和 Memory 已切换到新目录。" });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
    finally { setIsSavingStorage(false); }
  }

  async function changeMemoryWritePolicy(memoryWritePolicy: MemoryWritePolicy): Promise<void> {
    if (!runtimeSettings) return;
    setMessage(undefined);
    try {
      const settings = await configureLocalStorageSettings({ ...runtimeSettings, memoryWritePolicy });
      setStorageForm(settings);
      onRuntimeSettingsChange(settings);
      setMessage({
        tone: "success",
        text: memoryWritePolicy === "require_approval" ? "Memory 写入将先请求批准。" : "Agent 可自动写入 Memory；每次修改仍会保存 Revision。"
      });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
  }

  async function savePassword(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setMessage(undefined);
    if (passwords.next !== passwords.confirm) {
      setMessage({ tone: "error", text: "两次输入的新密码不一致。" });
      return;
    }
    setIsSavingPassword(true);
    try {
      const status = await configureDatabasePassword(access?.passwordConfigured ? passwords.current : undefined, passwords.next);
      setAccess(status);
      setPasswords({ current: "", next: "", confirm: "" });
      setMessage({ tone: "success", text: access?.passwordConfigured ? "数据库访问密码已更新。" : "数据库访问密码已设置；当前会话保持解锁。" });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
    finally { setIsSavingPassword(false); }
  }

  async function lockNow(): Promise<void> {
    try {
      setAccess(await lockDatabase());
      setMessage({ tone: "success", text: "数据库原文访问已锁定。" });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
  }

  async function confirmReset(): Promise<void> {
    if (resetPhrase !== "清除数据库") return;
    setIsResetting(true);
    setMessage(undefined);
    try {
      let status = access;
      if (access?.passwordConfigured && !access.unlocked) status = await unlockDatabase(resetPassword);
      const result = await resetDatabase();
      setAccess(status);
      setResetOpen(false);
      setResetPhrase("");
      setResetPassword("");
      setMessage({ tone: "success", text: `数据库已重置：清除 ${result.deletedSourceCount} 条 Source 和 ${result.deletedCredentialCount} 条 Credential。Memory 与调试记录未受影响。` });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
    finally { setIsResetting(false); }
  }

  return <div className="mvp-page">
    <PageHeader title="设置" copy="管理本地存储访问、模型连接和隐私边界。" />
    {message && <p className={`mvp-alert ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
    <div className="mvp-settings-grid">
      <section className="mvp-card mvp-setting-card mvp-storage-settings"><div className="mvp-setting-icon"><Folder size={22} weight="duotone" /></div><div><h2>本地存储位置</h2><p>分别配置受控 Markdown 根目录和 SQLite 数据库目录；必须填写绝对路径。</p><form className="mvp-storage-form" onSubmit={(event) => void saveStorageSettings(event)}><label>本地记忆目录<input value={storageForm.memoryDirectory} required onChange={(event) => setStorageForm({ ...storageForm, memoryDirectory: event.target.value })} placeholder="例如 /Users/you/BrainBuddy/memories" /></label><label>数据库文件目录<input value={storageForm.databaseDirectory} required onChange={(event) => setStorageForm({ ...storageForm, databaseDirectory: event.target.value })} placeholder="例如 /Users/you/BrainBuddy/database" /></label><div className="mvp-form-actions"><button className="mvp-primary" type="submit" disabled={isSavingStorage || !storageForm.memoryDirectory.trim() || !storageForm.databaseDirectory.trim()}>{isSavingStorage ? "切换中" : "保存存储位置"}</button></div></form><p className="mvp-field-note">保存时会创建不存在的目录并立即切换；不会自动搬移旧目录中的数据。</p></div></section>
      <section className="mvp-card mvp-setting-card mvp-model-settings"><div className="mvp-setting-icon"><Key size={22} weight="duotone" /></div><div><div className="mvp-setting-heading"><div><h2>AI 连接</h2><p>连接信息由本地后端加密保存。API 地址可指向 DeepSeek 或兼容的中转服务。</p></div><span className={`mvp-status-pill ${modelConnection?.configured ? "unlocked" : "unset"}`}>{modelConnection?.configured ? "已配置" : "尚未配置"}</span></div><form className="mvp-model-form" onSubmit={(event) => void saveModelConnection(event)}><label className="mvp-model-url">API 地址<input type="url" value={modelForm.baseUrl} required maxLength={2000} onChange={(event) => setModelForm({ ...modelForm, baseUrl: event.target.value })} placeholder="https://api.deepseek.com" /></label><label>模型名称<input value={modelForm.modelId} required maxLength={100} onChange={(event) => setModelForm({ ...modelForm, modelId: event.target.value })} placeholder="deepseek-v4-flash" /></label><label className="mvp-model-key">API Key<input type="password" autoComplete="new-password" minLength={8} maxLength={512} required value={modelForm.apiKey} onChange={(event) => setModelForm({ ...modelForm, apiKey: event.target.value })} placeholder={modelConnection?.maskedApiKey ? `当前 ${modelConnection.maskedApiKey}，输入新 Key 可替换` : "输入 API Key"} /></label><div className="mvp-form-actions"><button className="mvp-secondary" type="button" disabled={isTestingModel || isSavingModel || !modelForm.baseUrl.trim() || !modelForm.modelId.trim() || (modelForm.apiKey.trim().length > 0 && modelForm.apiKey.trim().length < 8) || (!modelConnection?.configured && modelForm.apiKey.trim().length < 8)} onClick={() => void checkModelConnection()}><CheckCircle size={16} />{isTestingModel ? "测试中" : "测试连接"}</button><button className="mvp-primary" type="submit" disabled={isSavingModel || isTestingModel || modelForm.apiKey.trim().length < 8 || !modelForm.baseUrl.trim() || !modelForm.modelId.trim()}>{isSavingModel ? "保存中" : modelConnection?.configured ? "更新连接" : "保存连接"}</button></div></form><p className="mvp-field-note">测试连接会发送内容为“1”的请求并将输出限制为 1 token；Key 留空时使用已保存的连接。默认地址为 DeepSeek API，默认模型为 deepseek-v4-flash。</p></div></section>
      <section className="mvp-card mvp-setting-card mvp-password-settings"><div className="mvp-setting-icon"><LockKey size={22} weight="duotone" /></div><div><div className="mvp-setting-heading"><div><h2>数据库访问密码</h2><p>用于解锁原文查看和数据库重置；它不会替代独立的本机加密密钥。</p></div><span className={`mvp-status-pill ${access?.passwordConfigured ? (access.unlocked ? "unlocked" : "locked") : "unset"}`}>{access?.passwordConfigured ? (access.unlocked ? "已设置 · 已解锁" : "已设置 · 已锁定") : "尚未设置"}</span></div><form className="mvp-password-form" onSubmit={(event) => void savePassword(event)}>{access?.passwordConfigured && <label>当前密码<input type="password" autoComplete="current-password" required value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })} /></label>}<label>新密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })} placeholder="至少 8 个字符" /></label><label>确认新密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={passwords.confirm} onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })} /></label><div className="mvp-form-actions">{access?.passwordConfigured && access.unlocked && <button className="mvp-secondary" type="button" onClick={() => void lockNow()}><LockKey size={16} />立即锁定</button>}<button className="mvp-primary" type="submit" disabled={isSavingPassword || passwords.next.length < 8 || passwords.confirm.length < 8}>{isSavingPassword ? "保存中" : access?.passwordConfigured ? "更新密码" : "设置密码"}</button></div></form><p className="mvp-field-note">忘记此密码后无法从界面查看原文或清库。密码校验信息会持久化在当前运行模式的本地数据目录。</p></div></section>
      <section className="mvp-card mvp-setting-card mvp-security-settings"><div className="mvp-setting-icon"><ShieldCheck size={22} weight="duotone" /></div><div><h2>隐私与安全</h2><p>这些规则由运行时强制执行，不依赖模型自行遵守。</p><div className="mvp-policy-row mvp-policy-control"><div><strong>Memory 写入方式</strong><span>自动写入仍限制在 Memory 根目录，并为每次修改保存 Revision。</span></div><select aria-label="Memory 写入方式" value={runtimeSettings?.memoryWritePolicy ?? "require_approval"} disabled={!runtimeSettings} onChange={(event) => void changeMemoryWritePolicy(event.target.value as MemoryWritePolicy)}><option value="require_approval">每次需要批准</option><option value="auto_apply">允许 Agent 自动写入</option></select></div><div className="mvp-policy-row"><div><strong>凭据明文不发送给 AI</strong><span>Agent 只接收 Credential ID 和掩码。</span></div><CheckCircle size={22} weight="fill" /></div><div className="mvp-policy-row"><div><strong>受控 Memory 根目录</strong><span>路径逃逸和符号链接会被拒绝。</span></div><CheckCircle size={22} weight="fill" /></div></div></section>
      <section className="mvp-card mvp-setting-card mvp-danger-settings"><div className="mvp-setting-icon"><Warning size={22} weight="duotone" /></div><div><h2>危险操作</h2><p>重置只清除本地数据库中的 Source、Credential 及其关联；不会删除 Memory、Agent 调试记录、模型连接配置、数据库访问密码或设备加密密钥。</p>{!resetOpen ? <div className="mvp-danger-row"><div><strong>重置数据库</strong><span>此操作不可撤销，执行前会要求再次确认。</span></div><button className="mvp-danger-button" type="button" onClick={() => { setResetOpen(true); setMessage(undefined); }}><Trash size={16} />重置数据库</button></div> : <div className="mvp-reset-confirm" role="group" aria-labelledby="reset-database-title"><div><strong id="reset-database-title">确认永久清除数据库？</strong><span>请输入“清除数据库”完成二次确认。</span></div><label>确认文本<input value={resetPhrase} autoFocus onChange={(event) => setResetPhrase(event.target.value)} placeholder="清除数据库" /></label>{access?.passwordConfigured && !access.unlocked && <label>数据库密码<input type="password" autoComplete="current-password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder="先验证数据库密码" /></label>}<div className="mvp-form-actions"><button className="mvp-secondary" type="button" disabled={isResetting} onClick={() => { setResetOpen(false); setResetPhrase(""); setResetPassword(""); }}>取消</button><button className="mvp-danger-button" type="button" disabled={isResetting || resetPhrase !== "清除数据库" || Boolean(access?.passwordConfigured && !access.unlocked && !resetPassword)} onClick={() => void confirmReset()}>{isResetting ? "正在清除" : "确认清除数据库"}</button></div></div>}</div></section>
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

export function databaseRecordTab(kind: DemoSourceSummary["kind"]): DatabaseRecordTab {
  return kind === "capture" ? "saved" : "conversation";
}

export function buildQuestionProtectionDecisions(
  analysis: PrivacyAnalysis,
  decisions: Readonly<Record<string, ProtectionPolicy>>,
  credentialIds: Readonly<Record<string, string>>
): ProtectionRequest["decisions"] {
  return analysis.entities.map((entity) => {
    const credentialId = credentialIds[questionEntityKey(entity)];
    return {
      start: entity.start,
      end: entity.end,
      policy: decisions[questionEntityKey(entity)] ?? entity.suggestedPolicy,
      ...(credentialId ? { credentialId } : {})
    };
  });
}

function questionEntityKey(entity: DetectedEntity): string {
  return `${entity.start}:${entity.end}`;
}

function questionCredentialIdsFrom(preview: ProtectionPreview): Record<string, string> {
  return Object.fromEntries(preview.credentials.map((credential) => [
    `${credential.start}:${credential.end}`,
    credential.credentialId
  ]));
}

function questionEntityTypeLabel(type: DetectedEntity["type"]): string {
  return ({
    password: "密码",
    api_key: "API Key",
    email: "邮箱或账号",
    private_key: "私钥",
    github_token: "GitHub Token",
    jwt: "JWT",
    high_entropy_secret: "疑似密钥",
    person: "人物",
    company: "公司",
    project: "项目"
  } as const)[type];
}

function questionRiskLabel(risk: DetectedEntity["risk"]): string {
  return ({ low: "低", medium: "中", high: "高", critical: "严重" } as const)[risk];
}

function maskQuestionEntity(value: string): string {
  if (value.length <= 4) return "•".repeat(value.length);
  return `${value.slice(0, 2)}${"•".repeat(Math.min(8, value.length - 4))}${value.slice(-2)}`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function messageFrom(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (message.includes("DATABASE_PASSWORD_INVALID")) return "数据库密码不正确。";
  if (message.includes("DATABASE_PASSWORD_WEAK")) return "数据库密码需要 8-128 个字符。";
  if (message.includes("DATABASE_LOCKED")) return "请先解锁本地数据库。";
  if (message.includes("DATABASE_RESET_BLOCKED")) return "数据库正在被 AI Run 使用，请先等待完成或取消 Run。";
  if (message.includes("MODEL_NOT_CONFIGURED")) return "请先在设置页配置 DeepSeek API Key。";
  if (message.includes("MODEL_API_KEY_INVALID")) return "DeepSeek API Key 需要 8-512 个字符。";
  if (message.includes("MODEL_BASE_URL_INVALID")) return "AI API 地址必须是有效的 HTTP 或 HTTPS 地址。";
  if (message.includes("MODEL_ID_INVALID")) return "模型名称不能为空，且不能超过 100 个字符。";
  if (message.includes("MODEL_CONFIG_INVALID")) return "本地模型连接配置无法解密，请重新配置。";
  if (message.includes("MODEL_CONFIG_BLOCKED")) return "模型配置正在被 AI Run 使用，请先等待完成或取消 Run。";
  if (message.includes("LOCAL_STORAGE_PATH_NOT_ABSOLUTE")) return "Memory 和数据库目录必须填写绝对路径。";
  if (message.includes("LOCAL_STORAGE_CONFIG_INVALID")) return "本地存储配置文件无效，请检查后重试。";
  if (message.includes("LOCAL_STORAGE_CONFIG_BLOCKED")) return "本地存储正在被 AI Run 使用，请先等待完成或取消 Run。";
  return message || "操作失败，请稍后重试。";
}
