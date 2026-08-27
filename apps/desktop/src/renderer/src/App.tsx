import { useEffect, useRef, useState } from "react";
import type {
  AiActionIntent,
  AiConversationDraft,
  AiConversationEvent,
  AiConversationResponse,
  DatabaseAccessStatus,
  DatabaseResetResult,
  DemoCredentialSummary,
  DemoOfflineSearchResult,
  DemoSaveReceipt,
  DemoSourceSummary,
  DemoSourceReveal,
  DetectedEntity,
  EntityType,
  MemoryFile,
  MemoryResetResult,
  MemoryRevertResult,
  MemoryWritePolicy,
  MemoryOperation,
  LocalStorageSettings,
  ModelConnectionTestResult,
  ModelConnectionStatus,
  PreparedMemoryWrite,
  PrivacyAnalysis,
  ProtectionPolicy,
  ProtectionPreview,
  RiskLevel
} from "@brainbuddy/domain";
import type { ProtectionRequest } from "@brainbuddy/shared-contracts";
import type {
  AgentRunDraft,
  AgentRunResult,
  AgentRuntimeEvent,
  ApprovalResolution
} from "@brainbuddy/agent-runtime";

type DemoPage = "protect" | "save" | "search" | "ai" | "agent";

const demoNavigation: readonly { id: DemoPage; number: string; label: string; status: "ready" | "next" | "planned" }[] = [
  { id: "protect", number: "01", label: "输入与保护", status: "ready" },
  { id: "save", number: "02", label: "保存与来源", status: "next" },
  { id: "search", number: "03", label: "本地查询", status: "next" },
  { id: "ai", number: "04", label: "AI 对话", status: "ready" },
  { id: "agent", number: "05", label: "Agent 实验室", status: "ready" }
];

const scenarios = [
  {
    label: "账号与密码",
    text: "今天张伟把 Figma 登录密码发给我，账号是 luyong@example.com，密码是 A9x!4mQ2#pL7。"
  },
  {
    label: "中转站 Key",
    text: "我的中转站的 key 是 sk-sdsdasdadasdasdasdaniinnz"
  },
  {
    label: "普通备忘",
    text: "张伟周五下午和设计团队复盘产品方案。"
  }
] as const;

const typeLabels: Readonly<Record<EntityType, string>> = {
  password: "密码",
  api_key: "API Key",
  email: "邮箱 / 账号",
  private_key: "私钥",
  github_token: "GitHub Token",
  jwt: "JWT",
  high_entropy_secret: "疑似密钥",
  person: "人物",
  company: "公司",
  project: "项目"
};

const policyLabels: Readonly<Record<ProtectionPolicy, string>> = {
  keep_original: "保留原文",
  move_to_vault: "抽离为凭据"
};

const riskLabels: Readonly<Record<RiskLevel, string>> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重"
};

const secretTypes: ReadonlySet<EntityType> = new Set([
  "password", "api_key", "private_key", "github_token", "jwt", "high_entropy_secret"
]);

