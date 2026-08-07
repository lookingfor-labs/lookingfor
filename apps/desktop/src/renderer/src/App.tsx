import { useEffect, useRef, useState } from "react";
import type {
  DemoSaveReceipt,
  DemoMemorySummary,
  DemoSourceReveal,
  DetectedEntity,
  EntityType,
  PrivacyAnalysis,
  ProtectionPolicy,
  ProtectionPreview,
  RiskLevel
} from "@brainbuddy/domain";
import type { ProtectionRequest } from "@brainbuddy/shared-contracts";

type DemoPage = "protect" | "save" | "search" | "ai" | "agent";

const demoNavigation: readonly { id: DemoPage; number: string; label: string; status: "ready" | "next" | "planned" }[] = [
  { id: "protect", number: "01", label: "输入与保护", status: "ready" },
  { id: "save", number: "02", label: "保存与来源", status: "next" },
  { id: "search", number: "03", label: "本地查询", status: "next" },
  { id: "ai", number: "04", label: "AI 查询", status: "planned" },
  { id: "agent", number: "05", label: "Agent 实验室", status: "planned" }
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

export function App(): JSX.Element {
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
  const [memories, setMemories] = useState<readonly DemoMemorySummary[]>([]);
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
      await loadMemories("");
    } catch {
      setError("保存失败：保护检查未通过，内容没有写入会话。");
    } finally {
      setIsSaving(false);
    }
  }

  async function loadMemories(query: string): Promise<void> {
    setIsLoadingRecords(true);
    setError(undefined);
    try {
      setMemories(await searchDemoMemories(query));
    } catch {
      setError("读取本次会话记录失败，请重试。");
    } finally {
      setIsLoadingRecords(false);
    }
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
    if (page === "save" || page === "search") void loadMemories(page === "search" ? searchQuery : "");
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
            <em>{item.status === "ready" ? "可验收" : item.status === "next" ? "会话原型" : "界面预览"}</em>
          </button>)}
        </nav>
        <div className="sidebar-foot"><span><i /> 本地运行</span><span>AI 请求 0</span><small>当前数据仅保存在进程内存</small></div>
      </aside>

      <main className="shell">
      <header className="masthead">
        <div><p className="eyebrow">DEMO LAB · {demoNavigation.find((item) => item.id === activePage)?.number}</p><h1>{demoNavigation.find((item) => item.id === activePage)?.label}</h1></div>
        <div className="local-status"><span /> 本地保护已启用</div>
      </header>

      {activePage === "protect" && <>
      <section className="hero compact-hero">
        <div><p className="section-number">第一阶段 · 下一步</p><h2>看清三份内容，<br />再决定是否保存。</h2></div>
        <p className="hero-copy">这一步把检测建议变成可调整的保护方案。保存只进入本次 Demo 的进程内存，应用退出后清空，不会调用外部 AI。</p>
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
        <div className="results-heading"><div><p className="section-number">01 / 调整规则</p><h3>每项内容如何处理</h3></div><span>选择后实时更新本地记忆</span></div>
        <div className="entity-list">
          {analysis?.entities.map((entity) => (
            <EntityCard key={entityKey(entity)} entity={entity} policy={decisions[entityKey(entity)] ?? entity.suggestedPolicy} onChange={changePolicy} />
          ))}
          {analysis && analysis.entities.length === 0 && <div className="empty">没有检测到敏感信息。你仍可查看原始记忆与 AI 视图是否一致。</div>}
        </div>
      </section>

      <section className="review-section">
        <div className="results-heading"><div><p className="section-number">02 / 三份结果</p><h3>保存前并排核对</h3></div><span>凭据列永远只展示掩码</span></div>
        <div className="preview-grid">
          <PreviewCard index="A" title="本地记忆" hint="用于日后检索" content={preview?.memoryContent} />
          <article className="view-card vault-view">
            <header><span>B</span><div><strong>凭据草稿</strong><small>独立保存 · 不进记忆正文</small></div></header>
            <div className="view-content">
              {preview?.credentials.length ? preview.credentials.map((credential) => (
                <div className="credential-row" key={credential.ref}><code>{credential.maskedValue}</code><span>{typeLabels[credential.entityType]} · {credential.ref}</span></div>
              )) : <p className="muted">没有需要抽离的凭据</p>}
            </div>
          </article>
          <PreviewCard index="C" title="AI 实际可见" hint="与本地记忆完全一致" content={preview?.memoryContent} />
        </div>
      </section>

      <section className="save-zone panel">
        <div>
          <p className="section-number">03 / 信任检查</p>
          <div className="check-list">
            {preview?.safetyChecks.map((check) => <p key={check.id} className={check.passed ? "passed" : "failed"}><b>{check.passed ? "✓" : "!"}</b><span>{check.label}<small>{check.detail}</small></span></p>)}
            <p className="passed"><b>✓</b><span>AI 直接使用本地记忆<small>不再生成额外自动脱敏版本</small></span></p>
            <p className="passed"><b>✓</b><span>本阶段外发请求为 0<small>当前流程没有接入任何 AI 服务</small></span></p>
          </div>
        </div>
        <div className="save-action">
          <button type="button" disabled={!preview?.readyToSave || isSaving || isAnalyzing || Boolean(receipt)} onClick={() => void saveCandidate()}>{receipt ? "本次版本已保存" : isSaving ? "正在保存…" : "保存到本次 Demo 会话"}</button>
          <small>仅内存保存 · 应用退出后清空</small>
        </div>
      </section>

      {receipt && <section className="receipt" role="status"><div><span>已保存</span><strong>{receipt.memoryId}</strong></div><p>原始记录：{receipt.sourceId}<br />凭据记录：{receipt.credentialIds.length ? receipt.credentialIds.join("、") : "无"}</p><button type="button" onClick={() => navigate("save")}>查看保存与来源</button></section>}
      </>}

      {activePage === "save" && <SavePage memories={memories} receipt={receipt} isLoading={isLoadingRecords} revealedSource={revealedSource} onReveal={revealSource} onCloseReveal={() => setRevealedSource(undefined)} onGoProtect={() => navigate("protect")} />}
      {activePage === "search" && <SearchPage query={searchQuery} memories={memories} isLoading={isLoadingRecords} revealedSource={revealedSource} onQueryChange={setSearchQuery} onSearch={() => void loadMemories(searchQuery)} onReveal={revealSource} onCloseReveal={() => setRevealedSource(undefined)} />}
      {activePage === "ai" && <AiPreviewPage />}
      {activePage === "agent" && <AgentPreviewPage />}
      {activePage !== "protect" && error && <p className="error" role="alert">{error}</p>}
      </main>
    </div>
  );
}

