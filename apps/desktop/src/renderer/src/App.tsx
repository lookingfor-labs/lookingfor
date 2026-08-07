import { useEffect, useRef, useState } from "react";
import type {
  DemoSaveReceipt,
  DetectedEntity,
  EntityType,
  PrivacyAnalysis,
  ProtectionPolicy,
  ProtectionPreview,
  RiskLevel
} from "@brainbuddy/domain";
import type { ProtectionRequest } from "@brainbuddy/shared-contracts";

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

const credentialTypes: ReadonlySet<EntityType> = new Set([
  "password", "api_key", "private_key", "github_token", "jwt", "high_entropy_secret"
]);

export function App(): JSX.Element {
  const [text, setText] = useState<string>(scenarios[0].text);
  const [analysis, setAnalysis] = useState<PrivacyAnalysis>();
  const [decisions, setDecisions] = useState<Record<string, ProtectionPolicy>>({});
  const [credentialIds, setCredentialIds] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<ProtectionPreview>();
  const [receipt, setReceipt] = useState<DemoSaveReceipt>();
  const [error, setError] = useState<string>();
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
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
      setReceipt(await saveDemoCandidate(toRequest(text, analysis, decisions, credentialIds)));
    } catch {
      setError("保存失败：保护检查未通过，内容没有写入会话。");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true">B</div>
        <div><p className="eyebrow">DEMO 2 · PROTECTION REVIEW</p><h1>BrainBuddy</h1></div>
        <div className="local-status"><span /> 本地保护已启用</div>
      </header>

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
          <div className="composer-footer"><span>{text.length} / 20,000</span><span className={isAnalyzing ? "pulse" : ""}>{isAnalyzing ? "正在重算三份视图" : "外发请求 0 次"}</span></div>
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
        <div className="results-heading"><div><p className="section-number">01 / 调整规则</p><h3>每项内容如何处理</h3></div><span>选择后实时更新下方三份视图</span></div>
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
          <PreviewCard index="C" title="AI 可见版本" hint="仅此版本允许外发" content={preview?.protectedContent} />
        </div>
      </section>

      <section className="save-zone panel">
        <div>
          <p className="section-number">03 / 信任检查</p>
          <div className="check-list">
            {preview?.safetyChecks.map((check) => <p key={check.id} className={check.passed ? "passed" : "failed"}><b>{check.passed ? "✓" : "!"}</b><span>{check.label}<small>{check.detail}</small></span></p>)}
            <p className="passed"><b>✓</b><span>本阶段外发请求为 0<small>当前流程没有接入任何 AI 服务</small></span></p>
          </div>
        </div>
        <div className="save-action">
          <button type="button" disabled={!preview?.readyToSave || isSaving || isAnalyzing || Boolean(receipt)} onClick={() => void saveCandidate()}>{receipt ? "本次版本已保存" : isSaving ? "正在保存…" : "保存到本次 Demo 会话"}</button>
          <small>仅内存保存 · 应用退出后清空</small>
        </div>
      </section>

      {receipt && <section className="receipt" role="status"><div><span>已保存</span><strong>{receipt.memoryId}</strong></div><p>保护副本：{receipt.protectedMemoryId}<br />凭据记录：{receipt.credentialIds.length ? receipt.credentialIds.join("、") : "无"}</p><small>这是可验收的会话回执，不代表磁盘持久化。</small></section>}
    </main>
  );
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
      {credentialTypes.has(entity.type) && <option value="move_to_vault">{policyLabels.move_to_vault}</option>}
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
    credentialIdFactory: () => crypto.randomUUID()
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
    credentialIdFactory: () => crypto.randomUUID()
  });
  return runtime.session.save(plan);
}

let runtimePromise: ReturnType<typeof createBrowserRuntime> | undefined;

function browserRuntime() {
  if (!import.meta.env.DEV) throw new Error("The preload privacy API is unavailable");
  runtimePromise ??= createBrowserRuntime();
  return runtimePromise;
}

async function createBrowserRuntime() {
  const [{ DemoMemorySession }, { buildProtectionPlan, PrivacyEngine, toProtectionPreview }] = await Promise.all([
    import("@brainbuddy/memory-engine"),
    import("@brainbuddy/privacy-engine")
  ]);
  const engine = new PrivacyEngine({ knownEntities: [{ id: "demo-person-zhang-wei", canonicalName: "张伟", entityType: "person", token: "[PERSON_A]", aliases: [], defaultPolicy: "keep_original" }] });
  return { engine, session: new DemoMemorySession(), buildProtectionPlan, toProtectionPreview };
}

function maskSensitiveText(entity: DetectedEntity): string {
  if (!credentialTypes.has(entity.type)) return entity.text;
  if (entity.text.length <= 6) return "••••••";
  return `${entity.text.slice(0, 3)}${"•".repeat(Math.min(12, entity.text.length - 5))}${entity.text.slice(-2)}`;
}