export function App({ onOpenMvp }: { readonly onOpenMvp?: () => void } = {}): JSX.Element {
  const [activePage, setActivePage] = useState<DemoPage>("protect");
  const [text, setText] = useState<string>(scenarios[0].text);
  const [analysis, setAnalysis] = useState<PrivacyAnalysis>();
  const [decisions, setDecisions] = useState<Record<string, ProtectionPolicy>>({});
  const [credentialIds, setCredentialIds] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ProtectionPreview>();
  const [receipt, setReceipt] = useState<DemoSaveReceipt>();
  const [error, setError] = useState<string>();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [sources, setSources] = useState<readonly DemoSourceSummary[]>([]);
  const [credentials, setCredentials] = useState<readonly DemoCredentialSummary[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [revealedSource, setRevealedSource] = useState<DemoSourceReveal>();
  const [isLoadingRecords, setIsLoadingRecords] = useState(false);
  const requestSequence = useRef(0);

  useEffect(() => {
    const sequence = ++requestSequence.current;
    const timeout = window.setTimeout(() => {
      if (!text.trim()) {
        setAnalysis(undefined);
        setPreview(undefined);
        setDecisions({});
        setCredentialIds({});
        return;
      }
      void analyzeAndPreview(text, sequence);
    }, 240);
    return () => window.clearTimeout(timeout);
  }, [text]);

  async function analyzeAndPreview(value: string, sequence: number): Promise<void> {
    setIsAnalyzing(true);
    setError(undefined);
    setReceipt(undefined);
    try {
      const nextAnalysis = await analyzeInput(value);
      const nextDecisions = Object.fromEntries(
        nextAnalysis.entities.map((entity) => [entityKey(entity), entity.suggestedPolicy])
      );
      const nextPreview = await previewProtection(toRequest(value, nextAnalysis, nextDecisions, {}));
      if (requestSequence.current !== sequence) return;
      setAnalysis(nextAnalysis);
      setDecisions(nextDecisions);
      setCredentialIds(credentialIdsFrom(nextPreview));
      setPreview(nextPreview);
    } catch {
      if (requestSequence.current === sequence) setError("本地保护规划失败，请检查输入后重试。");
    } finally {
      if (requestSequence.current === sequence) setIsAnalyzing(false);
    }
  }

  async function changePolicy(entity: DetectedEntity, policy: ProtectionPolicy): Promise<void> {
    if (!analysis) return;
    const nextDecisions = { ...decisions, [entityKey(entity)]: policy };
    setDecisions(nextDecisions);
    setReceipt(undefined);
    setError(undefined);
    try {
      const nextPreview = await previewProtection(toRequest(text, analysis, nextDecisions, credentialIds));
      setPreview(nextPreview);
      setCredentialIds((current) => ({ ...current, ...credentialIdsFrom(nextPreview) }));
    } catch {
      setError("无法应用这项保护策略，请重新选择。");
    }
  }

  async function saveCandidate(): Promise<void> {
    if (!analysis || !preview?.readyToSave) return;
    setIsSaving(true);
    setError(undefined);
    try {
      const nextReceipt = await saveDemoCandidate(toRequest(text, analysis, decisions, credentialIds));
      setReceipt(nextReceipt);
      setPreview(nextReceipt.preview);
      await loadSources("");
    } catch {
      setError("保存失败：保护检查未通过，内容没有写入会话。");
    } finally {
      setIsSaving(false);
    }
  }

  async function loadSources(query: string): Promise<void> {
    setIsLoadingRecords(true);
    setError(undefined);
    try {
      const result = await searchDemoSources(query);
      setSources(result.sources);
      setCredentials(result.credentials);
    } catch {
      setError("读取本地记录失败，请重试。");
    } finally {
      setIsLoadingRecords(false);
    }
  }

  async function submitQuery(): Promise<void> {
    await loadSources(searchQuery);
  }

  async function revealSource(sourceId: string): Promise<void> {
    setError(undefined);
    try {
      setRevealedSource(await revealDemoSource(sourceId));
    } catch {
      setError("无法读取关联的原始记录。");
    }
  }

  function navigate(page: DemoPage): void {
    setActivePage(page);
    setRevealedSource(undefined);
    if (page === "save" || page === "search") void loadSources(page === "search" ? searchQuery : "");
  }

  return (
    <div className="app-frame">
      <aside className="demo-sidebar">
        <div className="sidebar-brand"><div className="brand-mark" aria-hidden="true">B</div><div><strong>BrainBuddy</strong><span>本地隐私实验室</span></div></div>
        <p className="sidebar-label">Demo 验收</p>
        <nav aria-label="Demo 验收页面">
          {demoNavigation.map((item) => <button key={item.id} type="button" className={activePage === item.id ? "active" : ""} onClick={() => navigate(item.id)}>
            <span className={`demo-state ${item.status}`} aria-hidden="true" />
            <small>{item.number}</small><strong>{item.label}</strong>
            <em>{item.status === "ready" ? "可验收" : item.status === "next" ? "本地数据库" : "界面预览"}</em>
          </button>)}
        </nav>
        <div className="sidebar-foot"><span><i /> 本地运行</span><span>{activePage === "ai" || activePage === "agent" ? "DeepSeek 已接入" : "AI 请求仅在 04 / 05 发起"}</span><small>Source 与凭据已保存到本地 SQLite</small>{onOpenMvp && <button type="button" onClick={onOpenMvp}>返回 MVP</button>}</div>
      </aside>

      <main className="shell">
      <header className="masthead">
        <div><p className="eyebrow">DEMO LAB · {demoNavigation.find((item) => item.id === activePage)?.number}</p><h1>{demoNavigation.find((item) => item.id === activePage)?.label}</h1></div>
        <div className="local-status"><span /> 本地保护已启用</div>
      </header>

      {activePage === "protect" && <>
      <section className="hero compact-hero">
        <div><p className="section-number">第一阶段 · 下一步</p><h2>看清三份内容，<br />再决定是否保存。</h2></div>
        <p className="hero-copy">这一步把检测建议变成可调整的保护方案。确认后加密保存到本地 SQLite，离线仍可查询。不会调用外部 AI。</p>
      </section>

      <nav className="scenario-bar" aria-label="验收场景">
        <span>快速验收</span>
        {scenarios.map((scenario) => (
          <button key={scenario.label} type="button" onClick={() => setText(scenario.text)}>{scenario.label}</button>
        ))}
      </nav>

      <section className="workspace">
        <div className="composer panel">
          <div className="panel-heading"><span>原始输入 · 只在本机</span><em>可编辑</em></div>
          <textarea aria-label="待检测内容" value={text} maxLength={20_000}
            onChange={(event) => setText(event.target.value)}
            placeholder="写下一段备忘，BrainBuddy 会在本地标出敏感信息……" />
          <div className="composer-footer"><span>{text.length} / 20,000</span><span className={isAnalyzing ? "pulse" : ""}>{isAnalyzing ? "正在重算保护方案" : "外发请求 0 次"}</span></div>
        </div>

        <aside className="summary panel">
          <p className="panel-heading"><span>保护状态</span></p>
          <strong>{analysis?.entities.length ?? 0}</strong><span>项已识别内容</span>
          <div className="risk-scale"><i className="safe" /><i className="watch" /><i className="danger" /></div>
          <p>{preview?.readyToSave ? "全部检查通过，可以保存到 Demo 会话。" : "等待本地保护检查通过。"}</p>
        </aside>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="results">
        <div className="results-heading"><div><p className="section-number">01 / 调整规则</p><h3>每项内容如何处理</h3></div><span>选择后实时更新 AI 可见输入</span></div>
        <div className="entity-list">
          {analysis?.entities.map((entity) => (
            <EntityCard key={entityKey(entity)} entity={entity} policy={decisions[entityKey(entity)] ?? entity.suggestedPolicy} onChange={changePolicy} />
          ))}
          {analysis && analysis.entities.length === 0 && <div className="empty">没有检测到敏感信息。你仍可核对原始输入与 AI 可见输入是否一致。</div>}
        </div>
      </section>

      <section className="review-section">
        <div className="results-heading"><div><p className="section-number">02 / 三份结果</p><h3>保存前并排核对</h3></div><span>凭据列永远只展示掩码</span></div>
        <div className="preview-grid">
          <PreviewCard index="A" title="受保护输入" hint="保存为 Source 的索引内容" content={preview?.protectedContent} />
          <article className="view-card vault-view">
            <header><span>B</span><div><strong>凭据草稿</strong><small>独立保存 · 不进记忆正文</small></div></header>
            <div className="view-content">
              {preview?.credentials.length ? preview.credentials.map((credential) => (
                <div className="credential-row" key={credential.ref}><code>{credential.maskedValue}</code><span>{typeLabels[credential.entityType]} · {credential.ref}</span></div>
              )) : <p className="muted">没有需要抽离的凭据</p>}
            </div>
          </article>
          <PreviewCard index="C" title="AI 实际可见" hint="与受保护输入完全一致" content={preview?.protectedContent} />
        </div>
      </section>

      <section className="save-zone panel">
        <div>
          <p className="section-number">03 / 信任检查</p>
          <div className="check-list">
            {preview?.safetyChecks.map((check) => <p key={check.id} className={check.passed ? "passed" : "failed"}><b>{check.passed ? "✓" : "!"}</b><span>{check.label}<small>{check.detail}</small></span></p>)}
            <p className="passed"><b>✓</b><span>AI 读取受保护输入<small>AI 总结另行写入独立 Memory 文件</small></span></p>
            <p className="passed"><b>✓</b><span>本阶段外发请求为 0<small>当前流程没有接入任何 AI 服务</small></span></p>
          </div>
        </div>
        <div className="save-action">
          <button type="button" disabled={!preview?.readyToSave || isSaving || isAnalyzing || Boolean(receipt)} onClick={() => void saveCandidate()}>{receipt ? "本次版本已保存" : isSaving ? "正在保存…" : "保存到本地数据库"}</button>
          <small>本地加密 SQLite · 离线可查询</small>
        </div>
      </section>

      {receipt && <section className="receipt" role="status"><div><span>已保存原始记录</span><strong>{receipt.sourceId}</strong></div><p>凭据记录：{receipt.credentialIds.length ? receipt.credentialIds.join("、") : "无"}</p><button type="button" onClick={() => navigate("save")}>查看保存与来源</button></section>}
      </>}

      {activePage === "save" && <SavePage sources={sources} receipt={receipt} isLoading={isLoadingRecords} revealedSource={revealedSource} onReveal={revealSource} onCloseReveal={() => setRevealedSource(undefined)} onGoProtect={() => navigate("protect")} />}
      {activePage === "search" && <SearchPage query={searchQuery} sources={sources} credentials={credentials} isLoading={isLoadingRecords} revealedSource={revealedSource} onQueryChange={setSearchQuery} onSearch={() => void submitQuery()} onReveal={revealSource} onCloseReveal={() => setRevealedSource(undefined)} />}
      {activePage === "ai" && <AiConversationPage />}
      {activePage === "agent" && <AgentPreviewPage />}
      {activePage !== "protect" && error && <p className="error" role="alert">{error}</p>}
      </main>
    </div>
  );
}

function SavePage({ sources, receipt, isLoading, revealedSource, onReveal, onCloseReveal, onGoProtect }: {
  readonly sources: readonly DemoSourceSummary[];
  readonly receipt: DemoSaveReceipt | undefined;
  readonly isLoading: boolean;
  readonly revealedSource: DemoSourceReveal | undefined;
  readonly onReveal: (sourceId: string) => Promise<void>;
  readonly onCloseReveal: () => void;
  readonly onGoProtect: () => void;
}): JSX.Element {
  return <>
    <PageIntro number="02" kicker="LOCAL DATABASE" title="保存与来源" copy="验证 Source、凭据与原始输入之间的引用关系。Memory 不在保存输入时自动生成，而由 AI 独立维护为本地文件。" />
    <div className="prototype-notice"><strong>SQLite 已启用</strong><span>原文和凭据明文加密落盘；索引只包含受保护内容、掩码与引用。</span></div>
    {sources.length === 0 && !isLoading ? <EmptyPage title="还没有保存记录" copy="先到“输入与保护”完成一次保存，系统会生成 Source ID 和关联的凭据引用。" action="去输入与保护" onAction={onGoProtect} /> : <section className="record-stack">
      <div className="results-heading"><div><p className="section-number">离线记录</p><h3>已保存 Source</h3></div><span>{isLoading ? "正在读取" : `${sources.length} 条`}</span></div>
      {sources.map((source) => <SourceRecord key={source.sourceId} source={source} onReveal={onReveal} highlighted={receipt?.sourceId === source.sourceId} />)}
    </section>}
    {revealedSource && <SourceReveal source={revealedSource} onClose={onCloseReveal} />}
  </>;
}

function SearchPage({ query, sources, credentials, isLoading, revealedSource, onQueryChange, onSearch, onReveal, onCloseReveal }: {
  readonly query: string;
  readonly sources: readonly DemoSourceSummary[];
  readonly credentials: readonly DemoCredentialSummary[];
  readonly isLoading: boolean;
  readonly revealedSource: DemoSourceReveal | undefined;
  readonly onQueryChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly onReveal: (sourceId: string) => Promise<void>;
  readonly onCloseReveal: () => void;
}): JSX.Element {
  return <>
    <PageIntro number="03" kicker="LOCAL SEARCH · OFFLINE" title="本地查询" copy="只读搜索本地 Source 与凭据元数据。查询词不会留档，也不会发送给 AI。" />
    <form className="search-box panel" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
      <input aria-label="本地查询关键词" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="输入 Figma、SOURCE_DEMO_001 或凭据 UUID" />
      <button type="submit">{isLoading ? "查询中…" : "离线查询"}</button>
      <small>未连接 AI · 查询词不保存 · 原始记录不参与索引</small>
    </form>
    <section className="record-stack search-results">
      <div className="results-heading"><div><p className="section-number">Source 结果</p><h3>{query ? `“${query}”` : "全部 Source"}</h3></div><span>{sources.length} 条</span></div>
      {sources.map((source) => <SourceRecord key={source.sourceId} source={source} onReveal={onReveal} />)}
      {!isLoading && sources.length === 0 && <div className="empty">没有匹配的 Source。先保存一条记录，或换一个关键词。</div>}
    </section>
    <section className="record-stack search-results">
      <div className="results-heading"><div><p className="section-number">Credential 结果</p><h3>凭据记录</h3></div><span>{credentials.length} 条</span></div>
      {credentials.map((credential) => <CredentialRecord key={credential.credentialId} credential={credential} />)}
      {!isLoading && credentials.length === 0 && <div className="empty">没有匹配的凭据记录。</div>}
    </section>
    {revealedSource && <SourceReveal source={revealedSource} onClose={onCloseReveal} />}
  </>;
}

type AiInspectorTab = "answer" | "memory" | "input" | "response" | "actions" | "audit";

function AiConversationPage(): JSX.Element {
  const [message, setMessage] = useState("记住我做界面原型时常用 Figma，并在已有记录足够时告诉我关联的凭据。");
  const [draft, setDraft] = useState<AiConversationDraft>();
  const [events, setEvents] = useState<readonly AiConversationEvent[]>([]);
  const [activeTab, setActiveTab] = useState<AiInspectorTab>("answer");
  const [isPreparing, setIsPreparing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [applyingMemory, setApplyingMemory] = useState<string>();
  const [appliedMemories, setAppliedMemories] = useState<Record<string, MemoryFile>>({});
  const [memoryErrors, setMemoryErrors] = useState<Record<string, string>>({});
  const abortRef = useRef<AbortController>();

  useEffect(() => () => abortRef.current?.abort(), []);

  const completed = [...events].reverse().find((event) => event.type === "completed");
  const failed = [...events].reverse().find((event) => event.type === "failed");
  const conversationResponse = completed?.type === "completed" ? completed.response : undefined;
  const streamedText = events.filter((event) => event.type === "text_delta").map((event) => event.type === "text_delta" ? event.delta : "").join("");
  const streamedThinking = events.filter((event) => event.type === "thinking_delta").map((event) => event.type === "thinking_delta" ? event.delta : "").join("");
  const providerPayload = [...events].reverse().find((event) => event.type === "provider_payload");
  const toolCalls = events.filter((event) => event.type === "tool_call");
  const terminal = Boolean(completed || failed);
  const memoryPaths = draft?.candidateIds.filter((id) => id.startsWith("memories/")) ?? [];

  async function prepare(): Promise<void> {
    if (!message.trim()) return;
    abortRef.current?.abort();
    setIsPreparing(true);
    setError(undefined);
    setDraft(undefined);
    setEvents([]);
    setAppliedMemories({});
    setMemoryErrors({});
    setActiveTab("input");
    try {
      setDraft(await prepareAiConversation(message));
    } catch (nextError) {
      setError(errorMessage(nextError));
    } finally {
      setIsPreparing(false);
    }
  }

  async function run(): Promise<void> {
    if (!draft || isRunning) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setEvents([]);
    setError(undefined);
    setIsRunning(true);
    setActiveTab("answer");
    try {
      await streamAiConversation(draft.draftId, (event) => setEvents((current) => [...current, event]), controller.signal);
    } catch (nextError) {
      if (!controller.signal.aborted) setError(errorMessage(nextError));
    } finally {
      abortRef.current = undefined;
      setIsRunning(false);
    }
  }

  function cancel(): void {
    abortRef.current?.abort();
  }

  async function applyOperation(operation: MemoryOperation): Promise<void> {
    const key = memoryOperationKey(operation);
    setApplyingMemory(key);
    setMemoryErrors((current) => ({ ...current, [key]: "" }));
    try {
      const memory = await applyMemoryOperation(operation);
      setAppliedMemories((current) => ({ ...current, [key]: memory }));
    } catch (nextError) {
      setMemoryErrors((current) => ({ ...current, [key]: errorMessage(nextError) }));
    } finally {
      setApplyingMemory(undefined);
    }
  }

  const tabs: readonly { id: AiInspectorTab; label: string }[] = [
    { id: "answer", label: "最终回复" },
    { id: "memory", label: `Memory 路径 ${memoryPaths.length}` },
    { id: "input", label: "Pi-AI 输入原文" },
    { id: "response", label: "模型回复原文" },
    { id: "actions", label: `操作提案${conversationResponse ? ` ${conversationResponse.memoryOperations.length + conversationResponse.otherIntents.length}` : ""}` },
    { id: "audit", label: "调用审计" }
  ];

  return <>
    <PageIntro number="04" kicker="DEEPSEEK · SINGLE STREAM" title="AI 对话" copy="用户可以提问、补充信息或请求更新记忆。DeepSeek 只提出 Memory 操作，用户确认后才会写入。" />

    <section className="ai-conversation-composer panel">
      <label htmlFor="ai-conversation-input">对话内容</label>
      <textarea id="ai-conversation-input" value={message} maxLength={2_000} disabled={isPreparing || isRunning}
        onChange={(event) => { setMessage(event.target.value); setDraft(undefined); setEvents([]); }} />
      <div className="ai-conversation-controls">
        <span>{draft ? `已创建对话 Source：${draft.conversationSourceId}` : "每次提交都会保留一条 conversation Source"}</span>
        <button type="button" className="secondary-action" disabled={!message.trim() || isPreparing || isRunning} onClick={() => void prepare()}>{isPreparing ? "正在准备" : "准备对话"}</button>
        {isRunning
          ? <button type="button" className="danger-action" onClick={cancel}>取消调用</button>
          : <button type="button" className="primary-action" disabled={!draft || terminal} onClick={() => void run()}>确认调用 DeepSeek</button>}
      </div>
    </section>

    {error && <p className="error" role="alert">{error}</p>}
    {draft && <section className="ai-call-summary" aria-label="AI 调用状态">
      <div><small>供应商</small><strong>DeepSeek</strong></div>
      <div><small>模型</small><strong>{draft.model}</strong></div>
      <div><small>Memory Path</small><strong>{memoryPaths.length}</strong></div>
      <div><small>状态</small><strong>{isRunning ? "流式接收中" : failed ? "调用失败" : completed ? "调用完成" : "等待确认"}</strong></div>
    </section>}

    <section className="ai-inspector panel">
      <nav className="ai-tabs" aria-label="AI 对话检查视图">
        {tabs.map((tab) => <button type="button" key={tab.id} className={activeTab === tab.id ? "active" : ""} onClick={() => setActiveTab(tab.id)}>{tab.label}</button>)}
      </nav>
      <div className="ai-inspector-body">
        {activeTab === "answer" && <AnswerView response={conversationResponse} streamedText={streamedText} isRunning={isRunning} validationError={completed?.type === "completed" ? completed.validationError : undefined} failed={failed?.type === "failed" ? failed.message : undefined} />}
        {activeTab === "memory" && <MemoryPathView memories={draft?.memories ?? []} />}
        {activeTab === "input" && <RawView title="传给 pi-ai models.stream() 的完整 Context" value={draft?.context} empty="点击“准备对话”生成并核对提示词原文。" />}
        {activeTab === "response" && <ResponseView completed={completed} streamedText={streamedText} streamedThinking={streamedThinking} toolCalls={toolCalls} />}
        {activeTab === "actions" && <ActionIntentView response={conversationResponse} memories={draft?.memories ?? []} hasResult={Boolean(completed)} applyingMemory={applyingMemory} appliedMemories={appliedMemories} errors={memoryErrors} onApply={applyOperation} />}
        {activeTab === "audit" && <AuditView events={events} providerPayload={providerPayload?.type === "provider_payload" ? providerPayload.payload : undefined} />}
      </div>
    </section>
  </>;
}

function AnswerView({ response, streamedText, isRunning, validationError, failed }: {
  readonly response: AiConversationResponse | undefined;
  readonly streamedText: string;
  readonly isRunning: boolean;
  readonly validationError: string | undefined;
  readonly failed: string | undefined;
}): JSX.Element {
  if (failed) return <div className="ai-empty-state"><strong>DeepSeek 调用未完成</strong><p>{failed}</p></div>;
  if (validationError) return <div className="ai-empty-state warning"><strong>保留了模型原文，但结构化结果未通过校验</strong><p>{validationError}</p></div>;
  if (!response && !streamedText) return <div className="ai-empty-state"><strong>{isRunning ? "正在等待第一个内容片段" : "还没有调用模型"}</strong><p>先准备对话并核对输入原文，然后确认调用 DeepSeek。</p></div>;
  return <div className="ai-answer"><p>{response?.message || streamedText}</p>{response && <div className="reference-list"><strong>模型引用</strong>{response.references.length ? response.references.map((reference) => <code key={`${reference.kind}:${reference.id}`}>{reference.kind}: {reference.id}</code>) : <span>没有引用本地候选</span>}</div>}</div>;
}

function MemoryPathView({ memories }: { readonly memories: readonly MemoryFile[] }): JSX.Element {
  if (!memories.length) return <div className="ai-empty-state"><strong>还没有 Memory 文件</strong><p>你可以在对话中要求 AI 记录信息。确认创建后，下一轮 Context 会提供新的 Memory Path 和内容。</p></div>;
  return <div className="memory-path-list"><p>以下受控路径、文件内容和版本已经放入本次 pi-ai Context。</p>{memories.map((memory) => <article key={memory.path} className="memory-file-card"><header><code>{memory.path}</code><small>版本 {memory.version.slice(0, 12)}</small></header><pre>{memory.content}</pre></article>)}</div>;
}

function ResponseView({ completed, streamedText, streamedThinking, toolCalls }: {
  readonly completed: AiConversationEvent | undefined;
  readonly streamedText: string;
  readonly streamedThinking: string;
  readonly toolCalls: readonly AiConversationEvent[];
}): JSX.Element {
  const rawMessage = completed?.type === "completed" ? completed.rawMessage : {
    role: "assistant",
    state: "streaming",
    text: streamedText,
    ...(streamedThinking ? { thinking: streamedThinking } : {}),
    toolCalls: toolCalls.map((event) => event.type === "tool_call" ? event.toolCall : undefined).filter(Boolean)
  };
  return <div className="raw-stack">
    {streamedThinking && <details><summary>供应商返回的 thinking 内容</summary><pre>{streamedThinking}</pre></details>}
    <RawView title="pi-ai 归一化 AssistantMessage" value={completed || streamedText || toolCalls.length ? rawMessage : undefined} empty="模型回复会在调用开始后显示。" />
  </div>;
}

function ActionIntentView({ response, memories, hasResult, applyingMemory, appliedMemories, errors, onApply }: {
  readonly response: AiConversationResponse | undefined;
  readonly memories: readonly MemoryFile[];
  readonly hasResult: boolean;
  readonly applyingMemory: string | undefined;
  readonly appliedMemories: Readonly<Record<string, MemoryFile>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly onApply: (operation: MemoryOperation) => Promise<void>;
}): JSX.Element {
  if (!hasResult) return <div className="ai-empty-state"><strong>还没有操作提案</strong><p>操作来自模型显式返回的结构化结果，不会推测隐藏思维。</p></div>;
  if (!response || (!response.memoryOperations.length && !response.otherIntents.length)) return <div className="ai-empty-state safe"><strong>模型没有提出后续操作</strong><p>本次对话只产生回复和引用。</p></div>;
  return <div className="action-intent-list">
    {response.memoryOperations.map((operation) => {
      const key = memoryOperationKey(operation);
      const applied = appliedMemories[key];
      const current = memories.find(({ path }) => path === operation.path);
      return <article key={key} className="memory-operation-card">
        <header><span>{operation.operation === "create" ? "创建 Memory" : "更新 Memory"}</span><strong>{applied ? "用户已确认" : "等待用户确认"}</strong></header>
        <code>{operation.path}</code>
        <div className="memory-operation-comparison">
          {operation.operation === "update" && <section><small>当前内容</small><pre>{current?.content ?? "当前版本未包含在本次 Context，不能安全更新。"}</pre></section>}
          <section><small>{operation.operation === "create" ? "待创建内容" : "提议的新内容"}</small><pre>{operation.content}</pre></section>
        </div>
        <small>{operation.reason}</small>
        {errors[key] && <p className="inline-operation-error">{errors[key]}</p>}
        {applied
          ? <p className="applied-memory">已写入，版本 {applied.version.slice(0, 12)}</p>
          : <button type="button" disabled={Boolean(applyingMemory)} onClick={() => void onApply(operation)}>{applyingMemory === key ? "正在写入" : `确认${operation.operation === "create" ? "创建" : "更新"}`}</button>}
      </article>;
    })}
    {response.otherIntents.map((action, index) => <article key={`${action.kind}:${index}`}>
      <header><span>{actionLabel(action.kind)}</span><strong>仅提议，未执行</strong></header>
      {action.kind === "tool_call" && <><code>{action.toolName}</code><pre>{formatJson(action.arguments)}</pre></>}
      {(action.kind === "file_read" || action.kind === "file_write") && <code>{action.path}</code>}
      {(action.kind === "memory_create" || action.kind === "memory_update") && <code>{action.target || "未指定 Memory 路径"}</code>}
      {"contentSummary" in action && <p>{action.contentSummary}</p>}
      <small>{action.reason}</small>
    </article>)}
  </div>;
}

function AuditView({ events, providerPayload }: { readonly events: readonly AiConversationEvent[]; readonly providerPayload: unknown }): JSX.Element {
  return <div className="audit-layout">
    <div className="audit-timeline"><strong>事件时间线</strong>{events.length ? events.map((event, index) => <p key={`${event.at}:${index}`}><time>{new Date(event.at).toLocaleTimeString("zh-CN")}</time><span>{eventLabel(event.type)}</span></p>) : <span>等待调用</span>}</div>
    <RawView title="onPayload 捕获的实际厂商请求体" value={providerPayload} empty="真正开始调用后才会生成厂商请求体。" />
  </div>;
}

function RawView({ title, value, empty }: { readonly title: string; readonly value: unknown; readonly empty: string }): JSX.Element {
  return <section className="raw-view"><header><strong>{title}</strong><small>{value === undefined ? "暂无数据" : "完整 JSON"}</small></header>{value === undefined ? <p>{empty}</p> : <pre>{formatJson(value)}</pre>}</section>;
}

function AgentPreviewPage(): JSX.Element {
  const [message, setMessage] = useState("找到我保存的 Figma 登录信息，并把可复用的账号和凭据引用更新到 memories/accounts.md。处理完成后告诉我引用了哪些记录。");
  const [writePolicy, setWritePolicy] = useState<MemoryWritePolicy>("require_approval");
  const [draft, setDraft] = useState<AgentRunDraft>();
  const [events, setEvents] = useState<readonly AgentRuntimeEvent[]>([]);
  const [runId, setRunId] = useState<string>();
  const [result, setResult] = useState<AgentRunResult>();
  const [approval, setApproval] = useState<PreparedMemoryWrite>();
  const [isPreparing, setIsPreparing] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [error, setError] = useState<string>();
  const [revertedRevisionId, setRevertedRevisionId] = useState<string>();
  const [showResetConfirmation, setShowResetConfirmation] = useState(false);
  const [isResettingMemory, setIsResettingMemory] = useState(false);
  const [resetResult, setResetResult] = useState<MemoryResetResult>();
  const toolCalls = events.filter((event) => event.type === "tool_call").length;
  const latestChange = [...events].reverse().find((event): event is Extract<AgentRuntimeEvent, { type: "memory_changed" }> => event.type === "memory_changed");

  async function prepare(): Promise<void> {
    setIsPreparing(true);
    setError(undefined);
    setDraft(undefined);
    setEvents([]);
    setResult(undefined);
    setApproval(undefined);
    setRunId(undefined);
    setRevertedRevisionId(undefined);
    try {
      setDraft(await prepareAgentRun(message, writePolicy));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsPreparing(false);
    }
  }

  async function start(): Promise<void> {
    if (!draft) return;
    setIsRunning(true);
    setError(undefined);
    try {
      await streamAgentRun(draft.draftId, (event) => {
        setEvents((current) => [...current, event]);
        setRunId(event.runId);
        if (event.type === "approval_required") setApproval(event.prepared);
        if (event.type === "approved" || event.type === "denied") setApproval(undefined);
        if (event.type === "agent_completed" || event.type === "agent_failed" || event.type === "agent_cancelled") {
          setResult(event.result);
        }
      });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsRunning(false);
      setApproval(undefined);
    }
  }

  async function decide(decision: "approve" | "deny"): Promise<void> {
    if (!runId || !approval) return;
    try {
      const resolution = await resolveAgentApproval(runId, approval.approvalId, decision);
      if (resolution.status === "expired") setError("这项审批已经过期，可能是 Run 已结束或被取消。");
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function cancel(): Promise<void> {
    if (!runId) return;
    await cancelAgentRun(runId);
  }

  async function undo(): Promise<void> {
    if (!latestChange) return;
    try {
      await revertMemoryRevision(latestChange.revisionId);
      setRevertedRevisionId(latestChange.revisionId);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function resetMemoryContext(): Promise<void> {
    setIsResettingMemory(true);
    setError(undefined);
    try {
      const nextResult = await requestMemoryContextReset();
      setResetResult(nextResult);
      setShowResetConfirmation(false);
      setDraft(undefined);
      setEvents([]);
      setRunId(undefined);
      setResult(undefined);
      setApproval(undefined);
      setRevertedRevisionId(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setIsResettingMemory(false);
    }
  }

  return <>
    <PageIntro number="05" kicker="CONTROLLED AGENT RUNTIME" title="Agent 实验室" copy="让 DeepSeek 在受控工具内搜索、读取和修改本地 Memory。它看不到 Source 原文、凭据明文、数据库连接或通用文件系统。" />
    <section className="panel agent-composer">
      <label htmlFor="agent-message">给 Agent 的任务</label>
      <textarea id="agent-message" value={message} disabled={isRunning} onChange={(event) => { setMessage(event.target.value); setDraft(undefined); }} maxLength={2_000} />
      <div className="agent-policy-row">
        <label>Memory 写入策略<select value={writePolicy} disabled={isRunning} onChange={(event) => { setWritePolicy(event.target.value as MemoryWritePolicy); setDraft(undefined); }}><option value="require_approval">写入前需要我批准</option><option value="auto_apply">Agent 可直接写入，可撤销</option></select></label>
        <div><small>Memory Root</small><code>memories/</code><span>仅限 Markdown，禁止目录逃逸与符号链接</span></div>
        {!draft ? <button className="secondary-action" type="button" disabled={!message.trim() || isPreparing || isRunning} onClick={() => void prepare()}>{isPreparing ? "正在保护并留档" : "准备 Run"}</button> : <button className="primary-action" type="button" disabled={isRunning} onClick={() => void start()}>开始 Agent</button>}
        {isRunning && <button className="danger-action" type="button" disabled={!runId} onClick={() => void cancel()}>取消 Run</button>}
      </div>
    </section>

    <section className={`panel memory-reset-panel${showResetConfirmation ? " confirming" : ""}`} aria-live="polite">
      <div>
        <small>测试上下文</small>
        <strong>{showResetConfirmation ? "确定重置全部 Memory？" : "重置 Memory 测试上下文"}</strong>
        <p>{showResetConfirmation
          ? "将清空 memories/ 中的全部 Markdown 和对应 Revision。Source、Credential 与 Agent Run 调试记录会保留。"
          : resetResult
            ? `上次已清空 ${resetResult.deletedMemoryCount} 个 Memory、${resetResult.deletedRevisionCount} 条 Revision。`
            : "用于重新开始多轮写入与查询验收，不影响本地 Source 和凭据。"}</p>
      </div>
      {showResetConfirmation
        ? <div className="memory-reset-actions"><button className="secondary-action" type="button" disabled={isResettingMemory} onClick={() => setShowResetConfirmation(false)}>保留当前上下文</button><button className="danger-action" type="button" disabled={isResettingMemory || isRunning} onClick={() => void resetMemoryContext()}>{isResettingMemory ? "正在重置" : "确认清空 Memory"}</button></div>
        : <button className="secondary-action" type="button" disabled={isRunning || isPreparing || isResettingMemory} onClick={() => { setResetResult(undefined); setShowResetConfirmation(true); }}>重置…</button>}
    </section>

    {error && <p className="error" role="alert">{error}</p>}
    {draft && <section className="agent-snapshot"><div><small>策略快照</small><strong>{draft.writePolicy === "auto_apply" ? "自动写入" : "写入需批准"}</strong></div><div><small>Conversation Source</small><code>{draft.conversationSourceId}</code></div><div><small>模型实际收到的用户消息</small><p>{draft.message}</p></div></section>}

    {approval && <section className="panel approval-panel" aria-live="polite"><header><div><small>同一个 Run 已暂停</small><h3>批准这次精确写入？</h3></div><code>{approval.path}</code></header><pre>{approval.diff}</pre><p>{approval.reason}</p><div><button className="secondary-action" type="button" onClick={() => void decide("deny")}>拒绝写入</button><button className="primary-action" type="button" onClick={() => void decide("approve")}>批准这个 Diff</button></div></section>}

    <div className="agent-layout">
      <section className="panel tool-list"><p className="panel-heading"><span>工具白名单</span><em>{toolCalls} 次调用</em></p>{["search_local_records", "search_memories", "read_memory", "write_memory", "brainbuddy_finish"].map((tool) => <p key={tool}><b>允许</b><code>{tool}</code></p>)}<div className="agent-budget"><span>最多 3 个工具批次</span><span>最多 8 次本地工具调用</span><span>最多 5 次模型请求</span></div></section>
      <section className="panel event-stream"><p className="panel-heading"><span>安全事件流</span><em>{isRunning ? approval ? "等待审批" : "运行中" : result ? result.status : "等待开始"}</em></p>{events.length ? <div className="agent-events">{events.map((event, index) => <details key={`${event.type}:${index}`} open={event.type === "tool_call" || event.type === "memory_changed" || event.type === "agent_completed"}><summary><span>{agentEventLabel(event.type)}</span><code>{event.type}</code></summary><pre>{formatJson(event)}</pre></details>)}</div> : <div className="empty">准备后再开始 Run。模型的文字增量、工具参数、工具结果、审批和完成状态会依次出现；事件不会包含解密原文。</div>}</section>
    </div>
    {result && <section className={`panel agent-result ${result.status}`}><p className="panel-heading"><span>Run 结果</span><em>{result.status}</em></p>{result.status === "completed" ? <><p>{result.message}</p><div className="reference-list"><strong>引用</strong>{result.references.map((reference) => <code key={`${reference.kind}:${reference.id}`}>{reference.kind}: {reference.id}</code>)}</div></> : <p>{result.message}</p>}<footer><span>{runId && <>Run <code>{runId}</code> · </>}模型请求 {result.budgets.modelRequestCount} · 工具批次 {result.budgets.toolBatchCount} · 工具调用 {result.budgets.toolCallCount}</span>{latestChange && <button type="button" className="secondary-action" disabled={revertedRevisionId === latestChange.revisionId} onClick={() => void undo()}>{revertedRevisionId === latestChange.revisionId ? "已撤销这次写入" : "撤销最近写入"}</button>}</footer></section>}
  </>;
}

function PageIntro({ number, kicker, title, copy }: { readonly number: string; readonly kicker: string; readonly title: string; readonly copy: string }): JSX.Element {
  return <section className="page-intro"><div><p className="section-number">{number} / {kicker}</p><h2>{title}</h2></div><p>{copy}</p></section>;
}

function SourceRecord({ source, onReveal, highlighted = false }: { readonly source: DemoSourceSummary; readonly onReveal: (sourceId: string) => Promise<void>; readonly highlighted?: boolean }): JSX.Element {
  return <article className={`memory-record panel ${highlighted ? "highlighted" : ""}`}>
    <div className="record-meta"><strong>{source.sourceId}</strong><span>{sourceKindLabel(source.kind)} · {new Date(source.savedAt).toLocaleString("zh-CN")}</span></div>
    <p>{source.protectedContent}</p>
    <div className="record-links"><code>[SOURCE:{source.sourceId}]</code><span>{source.credentialIds.length} 个凭据引用</span><button type="button" onClick={() => void onReveal(source.sourceId)}>手动查看原始记录</button></div>
  </article>;
}

function CredentialRecord({ credential }: { readonly credential: DemoCredentialSummary }): JSX.Element {
  return <article className="memory-record panel">
    <div className="record-meta"><strong>{credential.credentialId}</strong><span>{typeLabels[credential.entityType]}</span></div>
    <p>{credential.maskedValue}</p>
    <div className="record-links"><span>关联 Source</span>{credential.sourceIds.map((sourceId) => <code key={sourceId}>[SOURCE:{sourceId}]</code>)}</div>
  </article>;
}

function SourceReveal({ source, onClose }: { readonly source: DemoSourceReveal; readonly onClose: () => void }): JSX.Element {
  return <section className="source-reveal panel" role="region" aria-label="已解锁的原始记录"><div className="panel-heading"><span>手动读取 · {source.sourceId}</span><button type="button" onClick={onClose}>关闭并清除</button></div><p>{source.originalContent}</p><small>仅在本地界面临时展示；不会自动写入 Memory 或发送给 AI。</small></section>;
}

function EmptyPage({ title, copy, action, onAction }: { readonly title: string; readonly copy: string; readonly action: string; readonly onAction: () => void }): JSX.Element {
  return <section className="empty-page"><span>○</span><h3>{title}</h3><p>{copy}</p><button type="button" onClick={onAction}>{action}</button></section>;
}

function EntityCard({ entity, policy, onChange }: {
  readonly entity: DetectedEntity;
  readonly policy: ProtectionPolicy;
  readonly onChange: (entity: DetectedEntity, policy: ProtectionPolicy) => Promise<void>;
}): JSX.Element {
  return <article className="entity-card">
    <span className={`risk-badge ${entity.risk}`}>{riskLabels[entity.risk]}风险</span>
    <div className="entity-main"><code>{maskSensitiveText(entity)}</code><span>{typeLabels[entity.type]}</span></div>
    <div className="entity-reason"><small>识别原因</small><p>{entity.reason.join(" · ")}</p></div>
    <label className="entity-policy"><small>当前策略</small><select value={policy} onChange={(event) => void onChange(entity, event.target.value as ProtectionPolicy)}>
      <option value="keep_original">{policyLabels.keep_original}</option>
      <option value="move_to_vault">{policyLabels.move_to_vault}</option>
    </select></label>
  </article>;
}

function PreviewCard({ index, title, hint, content }: { readonly index: string; readonly title: string; readonly hint: string; readonly content: string | undefined }): JSX.Element {
  return <article className="view-card"><header><span>{index}</span><div><strong>{title}</strong><small>{hint}</small></div></header><p className="view-content">{content || "暂无"}</p></article>;
}

function entityKey(entity: Pick<DetectedEntity, "start" | "end">): string {
  return `${entity.start}:${entity.end}`;
}

function toRequest(
  text: string,
  analysis: PrivacyAnalysis,
  decisions: Record<string, ProtectionPolicy>,
  credentialIds: Record<string, string>
): ProtectionRequest {
  return { text, decisions: analysis.entities.map((entity) => {
    const credentialId = credentialIds[entityKey(entity)];
    return {
      start: entity.start,
      end: entity.end,
      policy: decisions[entityKey(entity)] ?? entity.suggestedPolicy,
      ...(credentialId ? { credentialId } : {})
    };
  }) };
}

function credentialIdsFrom(preview: ProtectionPreview): Record<string, string> {
  return Object.fromEntries(preview.credentials.map((credential) => [
    `${credential.start}:${credential.end}`,
    credential.credentialId
  ]));
}

export async function analyzeInput(text: string): Promise<PrivacyAnalysis> {
  if (window.brainBuddy) return window.brainBuddy.analyzeInput({ text });
  return postJson<PrivacyAnalysis>("/api/privacy/analyze", { text });
}

export async function previewProtection(request: ProtectionRequest): Promise<ProtectionPreview> {
  if (window.brainBuddy) return window.brainBuddy.previewProtection(request);
  return postJson<ProtectionPreview>("/api/privacy/preview", request);
}

async function saveDemoCandidate(request: ProtectionRequest): Promise<DemoSaveReceipt> {
  if (window.brainBuddy) return window.brainBuddy.saveDemoCandidate(request);
  return postJson<DemoSaveReceipt>("/api/database/save", request);
}

async function searchDemoSources(query: string): Promise<DemoOfflineSearchResult> {
  if (window.brainBuddy) return window.brainBuddy.searchDemoSources({ query });
  return postJson<DemoOfflineSearchResult>("/api/database/search", { query });
}

async function revealDemoSource(sourceId: string): Promise<DemoSourceReveal> {
  if (window.brainBuddy) return window.brainBuddy.revealDemoSource({ sourceId });
  return postJson<DemoSourceReveal>("/api/database/reveal", { sourceId });
}

async function prepareAiConversation(text: string): Promise<AiConversationDraft> {
  if (window.brainBuddy) return window.brainBuddy.prepareAiConversation({ text });
  return postJson<AiConversationDraft>("/api/ai-conversation/prepare", { text });
}

async function streamAiConversation(
  draftId: string,
  onEvent: (event: AiConversationEvent) => void,
  signal: AbortSignal
): Promise<void> {
  if (window.brainBuddy) {
    let runId: string | undefined;
    let settled = false;
    const queued: Array<{ readonly runId: string; readonly event: AiConversationEvent }> = [];
    return new Promise<void>((resolve, reject) => {
      const finish = (event: AiConversationEvent) => {
        onEvent(event);
        if (event.type === "completed" || event.type === "failed") {
          settled = true;
          unsubscribe();
          signal.removeEventListener("abort", abort);
          resolve();
        }
      };
      const handle = (payload: { readonly runId: string; readonly event: AiConversationEvent }) => {
        if (!runId) queued.push(payload);
        else if (payload.runId === runId) finish(payload.event);
      };
      const unsubscribe = window.brainBuddy!.onAiConversationEvent(handle);
      const abort = () => {
        if (runId) void window.brainBuddy!.cancelAiConversation({ runId });
      };
      signal.addEventListener("abort", abort, { once: true });
      void window.brainBuddy!.startAiConversation({ draftId }).then((started) => {
        runId = started.runId;
        queued.filter((payload) => payload.runId === runId).forEach((payload) => finish(payload.event));
        if (signal.aborted) abort();
      }).catch((error: unknown) => {
        if (!settled) {
          unsubscribe();
          signal.removeEventListener("abort", abort);
          reject(error);
        }
      });
    });
  }

  const response = await fetch("/api/ai-conversation/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draftId }),
    signal
  });
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error("浏览器没有返回可读取的流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const payload = JSON.parse(line) as { readonly event: AiConversationEvent };
      onEvent(payload.event);
    }
    if (done) break;
  }
  if (pending.trim()) onEvent((JSON.parse(pending) as { readonly event: AiConversationEvent }).event);
}

async function prepareAgentRun(text: string, writePolicy: MemoryWritePolicy, decisions?: ProtectionRequest["decisions"]): Promise<AgentRunDraft> {
  const request = { text, writePolicy, ...(decisions ? { decisions } : {}) };
  if (window.brainBuddy) return window.brainBuddy.prepareAgentRun(request);
  return postJson<AgentRunDraft>("/api/agent/prepare", request);
}

async function streamAgentRun(
  draftId: string,
  onEvent: (event: AgentRuntimeEvent) => void
): Promise<void> {
  if (window.brainBuddy) {
    let runId: string | undefined;
    const queued: AgentRuntimeEvent[] = [];
    return new Promise<void>((resolve, reject) => {
      const handle = (payload: { readonly runId: string; readonly event: AgentRuntimeEvent }) => {
        if (!runId) queued.push(payload.event);
        else if (payload.runId === runId) {
          onEvent(payload.event);
          if (isTerminalAgentEvent(payload.event)) {
            unsubscribe();
            resolve();
          }
        }
      };
      const unsubscribe = window.brainBuddy!.onAgentRunEvent(handle);
      void window.brainBuddy!.startAgentRun({ draftId }).then((started) => {
        runId = started.runId;
        queued.filter((event) => event.runId === runId).forEach((event) => onEvent(event));
        const terminal = queued.find((event) => event.runId === runId && isTerminalAgentEvent(event));
        if (terminal) {
          unsubscribe();
          resolve();
        }
      }).catch((cause: unknown) => {
        unsubscribe();
        reject(cause);
      });
    });
  }

  const response = await fetch("/api/agent/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ draftId })
  });
  if (!response.ok) throw new Error(await responseError(response));
  if (!response.body) throw new Error("浏览器没有返回可读取的 Agent 事件流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line.trim()) onEvent((JSON.parse(line) as { readonly event: AgentRuntimeEvent }).event);
    if (done) break;
  }
  if (pending.trim()) onEvent((JSON.parse(pending) as { readonly event: AgentRuntimeEvent }).event);
}

async function resolveAgentApproval(runId: string, approvalId: string, decision: "approve" | "deny"): Promise<ApprovalResolution> {
  if (window.brainBuddy) return window.brainBuddy.resolveAgentApproval({ runId, approvalId, decision });
  return postJson<ApprovalResolution>("/api/agent/approval", { runId, approvalId, decision });
}

async function cancelAgentRun(runId: string): Promise<void> {
  if (window.brainBuddy) return window.brainBuddy.cancelAgentRun({ runId });
  await postJson("/api/agent/cancel", { runId });
}

async function revertMemoryRevision(revisionId: string): Promise<MemoryRevertResult> {
  if (window.brainBuddy) return window.brainBuddy.revertMemoryRevision({ revisionId });
  return postJson<MemoryRevertResult>("/api/agent/revert", { revisionId });
}

async function requestMemoryContextReset(): Promise<MemoryResetResult> {
  if (window.brainBuddy) return window.brainBuddy.resetMemoryTestContext();
  return postJson<MemoryResetResult>("/api/agent/reset-memory", {});
}

export async function listMemoryFiles(): Promise<readonly MemoryFile[]> {
  if (window.brainBuddy) return window.brainBuddy.listMemoryFiles();
  return postJson<readonly MemoryFile[]>("/api/memory/list", {});
}

export async function saveSuggestedProtectedText(text: string): Promise<DemoSaveReceipt> {
  const analysis = await analyzeInput(text);
  return saveDemoCandidate({
    text,
    decisions: analysis.entities.map(({ start, end, suggestedPolicy: policy }) => ({ start, end, policy }))
  });
}

export async function getDatabaseAccessStatus(): Promise<DatabaseAccessStatus> {
  if (window.brainBuddy) return window.brainBuddy.getDatabaseAccessStatus();
  return postJson<DatabaseAccessStatus>("/api/database/access-status", {});
}

export async function getModelConnectionStatus(): Promise<ModelConnectionStatus> {
  if (window.brainBuddy) return window.brainBuddy.getModelConnectionStatus();
  return postJson<ModelConnectionStatus>("/api/model/connection-status", {});
}

export async function configureModelConnection(apiKey: string, baseUrl: string, modelId?: string): Promise<ModelConnectionStatus> {
  const request = { apiKey, baseUrl, ...(modelId ? { modelId } : {}) };
  if (window.brainBuddy) return window.brainBuddy.configureModelConnection(request);
  return postJson<ModelConnectionStatus>("/api/model/configure-connection", request);
}

export async function testModelConnection(apiKey: string | undefined, baseUrl: string, modelId: string): Promise<ModelConnectionTestResult> {
  const request = { ...(apiKey ? { apiKey } : {}), baseUrl, modelId };
  if (window.brainBuddy) return window.brainBuddy.testModelConnection(request);
  return postJson<ModelConnectionTestResult>("/api/model/test-connection", request);
}

export async function getLocalStorageSettings(): Promise<LocalStorageSettings> {
  if (window.brainBuddy) return window.brainBuddy.getLocalStorageSettings();
  return postJson<LocalStorageSettings>("/api/settings/local-storage", {});
}

export async function configureLocalStorageSettings(settings: LocalStorageSettings): Promise<LocalStorageSettings> {
  if (window.brainBuddy) return window.brainBuddy.configureLocalStorageSettings(settings);
  return postJson<LocalStorageSettings>("/api/settings/configure-local-storage", settings);
}

export async function configureDatabasePassword(currentPassword: string | undefined, newPassword: string): Promise<DatabaseAccessStatus> {
  if (window.brainBuddy) return window.brainBuddy.configureDatabasePassword({ currentPassword, newPassword });
  return postJson<DatabaseAccessStatus>("/api/database/configure-password", { currentPassword, newPassword });
}

export async function unlockDatabase(password: string): Promise<DatabaseAccessStatus> {
  if (window.brainBuddy) return window.brainBuddy.unlockDatabase({ password });
  return postJson<DatabaseAccessStatus>("/api/database/unlock", { password });
}

export async function lockDatabase(): Promise<DatabaseAccessStatus> {
  if (window.brainBuddy) return window.brainBuddy.lockDatabase();
  return postJson<DatabaseAccessStatus>("/api/database/lock", {});
}

export async function resetDatabase(): Promise<DatabaseResetResult> {
  if (window.brainBuddy) return window.brainBuddy.resetDatabase({ confirmation: "清除数据库" });
  return postJson<DatabaseResetResult>("/api/database/reset", { confirmation: "清除数据库" });
}

export {
  cancelAgentRun,
  prepareAgentRun,
  resolveAgentApproval,
  revealDemoSource,
  searchDemoSources,
  streamAgentRun
};

function isTerminalAgentEvent(event: AgentRuntimeEvent): boolean {
  return event.type === "agent_completed" || event.type === "agent_failed" || event.type === "agent_cancelled";
}

async function applyMemoryOperation(operation: MemoryOperation): Promise<MemoryFile> {
  if (window.brainBuddy) return window.brainBuddy.applyMemoryOperation({ operation });
  return postJson<MemoryFile>("/api/ai-conversation/apply-memory", { operation });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<string> {
  try {
    const value = await response.json() as { readonly error?: string };
    return value.error || `请求失败 (${response.status})`;
  } catch {
    return `请求失败 (${response.status})`;
  }
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "AI 对话失败，请检查 DeepSeek 配置。";
}

function memoryOperationKey(operation: MemoryOperation): string {
  return `${operation.operation}:${operation.path}`;
}

function sourceKindLabel(kind: DemoSourceSummary["kind"]): string {
  return ({ capture: "输入", local_search: "历史本地查询", conversation: "AI 对话" } as const)[kind];
}

function actionLabel(kind: AiActionIntent["kind"]): string {
  return ({
    tool_call: "工具调用",
    file_read: "读取文件",
    file_write: "写入文件",
    memory_create: "创建 Memory",
    memory_update: "更新 Memory"
  } as const)[kind];
}

function eventLabel(type: AiConversationEvent["type"]): string {
  return ({
    started: "开始调用 pi-ai",
    provider_payload: "生成厂商请求体",
    text_delta: "收到文本片段",
    thinking_delta: "收到 thinking 片段",
    tool_call: "收到工具调用",
    completed: "模型调用完成",
    failed: "模型调用失败"
  } as const)[type];
}

function agentEventLabel(type: AgentRuntimeEvent["type"]): string {
  return ({
    agent_started: "Run 已启动",
    turn_started: "模型请求开始",
    provider_payload: "DeepSeek 请求原文",
    model_message_delta: "模型原文片段",
    model_message: "模型回复原文",
    tool_call: "模型动作意图",
    tool_result: "受控工具结果",
    approval_required: "等待用户审批",
    approved: "用户已批准",
    denied: "用户已拒绝",
    auto_applied: "已自动写入",
    memory_changed: "Memory 已变更",
    turn_completed: "模型请求结束",
    agent_completed: "Run 已完成",
    agent_failed: "Run 失败",
    agent_cancelled: "Run 已取消"
  } as const)[type];
}

function maskSensitiveText(entity: DetectedEntity): string {
  if (!secretTypes.has(entity.type)) return entity.text;
  if (entity.text.length <= 6) return "••••••";
  return `${entity.text.slice(0, 3)}${"•".repeat(Math.min(12, entity.text.length - 5))}${entity.text.slice(-2)}`;
}