function SavePage({ memories, receipt, isLoading, revealedSource, onReveal, onCloseReveal, onGoProtect }: {
  readonly memories: readonly DemoMemorySummary[];
  readonly receipt: DemoSaveReceipt | undefined;
  readonly isLoading: boolean;
  readonly revealedSource: DemoSourceReveal | undefined;
  readonly onReveal: (sourceId: string) => Promise<void>;
  readonly onCloseReveal: () => void;
  readonly onGoProtect: () => void;
}): JSX.Element {
  return <>
    <PageIntro number="02" kicker="SESSION STORAGE PROTOTYPE" title="保存与来源" copy="验证记忆、凭据与原始输入之间的引用关系。当前只保存在进程内存，还没有接入加密数据库。" />
    <div className="prototype-notice"><strong>会话原型</strong><span>现在验证数据模型与手动读取流程；应用退出后记录会清空。</span></div>
    {memories.length === 0 && !isLoading ? <EmptyPage title="还没有保存记录" copy="先到“输入与保护”完成一次保存，系统会生成 Memory ID 与 Source ID。" action="去输入与保护" onAction={onGoProtect} /> : <section className="record-stack">
      <div className="results-heading"><div><p className="section-number">本次会话</p><h3>已保存记录</h3></div><span>{isLoading ? "正在读取" : `${memories.length} 条`}</span></div>
      {memories.map((memory) => <MemoryRecord key={memory.memoryId} memory={memory} onReveal={onReveal} highlighted={receipt?.memoryId === memory.memoryId} />)}
    </section>}
    {revealedSource && <SourceReveal source={revealedSource} onClose={onCloseReveal} />}
  </>;
}

