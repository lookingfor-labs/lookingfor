import { useEffect, useState } from "react";
import type { DetectedEntity, PrivacyAnalysis, ProtectionPolicy, RiskLevel } from "@brainbuddy/domain";

const sample = "今天张伟把 Figma 登录密码发给我，账号是 luyong@example.com，密码是 A9x!4mQ2#pL7。";

const typeLabels: Readonly<Record<DetectedEntity["type"], string>> = {
  password: "密码",
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
  replace_with_token: "替换标记",
  original_only: "仅保留在原始记忆",
  move_to_vault: "存入凭证保险库"
};

const riskLabels: Readonly<Record<RiskLevel, string>> = {
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重"
};

export function App(): JSX.Element {
  const [text, setText] = useState(sample);
  const [analysis, setAnalysis] = useState<PrivacyAnalysis>();
  const [error, setError] = useState<string>();
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      if (text.trim()) void analyze(text);
      else setAnalysis(undefined);
    }, 240);
    return () => window.clearTimeout(timeout);
  }, [text]);

  async function analyze(value: string): Promise<void> {
    setIsAnalyzing(true);
    setError(undefined);
    try {
      setAnalysis(await window.brainBuddy.analyzeInput({ text: value }));
    } catch {
      setError("本地分析失败，请缩短输入后重试。");
    } finally {
      setIsAnalyzing(false);
    }
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div className="brand-mark" aria-hidden="true">B</div>
        <div>
          <p className="eyebrow">PRIVACY LAB · LOCAL ONLY</p>
          <h1>BrainBuddy</h1>
        </div>
        <div className="local-status"><span /> 本地保护已启用</div>
      </header>

      <section className="hero">
        <div>
          <p className="section-number">01 / 输入检测</p>
          <h2>先看见风险，<br />再决定如何保存。</h2>
        </div>
        <p className="hero-copy">内容只在当前设备分析。此阶段不会保存输入，也不会向任何 AI 服务发送数据。</p>
      </section>

      <section className="workspace">
        <div className="composer panel">
          <div className="panel-heading">
            <span>输入内容</span>
            <button type="button" onClick={() => setText(sample)}>载入示例</button>
          </div>
          <textarea
            aria-label="待检测内容"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="写下一段备忘，BrainBuddy 会在本地标出敏感信息……"
          />
          <div className="composer-footer">
            <span>{text.length} / 20,000</span>
            <span className={isAnalyzing ? "pulse" : ""}>{isAnalyzing ? "正在本地分析" : "未连接外部服务"}</span>
          </div>
        </div>

        <aside className="summary panel">
          <p className="panel-heading"><span>检测概览</span></p>
          <strong>{analysis?.entities.length ?? 0}</strong>
          <span>项保护建议</span>
          <div className="risk-scale">
            <i className="safe" /><i className="watch" /><i className="danger" />
          </div>
          <p>{analysis?.entities.some((entity) => entity.risk === "critical") ? "发现严重风险，默认禁止发送给 AI。" : "未发现必须拦截的高风险内容。"}</p>
        </aside>
      </section>

      {error && <p className="error" role="alert">{error}</p>}

      <section className="results">
        <div className="results-heading">
          <div><p className="section-number">02 / 保护建议</p><h3>检测明细</h3></div>
          <span>{analysis?.entities.length ? "按风险优先处理" : "等待输入"}</span>
        </div>

        <div className="entity-list">
          {analysis?.entities.map((entity) => <EntityCard key={`${entity.start}-${entity.end}`} entity={entity} />)}
          {analysis && analysis.entities.length === 0 && <div className="empty">没有检测到敏感信息。规则只提供建议，保存前仍需由你确认。</div>}
        </div>
      </section>

      {analysis && (
        <section className="preview panel">
          <div className="panel-heading"><span>AI 可见版本预览</span><em>尚未发送</em></div>
          <p>{analysis.protectedPreview || "—"}</p>
        </section>
      )}
    </main>
  );
}

function EntityCard({ entity }: { readonly entity: DetectedEntity }): JSX.Element {
  return (
    <article className="entity-card">
      <span className={`risk-badge ${entity.risk}`}>{riskLabels[entity.risk]}风险</span>
      <div className="entity-main">
        <code>{maskSensitiveText(entity)}</code>
        <span>{typeLabels[entity.type]}</span>
      </div>
      <div className="entity-reason"><small>识别原因</small><p>{entity.reason.join(" · ")}</p></div>
      <div className="entity-policy"><small>建议策略</small><p>{policyLabels[entity.suggestedPolicy]}</p></div>
    </article>
  );
}

function maskSensitiveText(entity: DetectedEntity): string {
  if (!["password", "private_key", "github_token", "jwt", "high_entropy_secret"].includes(entity.type)) {
    return entity.text;
  }
  if (entity.text.length <= 6) return "••••••";
  return `${entity.text.slice(0, 3)}${"•".repeat(Math.min(12, entity.text.length - 5))}${entity.text.slice(-2)}`;
}