function SearchPage({ query, memories, isLoading, revealedSource, onQueryChange, onSearch, onReveal, onCloseReveal }: {
  readonly query: string;
  readonly memories: readonly DemoMemorySummary[];
  readonly isLoading: boolean;
  readonly revealedSource: DemoSourceReveal | undefined;
  readonly onQueryChange: (value: string) => void;
  readonly onSearch: () => void;
  readonly onReveal: (sourceId: string) => Promise<void>;
  readonly onCloseReveal: () => void;
}): JSX.Element {
  return <>
    <PageIntro number="03" kicker="LOCAL SEARCH · OFFLINE" title="本地查询" copy="只搜索本地记忆、Memory ID、Source ID 和凭据引用。原始输入不会进入查询结果，必须手动打开。" />
    <form className="search-box panel" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
      <input aria-label="本地查询关键词" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="输入 Figma、SOURCE_DEMO_001 或凭据 UUID" />
      <button type="submit">{isLoading ? "查询中…" : "离线查询"}</button>
      <small>未连接 AI · 原始记录不参与索引</small>
    </form>
    <section className="record-stack search-results">
      <div className="results-heading"><div><p className="section-number">查询结果</p><h3>{query ? `“${query}”` : "全部记忆"}</h3></div><span>{memories.length} 条</span></div>
      {memories.map((memory) => <MemoryRecord key={memory.memoryId} memory={memory} onReveal={onReveal} />)}
      {!isLoading && memories.length === 0 && <div className="empty">没有匹配的本地记忆。先保存一条记录，或换一个关键词。</div>}
    </section>
    {revealedSource && <SourceReveal source={revealedSource} onClose={onCloseReveal} />}
  </>;
}

function AiPreviewPage(): JSX.Element {
  return <>
    <PageIntro number="04" kicker="UI PREVIEW · NO INTERFACE" title="AI 查询" copy="这里将把本地查询得到的记忆候选交给 AI 做模糊判断。当前只有交互意图，没有连接模型或网络接口。" />
    <div className="future-grid">
      <section className="future-card"><span>01</span><h3>提出模糊问题</h3><textarea disabled value="找一下之前做界面原型时常用的那个网站账号。" readOnly /><button type="button" disabled>接口尚未接入</button></section>
      <section className="future-card"><span>02</span><h3>核对实际发送内容</h3><pre>{`候选：MEMORY_DEMO_001\n来源：[SOURCE:SOURCE_DEMO_001]\n凭据：[CREDENTIAL:<UUID>]`}</pre><p>发送前由用户确认，原始记录与凭证明文不会自动加入。</p></section>
      <section className="future-card"><span>03</span><h3>只接受已知引用</h3><pre>{`{\n  "memoryId": "MEMORY_DEMO_001",\n  "confidence": 0.91\n}`}</pre><p>未知 ID 会在本地拒绝，不会触发解密。</p></section>
    </div>
  </>;
}

function AgentPreviewPage(): JSX.Element {
  return <>
    <PageIntro number="05" kicker="UI PREVIEW · NO RUNTIME" title="Agent 实验室" copy="用于观察受控工具调用，而不是让 Agent 直接接触数据库、文件系统或解密密钥。" />
    <div className="agent-layout">
      <section className="panel tool-list"><p className="panel-heading"><span>允许的工具</span><em>0 / 3 次调用</em></p>{["search_memories", "get_memory", "search_credential_metadata"].map((tool) => <p key={tool}><b>允许</b><code>{tool}</code></p>)}</section>
      <section className="panel event-stream"><p className="panel-heading"><span>运行事件</span><em>等待接入</em></p><div className="empty">未来会在这里逐步展示 started、tool_call、text_delta 和 completed；所有载荷都必须是安全数据。</div></section>
    </div>
  </>;
}

function PageIntro({ number, kicker, title, copy }: { readonly number: string; readonly kicker: string; readonly title: string; readonly copy: string }): JSX.Element {
  return <section className="page-intro"><div><p className="section-number">{number} / {kicker}</p><h2>{title}</h2></div><p>{copy}</p></section>;
}

function MemoryRecord({ memory, onReveal, highlighted = false }: { readonly memory: DemoMemorySummary; readonly onReveal: (sourceId: string) => Promise<void>; readonly highlighted?: boolean }): JSX.Element {
  return <article className={`memory-record panel ${highlighted ? "highlighted" : ""}`}>
    <div className="record-meta"><strong>{memory.memoryId}</strong><span>{new Date(memory.savedAt).toLocaleString("zh-CN")}</span></div>
    <p>{memory.memoryContent}</p>
    <div className="record-links"><code>[SOURCE:{memory.sourceId}]</code><span>{memory.credentialIds.length} 个凭据引用</span><button type="button" onClick={() => void onReveal(memory.sourceId)}>手动查看原始记录</button></div>
  </article>;
}

function SourceReveal({ source, onClose }: { readonly source: DemoSourceReveal; readonly onClose: () => void }): JSX.Element {
  return <section className="source-reveal panel" role="region" aria-label="已解锁的原始记录"><div className="panel-heading"><span>手动读取 · {source.sourceId}</span><button type="button" onClick={onClose}>关闭并清除</button></div><p>{source.originalContent}</p><small>仅在本地界面临时展示；不会加入本地记忆或自动发送给 AI。</small></section>;
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
  return <article className="view-card"><header><span>{index}</span><div><strong>{title}</strong><small>{hint}</small></div></header><p className="view-content">{content || "—"}</p></article>;
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

async function analyzeInput(text: string): Promise<PrivacyAnalysis> {
  if (window.brainBuddy) return window.brainBuddy.analyzeInput({ text });
  return (await browserRuntime()).engine.analyze(text);
}

async function previewProtection(request: ProtectionRequest): Promise<ProtectionPreview> {
  if (window.brainBuddy) return window.brainBuddy.previewProtection(request);
  const runtime = await browserRuntime();
  const analysis = runtime.engine.analyze(request.text);
  return runtime.toProtectionPreview(runtime.buildProtectionPlan({
    text: request.text,
    entities: analysis.entities,
    decisions: request.decisions,
    credentialIdFactory: () => runtime.createCredentialId(crypto)
  }));
}

async function saveDemoCandidate(request: ProtectionRequest): Promise<DemoSaveReceipt> {
  if (window.brainBuddy) return window.brainBuddy.saveDemoCandidate(request);
  const runtime = await browserRuntime();
  const analysis = runtime.engine.analyze(request.text);
  const plan = runtime.buildProtectionPlan({
    text: request.text,
    entities: analysis.entities,
    decisions: request.decisions,
    credentialIdFactory: () => runtime.createCredentialId(crypto)
  });
  return runtime.session.save(plan, request.text);
}

async function searchDemoMemories(query: string): Promise<readonly DemoMemorySummary[]> {
  if (window.brainBuddy) return window.brainBuddy.searchDemoMemories({ query });
  return (await browserRuntime()).session.search(query);
}

async function revealDemoSource(sourceId: string): Promise<DemoSourceReveal> {
  if (window.brainBuddy) return window.brainBuddy.revealDemoSource({ sourceId });
  return (await browserRuntime()).session.revealSource(sourceId);
}

let runtimePromise: ReturnType<typeof createBrowserRuntime> | undefined;

function browserRuntime() {
  if (!import.meta.env.DEV) throw new Error("The preload privacy API is unavailable");
  runtimePromise ??= createBrowserRuntime();
  return runtimePromise;
}

async function createBrowserRuntime() {
  const [{ DemoMemorySession }, { buildProtectionPlan, createCredentialId, PrivacyEngine, toProtectionPreview }] = await Promise.all([
    import("@brainbuddy/memory-engine"),
    import("@brainbuddy/privacy-engine")
  ]);
  const engine = new PrivacyEngine({ knownEntities: [{ id: "demo-person-zhang-wei", canonicalName: "张伟", entityType: "person", token: "[PERSON_A]", aliases: [], defaultPolicy: "keep_original" }] });
  return { engine, session: new DemoMemorySession(), buildProtectionPlan, createCredentialId, toProtectionPreview };
}

function maskSensitiveText(entity: DetectedEntity): string {
  if (!secretTypes.has(entity.type)) return entity.text;
  if (entity.text.length <= 6) return "••••••";
  return `${entity.text.slice(0, 3)}${"•".repeat(Math.min(12, entity.text.length - 5))}${entity.text.slice(-2)}`;
}
