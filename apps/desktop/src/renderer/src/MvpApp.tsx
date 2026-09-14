import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import {
  ArrowClockwise,
  Brain,
  CaretDown,
  CaretRight,
  ChatCircleDots,
  CheckCircle,
  Database,
  Eye,
  EyeSlash,
  FileMd,
  FloppyDisk,
  Folder,
  Gear,
  House,
  Key,
  LockKey,
  LockOpen,
  MagnifyingGlass,
  Plus,
  ShieldCheck,
  Sparkle,
  Trash,
  Warning,
  X
} from "@phosphor-icons/react";
import IcCancelSend from "@renderer/assets/icons/ic_cancelSend.svg?react";
import IcHandwrite from "@renderer/assets/icons/ic_handwrite.svg?react";
import IcSave from "@renderer/assets/icons/ic_save.svg?react";
import IcSelectWord from "@renderer/assets/icons/ic_selectWord.svg?react";
import IcSend from "@renderer/assets/icons/ic_send.svg?react";
import type {
  DetectedEntity,
  DemoCredentialSummary,
  DatabaseAccessStatus,
  DemoCredentialReveal,
  DemoSaveReceipt,
  DemoSourceReveal,
  DemoSourceSummary,
  EntityType,
  MemoryFile,
  LocalStorageSettings,
  MemoryWritePolicy,
  ModelConnectionStatus,
  PreparedMemoryWrite,
  PrivacyAnalysis,
  ProtectionPolicy,
  ProtectionPreview
} from "@brainbuddy/domain";
import type { AgentReference, AgentRunDraft, AgentRuntimeEvent } from "@brainbuddy/agent-runtime";
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
  revealCredential,
  resolveAgentApproval,
  revealDemoSource,
  resetDatabase,
  saveExplicitProtectedText,
  searchDemoSources,
  streamAgentRun,
  testModelConnection,
  unlockDatabase
} from "./App";

type MvpPage = "home" | "database" | "memories" | "settings";
export type DatabaseRecordTab = "saved" | "credentials" | "conversation";
export type SendShortcut = "enter" | "mod-enter";

const SEND_SHORTCUT_STORAGE_KEY = "lookingfor.send-shortcut";

const navigation = [
  { id: "home", label: "主页", icon: House },
  { id: "database", label: "本地数据库", icon: Database },
  { id: "memories", label: "浏览本地记忆", icon: Brain },
  { id: "settings", label: "设置", icon: Gear }
] as const;

interface ChatMessage {
  readonly id: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly references?: readonly AgentReference[];
}

interface SaveFormState {
  readonly keyword: string;
  readonly secrets: readonly ManualSecretField[];
  readonly note: string;
}

interface ManualSecretField {
  readonly value: string;
  readonly exposeToMemory: boolean;
}

function emptyManualSecret(): ManualSecretField {
  return { value: "", exposeToMemory: false };
}

export function buildManualCapture(form: SaveFormState): {
  readonly text: string;
  readonly manual: readonly ManualSegment[];
  readonly manualDecisions: ProtectionRequest["decisions"];
} {
  let text = form.keyword.trim();
  const manual: ManualSegment[] = [];
  const manualDecisions: ProtectionRequest["decisions"][number][] = [];
  const secrets = form.secrets
    .map((secret) => ({ ...secret, value: secret.value.trim() }))
    .filter((secret) => Boolean(secret.value));
  secrets.forEach((secret, index) => {
    text += `\n${secretFieldLabel(index)}：`;
    const start = text.length;
    text += secret.value;
    manual.push({ start, end: text.length, entityType: "custom" });
    manualDecisions.push({
      start,
      end: text.length,
      policy: secret.exposeToMemory ? "keep_original" : "move_to_vault"
    });
  });
  if (form.note.trim()) text += `\n备注：${form.note.trim()}`;
  return { text, manual, manualDecisions };
}

const suggestionCards: readonly { readonly title: string; readonly example: string }[] = [
  { title: "保存一个网站的账号密码", example: "帮我保存 GitHub 的账号密码" },
  { title: "查找最近保存的信息", example: "最近保存的 DeepSeek API Key" },
  { title: "查询我的某个账号密码", example: "帮我查询我的 Figma 账号密码" }
];

const secretOrdinal = ["二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];

export function shouldSendQuestion(event: {
  readonly key: string;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly isComposing: boolean;
}, shortcut: SendShortcut): boolean {
  if (event.key !== "Enter" || event.isComposing) return false;
  if (shortcut === "mod-enter") return event.metaKey || event.ctrlKey;
  return !event.shiftKey;
}

function initialSendShortcut(): SendShortcut {
  if (typeof window === "undefined") return "enter";
  try {
    return window.localStorage.getItem(SEND_SHORTCUT_STORAGE_KEY) === "mod-enter" ? "mod-enter" : "enter";
  } catch {
    return "enter";
  }
}

function saveSendShortcut(shortcut: SendShortcut): void {
  try { window.localStorage.setItem(SEND_SHORTCUT_STORAGE_KEY, shortcut); }
  catch { /* The shortcut still applies for the current session. */ }
}

function modifierKeyLabel(): string {
  if (typeof navigator === "undefined") return "⌘";
  return /Mac|iPhone|iPad|iPod/u.test(navigator.userAgent) ? "⌘" : "Ctrl";
}

function secretFieldLabel(index: number): string {
  if (index <= 0) return "保密信息";
  return `保密信息${secretOrdinal[index - 1] ?? index + 1}`;
}

function manualEntityFromRange(text: string, start: number, end: number, type: EntityType = "custom", note = ""): DetectedEntity {
  return {
    text: text.slice(start, end),
    start,
    end,
    type,
    risk: "high",
    reason: ["用户手动划词选择加密"],
    suggestedPolicy: "move_to_vault",
    recognizerId: "manual-selection",
    ...(note.trim() ? { note: note.trim() } : {})
  };
}

interface ManualMeta {
  readonly type: EntityType;
  readonly note: string;
}

type ManualSegment = NonNullable<ProtectionRequest["manual"]>[number];

function toManualSegments(
  ranges: readonly { readonly start: number; readonly end: number }[],
  meta: Readonly<Record<string, ManualMeta>>
): readonly ManualSegment[] {
  return ranges.map(({ start, end }) => {
    const details = meta[`${start}:${end}`];
    return {
      start,
      end,
      entityType: details?.type ?? "custom",
      ...(details?.note.trim() ? { note: details.note.trim() } : {})
    };
  });
}

function mergedAnalysis(
  engine: PrivacyAnalysis | undefined,
  text: string,
  ranges: readonly { readonly start: number; readonly end: number }[],
  meta: Readonly<Record<string, ManualMeta>> = {}
): PrivacyAnalysis | undefined {
  if (!engine) return undefined;
  if (!ranges.length) return engine;
  const manual = ranges
    .filter(({ start, end }) => end > start && end <= text.length)
    .map(({ start, end }) => {
      const details = meta[`${start}:${end}`];
      return manualEntityFromRange(text, start, end, details?.type ?? "custom", details?.note);
    });
  const detected = engine.entities.filter((entity) => !manual.some((item) => item.start < entity.end && entity.start < item.end));
  return { ...engine, entities: [...detected, ...manual].sort((left, right) => left.start - right.start) };
}

export function activeQuestionProtectionRanges(
  analysis: PrivacyAnalysis | undefined,
  decisions: Readonly<Record<string, ProtectionPolicy>>,
  manualRanges: readonly { readonly start: number; readonly end: number }[]
): readonly { readonly start: number; readonly end: number }[] {
  const detected = (analysis?.entities ?? []).filter(
    (entity) => (decisions[questionEntityKey(entity)] ?? entity.suggestedPolicy) !== "keep_original"
  );
  return [...detected, ...manualRanges];
}

const EDIT_TYPE_OPTIONS: readonly { readonly value: EntityType; readonly label: string }[] = [
  { value: "password", label: "密码" },
  { value: "api_key", label: "API Key" },
  { value: "email", label: "邮箱或账号" },
  { value: "private_key", label: "私钥" },
  { value: "github_token", label: "GitHub Token" },
  { value: "jwt", label: "JWT" },
  { value: "high_entropy_secret", label: "疑似密钥" },
  { value: "person", label: "人物" },
  { value: "company", label: "公司" },
  { value: "project", label: "项目" },
  { value: "custom", label: "自定义信息" }
];

export async function prepareMvpAgentRun(options: {
  readonly text: string;
  readonly writePolicy: MemoryWritePolicy;
  readonly decisions: ProtectionRequest["decisions"];
  readonly onSaved: () => void;
  readonly manual?: ProtectionRequest["manual"];
  readonly prepare?: typeof prepareAgentRun;
}): Promise<AgentRunDraft> {
  const draft = await (options.prepare ?? prepareAgentRun)(options.text, options.writePolicy, options.decisions, options.manual);
  options.onSaved();
  return draft;
}

export function MvpApp(): JSX.Element {
  const [page, setPage] = useState<MvpPage>("home");
  const [recordRefresh, setRecordRefresh] = useState(0);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [runtimeSettings, setRuntimeSettings] = useState<LocalStorageSettings>();
  const [databaseAccess, setDatabaseAccess] = useState<DatabaseAccessStatus>();
  const [startupError, setStartupError] = useState<string>();

  useEffect(() => {
    void Promise.all([getLocalStorageSettings(), getDatabaseAccessStatus()])
      .then(([settings, access]) => {
        setRuntimeSettings(settings);
        setDatabaseAccess(access);
      })
      .catch((cause) => setStartupError(messageFrom(cause)));
  }, []);

  if (!databaseAccess || !runtimeSettings) {
    return <div className="mvp-vault-shell">{startupError
      ? <div className="mvp-vault-card"><Warning size={28} weight="duotone" /><h1>无法读取本地数据库状态</h1><p className="mvp-alert error" role="alert">{startupError}</p></div>
      : <LoadingState label="正在检查本地数据库" />}</div>;
  }
  if (!databaseAccess.unlocked) {
    return <DatabaseVaultGate access={databaseAccess} storageSettings={runtimeSettings} onAccessChange={setDatabaseAccess} onStorageSettingsChange={setRuntimeSettings} />;
  }

  return <div className="mvp-app">
    <aside className="mvp-sidebar">
      <button className="mvp-brand" type="button" onClick={() => setPage("home")} aria-label="返回 lookingfor 主页">
        <span className="mvp-brand-mark">L</span><strong>lookingfor</strong>
      </button>
      <nav aria-label="产品导航">
        {navigation.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={page === id ? "active" : ""} onClick={() => setPage(id)}>
          <Icon size={18} weight={page === id ? "fill" : "regular"} aria-hidden="true" /><span>{label}</span>
        </button>)}
      </nav>
      <div className="mvp-sidebar-foot">
        <ShieldCheck size={20} weight="duotone" aria-hidden="true" />
        <div><strong>本地优先，隐私至上</strong><span>原始数据只保存在本机</span></div>
      </div>
    </aside>
    <main className="mvp-main">
      <div hidden={page !== "home"}><HomePage active={page === "home"} memoryWritePolicy={runtimeSettings?.memoryWritePolicy ?? "auto_apply"} onSaved={() => { setRecordRefresh((value) => value + 1); setMemoryRefresh((value) => value + 1); }} /></div>
      <div hidden={page !== "database"}><DatabasePage refreshToken={recordRefresh} access={databaseAccess} onAccessChange={setDatabaseAccess} /></div>
      <div hidden={page !== "memories"}><MemoriesPage refreshToken={memoryRefresh} onRefresh={() => setMemoryRefresh((value) => value + 1)} /></div>
      <div hidden={page !== "settings"}><SettingsPage runtimeSettings={runtimeSettings} access={databaseAccess} onRuntimeSettingsChange={setRuntimeSettings} onAccessChange={setDatabaseAccess} /></div>
    </main>
  </div>;
}

function DatabaseVaultGate({ access, storageSettings, onAccessChange, onStorageSettingsChange }: {
  readonly access: DatabaseAccessStatus;
  readonly storageSettings: LocalStorageSettings;
  readonly onAccessChange: (status: DatabaseAccessStatus) => void;
  readonly onStorageSettingsChange: (settings: LocalStorageSettings) => void;
}): JSX.Element {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [paths, setPaths] = useState({ memoryDirectory: storageSettings.memoryDirectory, databaseDirectory: storageSettings.databaseDirectory });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const isCreating = !access.passwordConfigured;
  const pathsComplete = Boolean(paths.memoryDirectory.trim() && paths.databaseDirectory.trim());
  const canSubmit = password.length >= (isCreating ? 8 : 1) && (!isCreating || (password === confirmation && pathsComplete));

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(undefined);
    try {
      if (isCreating) {
        const configuredSettings = await configureLocalStorageSettings({
          ...storageSettings,
          memoryDirectory: paths.memoryDirectory,
          databaseDirectory: paths.databaseDirectory
        });
        onStorageSettingsChange(configuredSettings);
        const selectedAccess = await getDatabaseAccessStatus();
        if (selectedAccess.passwordConfigured) {
          onAccessChange(selectedAccess);
          setConfirmation("");
          setError("所选数据库目录中已有 lookingfor.sqlite，请输入该数据库原有密码解锁。");
          return;
        }
        onAccessChange(await configureDatabasePassword(undefined, password));
      } else {
        onAccessChange(await unlockDatabase(password));
      }
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setIsSubmitting(false);
    }
  }

  return <main className="mvp-vault-shell">
    <section className="mvp-vault-card">
      <div className="mvp-vault-mark"><LockKey size={27} weight="duotone" /></div>
      <span className="mvp-vault-brand">lookingfor</span>
      <h1>{isCreating ? "创建加密数据库" : "解锁本地数据库"}</h1>
      <p>{isCreating
        ? "设置一个数据库密码。数据将以 SQLCipher 兼容格式保存，其他程序获得密码后也可以直接访问。"
        : "输入数据库密码以打开本机的 SQLCipher 数据库。密码仅用于本地开库，不会发送给 AI。"}</p>
      {error && <p className="mvp-alert error" role="alert">{error}</p>}
      <form onSubmit={(event) => void submit(event)}>
        {isCreating && <fieldset className="mvp-vault-storage">
          <legend><Folder size={17} /><span>本地存储位置</span></legend>
          <label htmlFor="database-vault-directory">数据库目录</label>
          <input id="database-vault-directory" value={paths.databaseDirectory} spellCheck={false} onChange={(event) => setPaths((current) => ({ ...current, databaseDirectory: event.target.value }))} placeholder="lookingfor.sqlite 的保存目录" />
          <label htmlFor="memory-vault-directory">Memory 目录</label>
          <input id="memory-vault-directory" value={paths.memoryDirectory} spellCheck={false} onChange={(event) => setPaths((current) => ({ ...current, memoryDirectory: event.target.value }))} placeholder="Markdown Memory 的保存目录" />
          <small>必须是两个独立、可读写的绝对目录，不能使用磁盘根目录、用户主目录或符号链接。</small>
        </fieldset>}
        <VaultPasswordField id="database-vault-password" label={isCreating ? "数据库密码" : "密码"} autoComplete={isCreating ? "new-password" : "current-password"} minLength={isCreating ? 8 : 1} autoFocus value={password} onChange={setPassword} placeholder={isCreating ? "至少 8 个字符" : "输入数据库密码"} />
        {isCreating && <VaultPasswordField id="database-vault-confirmation" label="确认密码" autoComplete="new-password" minLength={8} value={confirmation} onChange={setConfirmation} placeholder="再次输入数据库密码" />}
        {isCreating && confirmation && password !== confirmation && <small className="mvp-vault-validation">两次输入的密码不一致</small>}
        <button className="mvp-primary" type="submit" disabled={!canSubmit || isSubmitting}>{isSubmitting ? "处理中" : isCreating ? "创建并解锁" : "解锁数据库"}</button>
      </form>
      <small className="mvp-vault-note">请妥善保存密码。丢失后无法恢复数据库中的 Source、Credential 或 AI 连接密钥。</small>
    </section>
  </main>;
}

function VaultPasswordField({ id, label, value, placeholder, autoComplete, minLength, autoFocus = false, onChange }: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder: string;
  readonly autoComplete: "new-password" | "current-password";
  readonly minLength: number;
  readonly autoFocus?: boolean;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  const [visible, setVisible] = useState(false);
  const action = visible ? "隐藏" : "显示";
  return <div className="mvp-vault-field">
    <label htmlFor={id}>{label}</label>
    <div className="mvp-vault-password-input">
      <input id={id} type={visible ? "text" : "password"} autoComplete={autoComplete} minLength={minLength} maxLength={128} autoFocus={autoFocus} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} />
      <button className="mvp-vault-visibility" type="button" aria-label={`${action}${label}`} aria-pressed={visible} title={`${action}${label}`} onClick={() => setVisible((current) => !current)}>
        {visible ? <EyeSlash size={19} /> : <Eye size={19} />}
      </button>
    </div>
  </div>;
}

export function ManualSecretInput({ value, onChange }: {
  readonly value: string;
  readonly onChange: (value: string) => void;
}): JSX.Element {
  return <input type="text" value={value} onChange={(event) => onChange(event.target.value)} placeholder="输入需要保密的信息" />;
}

function PageHeader({ title, copy }: { readonly title: string; readonly copy: string }): JSX.Element {
  return <header className="mvp-page-head"><h1>{title}</h1><p>{copy}</p></header>;
}

function HomePage({ active, memoryWritePolicy, onSaved }: { readonly active: boolean; readonly memoryWritePolicy: MemoryWritePolicy; readonly onSaved: () => void }): JSX.Element {
  const [mode, setMode] = useState<"auto" | "manual">("auto");
  const [question, setQuestion] = useState("");
  const [questionAnalysis, setQuestionAnalysis] = useState<PrivacyAnalysis>();
  const [questionPreview, setQuestionPreview] = useState<ProtectionPreview>();
  const [questionDecisions, setQuestionDecisions] = useState<Record<string, ProtectionPolicy>>({});
  const [questionCredentialIds, setQuestionCredentialIds] = useState<Record<string, string>>({});
  const [isCheckingQuestion, setIsCheckingQuestion] = useState(false);
  const [questionProtectionError, setQuestionProtectionError] = useState<string>();
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [runId, setRunId] = useState<string>();
  const [isRunning, setIsRunning] = useState(false);
  const [revealedCredential, setRevealedCredential] = useState<DemoCredentialReveal>();
  const [revealingCredentialId, setRevealingCredentialId] = useState<string>();
  const [credentialRevealError, setCredentialRevealError] = useState<string>();
  const [approval, setApproval] = useState<PreparedMemoryWrite>();
  const [error, setError] = useState<string>();
  const [saveForm, setSaveForm] = useState<SaveFormState>({ keyword: "", secrets: [emptyManualSecret()], note: "" });
  const [isSaving, setIsSaving] = useState(false);
  const [receipt, setReceipt] = useState<DemoSaveReceipt>();
  const [sendShortcut, setSendShortcut] = useState<SendShortcut>(initialSendShortcut);
  const questionSequence = useRef(0);
  const messageSequence = useRef(0);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
  const conversationScrollRef = useRef(0);
  const lastAutoScrollKey = useRef("");
  const [manualRanges, setManualRanges] = useState<readonly { readonly start: number; readonly end: number }[]>([]);
  const [manualMeta, setManualMeta] = useState<Readonly<Record<string, ManualMeta>>>({});
  const [selection, setSelection] = useState<{ readonly start: number; readonly end: number }>();
  const [toast, setToast] = useState<string>();
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function showToast(message: string): void {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 3000);
  }

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const conversationAttachRef = useCallback((element: HTMLDivElement | null) => {
    conversationRef.current = element;
    if (!element) return;
    const key = `${messages.length}|${isRunning}|${approval?.approvalId ?? ""}`;
    if (lastAutoScrollKey.current === key) {
      // 模式切换导致对话区重新挂载：恢复之前的滚动位置
      element.scrollTop = conversationScrollRef.current;
    } else {
      lastAutoScrollKey.current = key;
      element.scrollTop = element.scrollHeight;
      conversationScrollRef.current = element.scrollHeight;
    }
  }, [messages, isRunning, approval]);

  useEffect(() => {
    const element = conversationRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    conversationScrollRef.current = element.scrollHeight;
    lastAutoScrollKey.current = `${messages.length}|${isRunning}|${approval?.approvalId ?? ""}`;
  }, [messages, isRunning, approval]);

  useEffect(() => {
    const element = questionRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [question, mode]);

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

  useEffect(() => {
    if (!active) {
      setRevealedCredential(undefined);
      setCredentialRevealError(undefined);
    }
  }, [active]);

  useEffect(() => {
    if (!selection || isRunning || isCheckingQuestion || !questionAnalysis) return;
    void encryptSelection(selection);
  }, [selection, isRunning, isCheckingQuestion, questionAnalysis]);

  async function analyzeQuestion(text: string, sequence: number): Promise<void> {
    try {
      const analysis = await analyzeInput(text);
      const decisions: Record<string, ProtectionPolicy> = Object.fromEntries(analysis.entities.map((entity) => [questionEntityKey(entity), "move_to_vault" as ProtectionPolicy]));
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
    setManualRanges([]);
    setManualMeta({});
    setSelection(undefined);
    setIsCheckingQuestion(Boolean(text.trim()));
  }

  async function saveEncryption(entity: DetectedEntity, next: { readonly start: number; readonly end: number; readonly text: string; readonly type: EntityType; readonly note: string }): Promise<void> {
    if (!questionAnalysis) return;
    const sequence = ++questionSequence.current;
    const text = question;
    const oldKey = questionEntityKey(entity);
    const newKey = `${next.start}:${next.end}`;
    const isManualOld = manualRanges.some((range) => range.start === entity.start && range.end === entity.end);
    const decisions = { ...questionDecisions };
    const nextManual = [...manualRanges];
    const nextMeta = { ...manualMeta };
    if (newKey === oldKey) {
      decisions[newKey] = "move_to_vault";
      if (!isManualOld) nextManual.push({ start: next.start, end: next.end });
      nextMeta[newKey] = { type: next.type, note: next.note };
    } else {
      if (isManualOld) {
        const index = nextManual.findIndex((range) => range.start === entity.start && range.end === entity.end);
        if (index >= 0) nextManual.splice(index, 1);
        delete nextMeta[oldKey];
      } else {
        decisions[oldKey] = "keep_original";
      }
      nextManual.push({ start: next.start, end: next.end });
      decisions[newKey] = "move_to_vault";
      nextMeta[newKey] = { type: next.type, note: next.note };
    }
    setIsCheckingQuestion(true);
    setQuestionProtectionError(undefined);
    try {
      const merged = mergedAnalysis(questionAnalysis, text, nextManual, nextMeta);
      const preview = await previewProtection({
        text,
        decisions: merged ? buildQuestionProtectionDecisions(merged, decisions, questionCredentialIds) : [],
        ...(nextManual.length ? { manual: toManualSegments(nextManual, nextMeta) } : {})
      });
      if (questionSequence.current !== sequence) return;
      setManualRanges(nextManual);
      setManualMeta(nextMeta);
      setQuestionDecisions(decisions);
      setQuestionCredentialIds((current) => ({ ...current, ...questionCredentialIdsFrom(preview) }));
      setQuestionPreview(preview);
    } catch (cause) {
      if (questionSequence.current === sequence) setQuestionProtectionError(messageFrom(cause));
    } finally {
      if (questionSequence.current === sequence) setIsCheckingQuestion(false);
    }
  }

  async function removeEncryption(entity: DetectedEntity): Promise<void> {
    if (!questionAnalysis) return;
    const sequence = ++questionSequence.current;
    const text = question;
    const key = questionEntityKey(entity);
    const isManual = manualRanges.some((range) => range.start === entity.start && range.end === entity.end);
    const decisions: Record<string, ProtectionPolicy> = { ...questionDecisions, [key]: "keep_original" };
    const nextManual = isManual ? manualRanges.filter((range) => !(range.start === entity.start && range.end === entity.end)) : manualRanges;
    const nextMeta = { ...manualMeta };
    if (isManual) delete nextMeta[key];
    setIsCheckingQuestion(true);
    setQuestionProtectionError(undefined);
    try {
      const merged = mergedAnalysis(questionAnalysis, text, nextManual, nextMeta);
      const preview = await previewProtection({
        text,
        decisions: merged ? buildQuestionProtectionDecisions(merged, decisions, questionCredentialIds) : [],
        ...(nextManual.length ? { manual: toManualSegments(nextManual, nextMeta) } : {})
      });
      if (questionSequence.current !== sequence) return;
      setManualRanges(nextManual);
      setManualMeta(nextMeta);
      setQuestionDecisions(decisions);
      setQuestionCredentialIds((current) => ({ ...current, ...questionCredentialIdsFrom(preview) }));
      setQuestionPreview(preview);
    } catch (cause) {
      if (questionSequence.current === sequence) setQuestionProtectionError(messageFrom(cause));
    } finally {
      if (questionSequence.current === sequence) setIsCheckingQuestion(false);
    }
  }

  const hasConversation = messages.length > 0 || isRunning;
  const chatting = mode === "auto" && hasConversation;

  async function runAgent(): Promise<void> {
    const merged = mergedAnalysis(questionAnalysis, question, manualRanges, manualMeta);
    if (!question.trim() || !merged || !questionPreview?.readyToSave || isCheckingQuestion || isRunning) return;
    const text = question;
    const decisions = buildQuestionProtectionDecisions(merged, questionDecisions, questionCredentialIds);
    const sentManual = toManualSegments(manualRanges, manualMeta);
    setMessages((current) => [...current, { id: ++messageSequence.current, role: "user", text }]);
    updateQuestion("");
    setRunId(undefined);
    setIsRunning(true);
    setRevealedCredential(undefined);
    setCredentialRevealError(undefined);
    setApproval(undefined);
    setError(undefined);
    try {
      const draft = await prepareMvpAgentRun({
        text,
        writePolicy: memoryWritePolicy,
        decisions,
        onSaved,
        ...(sentManual.length ? { manual: sentManual } : {})
      });
      await streamAgentRun(draft.draftId, (event: AgentRuntimeEvent) => {
        setRunId(event.runId);
        if (event.type === "approval_required") setApproval(event.prepared);
        if (event.type === "approved" || event.type === "denied") setApproval(undefined);
        if (event.type === "agent_completed") {
          setMessages((current) => [...current, {
            id: ++messageSequence.current,
            role: "assistant",
            text: event.result.message,
            ...(event.result.status === "completed" ? { references: event.result.references } : {})
          }]);
        }
        if (event.type === "agent_failed" || event.type === "agent_cancelled") {
          setMessages((current) => [...current, { id: ++messageSequence.current, role: "assistant", text: event.result.message }]);
        }
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

  async function revealAnswerCredential(credentialId: string): Promise<void> {
    setRevealingCredentialId(credentialId);
    setCredentialRevealError(undefined);
    setRevealedCredential(undefined);
    try {
      setRevealedCredential(await revealCredential(credentialId));
    } catch (cause) {
      setCredentialRevealError(messageFrom(cause));
    } finally {
      setRevealingCredentialId(undefined);
    }
  }

  async function saveRecord(): Promise<void> {
    const secrets = saveForm.secrets
      .map((secret) => ({ ...secret, value: secret.value.trim() }))
      .filter((secret) => Boolean(secret.value));
    if (!saveForm.keyword.trim() || !secrets.length) return;
    setIsSaving(true);
    setError(undefined);
    setReceipt(undefined);
    const { text, manual, manualDecisions } = buildManualCapture({ ...saveForm, secrets });
    try {
      const nextReceipt = await saveExplicitProtectedText(text, manual, manualDecisions);
      setReceipt(nextReceipt);
      setSaveForm((current) => ({ ...current, secrets: [emptyManualSecret()] }));
      onSaved();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setIsSaving(false);
    }
  }

  function switchMode(next: "auto" | "manual"): void {
    if (next === mode) return;
    setMode(next);
    if (next === "manual") {
      setSaveForm({ keyword: "", secrets: [emptyManualSecret()], note: "" });
      setReceipt(undefined);
      setError(undefined);
    }
  }

  function updateSecret(index: number, value: string): void {
    setSaveForm((current) => ({
      ...current,
      secrets: current.secrets.map((secret, i) => i === index ? { ...secret, value } : secret)
    }));
  }

  function updateSecretMemoryVisibility(index: number, exposeToMemory: boolean): void {
    setSaveForm((current) => ({
      ...current,
      secrets: current.secrets.map((secret, i) => i === index ? { ...secret, exposeToMemory } : secret)
    }));
  }

  function addSecretField(): void {
    if (saveForm.secrets.length >= 20) return;
    setSaveForm((current) => ({ ...current, secrets: [...current.secrets, emptyManualSecret()] }));
  }

  function removeSecretField(index: number): void {
    setSaveForm((current) => ({
      ...current,
      secrets: current.secrets.length > 1 ? current.secrets.filter((_, i) => i !== index) : [emptyManualSecret()]
    }));
  }

  async function encryptSelection(selected: { readonly start: number; readonly end: number }): Promise<void> {
    if (selected.end <= selected.start || isRunning || isCheckingQuestion) return;
    const { start, end } = selected;
    if (end > question.length) return;
    const protectedRanges = activeQuestionProtectionRanges(questionAnalysis, questionDecisions, manualRanges);
    if (protectedRanges.some((item) => item.start < end && start < item.end)) {
      showToast("选中内容已在保护范围内，请选择其他文本。");
      setSelection(undefined);
      return;
    }
    const nextManual = [...manualRanges, { start, end }];
    const key = `${start}:${end}`;
    const nextMeta = { ...manualMeta, [key]: { type: "custom" as EntityType, note: "" } };
    const nextDecisions = { ...questionDecisions, [key]: "move_to_vault" as ProtectionPolicy };
    const sequence = ++questionSequence.current;
    setIsCheckingQuestion(true);
    setQuestionProtectionError(undefined);
    setSelection(undefined);
    try {
      const merged = mergedAnalysis(questionAnalysis, question, nextManual, nextMeta);
      const preview = await previewProtection({
        text: question,
        decisions: merged ? buildQuestionProtectionDecisions(merged, nextDecisions, questionCredentialIds) : [],
        ...(nextManual.length ? { manual: toManualSegments(nextManual, nextMeta) } : {})
      });
      if (questionSequence.current !== sequence) return;
      setManualRanges(nextManual);
      setManualMeta(nextMeta);
      setQuestionDecisions(nextDecisions);
      setQuestionCredentialIds((current) => ({ ...current, ...questionCredentialIdsFrom(preview) }));
      setQuestionPreview(preview);
    } catch (cause) {
      if (questionSequence.current === sequence) setQuestionProtectionError(messageFrom(cause));
    } finally {
      if (questionSequence.current === sequence) setIsCheckingQuestion(false);
    }
  }

  const merged = mergedAnalysis(questionAnalysis, question, manualRanges, manualMeta);

  const canSendAuto = Boolean(question.trim()) && Boolean(questionPreview?.readyToSave) && !isCheckingQuestion && !questionProtectionError && !isRunning;
  const showSuggestions = mode === "auto" && !hasConversation && !question.trim();

  return <div className={`mvp-home ${chatting ? "chatting" : ""}`}>
    {!chatting && <header className="mvp-home-hero">
      <h1>lookingfor</h1>
      <p>本地优先的隐私 AI 记忆管理，让重要信息只属于你</p>
    </header>}
    {toast && <div className="mvp-toast" role="status">{toast}</div>}
    {error && <p className="mvp-alert error" role="alert">{error}</p>}

    <div className={`mvp-home-content ${chatting ? "chatting" : ""}`}>
    {mode === "auto" ? (
      <>
        {showSuggestions && (
          <div className="mvp-suggestion-block" aria-label="试着问这些">
            <span className="mvp-suggestion-label">试着问这些</span>
            <div className="mvp-suggestion-row">
              {suggestionCards.map((card) => <button key={card.title} type="button" className="mvp-suggestion-card" onClick={() => updateQuestion(card.example)}><strong>{card.title}</strong><span>例如：{card.example}</span></button>)}
            </div>
          </div>
        )}
        {hasConversation && <div className="mvp-conversation" ref={conversationAttachRef} onScroll={(event) => { conversationScrollRef.current = event.currentTarget.scrollTop; }} aria-live="polite" aria-label="对话内容">
          {messages.map((message) => <MessageBubble key={message.id} message={message} revealingCredentialId={revealingCredentialId} revealedCredential={revealedCredential} credentialRevealError={credentialRevealError} onReveal={revealAnswerCredential} onCloseReveal={() => setRevealedCredential(undefined)} />)}
          {isRunning && <div className="mvp-bubble assistant"><AssistantHeader /><div className="mvp-bubble-loading"><em>正在思考</em><span className="mvp-loading-dots"><i /><i /><i /></span></div></div>}
        </div>}
        {approval ? (
          <section className="mvp-card mvp-approval-panel" role="alertdialog" aria-label="写入授权">
            <header>
              <span className="mvp-approval-icon"><LockKey size={18} weight="duotone" /></span>
              <div><strong>允许写入 {approval.path}？</strong><small>{approval.reason}</small></div>
            </header>
            <pre>{approval.diff}</pre>
            <footer>
              <button className="mvp-secondary" type="button" onClick={() => void decide("deny")}>拒绝</button>
              <button className="mvp-primary" type="button" onClick={() => void decide("approve")}>批准写入</button>
            </footer>
          </section>
        ) : (
          <section className="mvp-card mvp-composer">
            <QuestionProtectionNotice analysis={merged} preview={questionPreview} decisions={questionDecisions} isChecking={isCheckingQuestion} error={questionProtectionError} text={question} onSaveEntity={saveEncryption} onRemoveEntity={removeEncryption} />
            <div className="mvp-composer-body">
            <textarea id="mvp-question" ref={questionRef} value={question} disabled={isRunning} onChange={(event) => updateQuestion(event.target.value)} onKeyDown={(event) => { if (!shouldSendQuestion({ key: event.key, shiftKey: event.shiftKey, metaKey: event.metaKey, ctrlKey: event.ctrlKey, isComposing: event.nativeEvent.isComposing }, sendShortcut)) return; event.preventDefault(); if (canSendAuto) void runAgent(); }} onSelect={(event) => { const element = event.currentTarget; const start = element.selectionStart ?? 0; const end = element.selectionEnd ?? 0; setSelection(start === end ? undefined : { start: Math.min(start, end), end: Math.max(start, end) }); }} placeholder="输入你想记住或查询的内容" />
            <div className="mvp-composer-bar">
              <ModeToggle mode={mode} onSwitch={switchMode} />
              <span className="mvp-scratch-wrap">
                <span className="mvp-scratch-lock" aria-describedby="mvp-scratch-tip"><IcSelectWord />划词自动加密</span>
                <span id="mvp-scratch-tip" className="mvp-scratch-tip" role="tooltip">在输入框划取文字后自动加入敏感字段</span>
              </span>
              <span className="mvp-composer-spacer" />
              {!isRunning && <SendShortcutControl shortcut={sendShortcut} onChange={(next) => { setSendShortcut(next); saveSendShortcut(next); }} />}
              {isRunning
                ? <button className="mvp-send mvp-primary" type="button" disabled={!runId} onClick={() => { if (runId) void cancelAgentRun(runId); }} aria-label="取消发送"><IcCancelSend /></button>
                : <button className="mvp-send mvp-primary" type="button" disabled={!canSendAuto} onClick={() => void runAgent()} aria-label="发送" aria-keyshortcuts={sendShortcut === "enter" ? "Enter" : "Meta+Enter Control+Enter"}><IcSend /></button>}
            </div>
            </div>
          </section>
        )}
      </>
    ) : (
      <section className="mvp-card mvp-composer mvp-manual">
        {receipt && <div className="mvp-protect-banner safe" role="status"><CheckCircle size={18} weight="fill" /><span>已保存 Source {receipt.sourceId} 和 {receipt.credentialIds.length} 条保密信息，并同步生成 Memory 索引。</span></div>}
        <div className="mvp-manual-body">
        <div className="mvp-manual-fields">
          <label className="mvp-field-row"><span className="mvp-field-name">关键词</span><div className="mvp-field-control"><input value={saveForm.keyword} onChange={(event) => setSaveForm({ ...saveForm, keyword: event.target.value })} placeholder="输入需要保密信息的关键词，方便索引" /></div></label>
          {saveForm.secrets.map((secret, index) => (
            <div className="mvp-manual-secret-group" key={index}>
              <label className="mvp-field-row">
                <span className="mvp-field-name">{secretFieldLabel(index)}</span>
                <div className="mvp-field-control">
                  <ManualSecretInput value={secret.value} onChange={(value) => updateSecret(index, value)} />
                  {index > 0 && <button type="button" className="mvp-field-remove" aria-label="删除这条保密信息" onClick={() => removeSecretField(index)}><X size={18} /></button>}
                </div>
              </label>
              <label className={`mvp-memory-visibility${secret.exposeToMemory ? " enabled" : ""}`}>
                <input type="checkbox" checked={secret.exposeToMemory} onChange={(event) => updateSecretMemoryVisibility(index, event.target.checked)} />
                <span><strong>允许 AI 读取此项</strong><small>勾选后以明文写入 Memory，不创建 Credential</small></span>
              </label>
            </div>
          ))}
          <div className="mvp-add-secret-row"><button type="button" className="mvp-add-secret" disabled={saveForm.secrets.length >= 20} onClick={addSecretField}><Plus size={13} weight="bold" />{saveForm.secrets.length >= 20 ? "最多添加 20 项" : "添加保密信息"}</button></div>
          <label className="mvp-field-row"><span className="mvp-field-name">备注</span><div className="mvp-field-control"><input value={saveForm.note} onChange={(event) => setSaveForm({ ...saveForm, note: event.target.value })} placeholder="备注信息" /></div></label>
        </div>
        <div className="mvp-composer-bar">
          <ModeToggle mode={mode} onSwitch={switchMode} />
          <span className="mvp-composer-spacer" />
          <button className="mvp-send mvp-primary" type="button" disabled={isSaving || !saveForm.keyword.trim() || !saveForm.secrets.some((secret) => secret.value.trim())} onClick={() => void saveRecord()} aria-label="保存"><IcSave /></button>
        </div>
        </div>
      </section>
    )}
    </div>

    <footer className="mvp-home-footer">所有数据保存在本地知识库，调用 AI 时仅使用你确认后的脱敏内容</footer>
  </div>;
}

function ModeToggle({ mode, onSwitch }: { readonly mode: "auto" | "manual"; readonly onSwitch: (mode: "auto" | "manual") => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  const options = [
    { value: "auto", label: "自动判断", hint: "一句话查询或记忆，AI 自动理解意图" },
    { value: "manual", label: "手动录入", hint: "直接保存一条隐私记录到本地" }
  ] as const;
  const label = mode === "auto" ? "自动判断" : "手动录入";
  return <div className="mvp-mode-menu">
    <button type="button" className="mvp-mode-toggle" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} title="切换输入方式">
      {mode === "auto" ? <Sparkle size={15} weight="fill" /> : <IcHandwrite />}
      <span>{label}</span>
      <CaretDown size={12} />
    </button>
    {open && <>
      <div className="mvp-mode-backdrop" onClick={() => setOpen(false)} />
      <div className="mvp-mode-options" role="menu" aria-label="输入方式">
        {options.map((option) => <button key={option.value} type="button" role="menuitem" className={mode === option.value ? "active" : ""} onClick={() => { onSwitch(option.value); setOpen(false); }}>
          {option.value === "auto" ? <Sparkle size={16} weight="fill" /> : <IcHandwrite />}
          <span><strong>{option.label}</strong><small>{option.hint}</small></span>
          {mode === option.value && <CheckCircle size={16} weight="fill" />}
        </button>)}
      </div>
    </>}
  </div>;
}

function SendShortcutControl({ shortcut, onChange }: {
  readonly shortcut: SendShortcut;
  readonly onChange: (shortcut: SendShortcut) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const modifier = modifierKeyLabel();
  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);
  const options: readonly { readonly value: SendShortcut; readonly label: string; readonly hint: string }[] = [
    { value: "enter", label: "Enter 发送", hint: "Shift + Enter 换行" },
    { value: "mod-enter", label: `${modifier} + Enter 发送`, hint: "Enter 换行" }
  ];
  const currentLabel = shortcut === "enter" ? "Enter 发送" : `${modifier} + Enter 发送`;
  return <div className="mvp-send-shortcut">
    <span className="mvp-send-shortcut-label">{currentLabel}</span>
    <button type="button" className="mvp-send-shortcut-toggle" onClick={() => setOpen((value) => !value)} aria-label="切换发送快捷键" aria-haspopup="menu" aria-expanded={open} title="切换发送快捷键"><CaretDown size={14} /></button>
    {open && <>
      <div className="mvp-mode-backdrop" onClick={() => setOpen(false)} />
      <div className="mvp-send-shortcut-menu" role="menu" aria-label="发送快捷键">
        {options.map((option) => <button key={option.value} type="button" role="menuitemradio" aria-checked={shortcut === option.value} className={shortcut === option.value ? "active" : ""} onClick={() => { onChange(option.value); setOpen(false); }}>
          <span><strong>{option.label}</strong><small>{option.hint}</small></span>
          {shortcut === option.value && <CheckCircle size={16} weight="fill" />}
        </button>)}
      </div>
    </>}
  </div>;
}

function MessageBubble({ message, revealingCredentialId, revealedCredential, credentialRevealError, onReveal, onCloseReveal }: {
  readonly message: ChatMessage;
  readonly revealingCredentialId: string | undefined;
  readonly revealedCredential: DemoCredentialReveal | undefined;
  readonly credentialRevealError: string | undefined;
  readonly onReveal: (credentialId: string) => Promise<void>;
  readonly onCloseReveal: () => void;
}): JSX.Element {
  if (message.role === "user") {
    return <div className="mvp-bubble user"><div className="mvp-bubble-body">{message.text}</div></div>;
  }
  return <div className="mvp-bubble assistant">
    <AssistantHeader />
    <div className="mvp-bubble-body">
      <CredentialAwareAnswer text={message.text} revealingCredentialId={revealingCredentialId} onReveal={onReveal} />
      {message.references && message.references.length > 0 && <div className="mvp-reference-list">{message.references.map((reference) => reference.kind === "credential" ? <button type="button" className="mvp-ref-chip" key={`${reference.kind}:${reference.id}`} disabled={revealingCredentialId === reference.id} onClick={() => void onReveal(reference.id)}>{reference.kind}: {reference.id}</button> : <span className="mvp-ref-chip" key={`${reference.kind}:${reference.id}`}>{reference.kind}: {reference.id}</span>)}</div>}
      {credentialRevealError && <p className="mvp-inline-error" role="alert">{credentialRevealError}</p>}
      {revealedCredential && <div className="mvp-credential-reveal" role="region" aria-label="已解锁的凭据明文"><div><strong>{questionEntityTypeLabel(revealedCredential.entityType)}明文</strong><button type="button" aria-label="关闭凭据明文" onClick={onCloseReveal}><X size={16} /></button></div><code>{revealedCredential.value}</code><small>仅在当前界面临时显示，不会发送给 AI。</small></div>}
    </div>
  </div>;
}

function AssistantHeader(): JSX.Element {
  return <div className="mvp-bubble-head">
    <div className="mvp-bubble-avatar"><strong>L</strong></div>
    <span className="mvp-bubble-name">lookingfor</span>
  </div>;
}

interface EditResult {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly type: EntityType;
  readonly note: string;
}

function QuestionProtectionNotice({ analysis, preview, decisions, isChecking, error, text, onSaveEntity, onRemoveEntity }: {
  readonly analysis: PrivacyAnalysis | undefined;
  readonly preview: ProtectionPreview | undefined;
  readonly decisions: Readonly<Record<string, ProtectionPolicy>>;
  readonly isChecking: boolean;
  readonly error: string | undefined;
  readonly text: string;
  readonly onSaveEntity: (entity: DetectedEntity, next: EditResult) => Promise<void>;
  readonly onRemoveEntity: (entity: DetectedEntity) => Promise<void>;
}): JSX.Element | null {
  const [editing, setEditing] = useState<DetectedEntity>();
  const [value, setValue] = useState("");
  const [type, setType] = useState<EntityType>("custom");
  const [note, setNote] = useState("");
  const [sel, setSel] = useState<{ readonly start: number; readonly end: number }>();
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (editing) {
      setValue(editing.text);
      setType(editing.type);
      setNote(editing.note ?? "");
      setSel(undefined);
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setEditing(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editing]);

  if (isChecking) return <div className="mvp-protect-banner checking" role="status"><ShieldCheck size={18} weight="duotone" /><span>正在本地检查敏感信息</span></div>;
  if (error) return <div className="mvp-protect-banner error" role="alert"><Warning size={18} weight="duotone" /><span>{error}</span></div>;
  if (!analysis || !preview) return null;

  const visible = analysis.entities.filter((entity) => (decisions[questionEntityKey(entity)] ?? entity.suggestedPolicy) !== "keep_original");
  if (!analysis.entities.length) return <div className="mvp-protect-banner safe" role="status"><ShieldCheck size={18} weight="fill" /><span>本地检查完成，未发现需要保护的字段</span></div>;
  if (!visible.length) return null;

  return <section className="mvp-protect-panel" aria-label="本地保护提示">
    <header>
      <span className="mvp-protect-panel-icon"><Warning size={20} weight="duotone" /></span>
      <div>
        <strong>检测到 {visible.length} 个敏感字段</strong>
        <small>默认抽离为凭据，原文不会发送给 AI，可点击进行加密设置。</small>
      </div>
    </header>
    <div className="mvp-protect-entities">
      {visible.map((entity) => {
        const key = questionEntityKey(entity);
        const credential = preview.credentials.find((item) => item.start === entity.start && item.end === entity.end);
        return <div key={key} className="mvp-protect-entity-row">
          <button type="button" className="mvp-protect-entity vault" onClick={() => setEditing(entity)} title="点击编辑加密方式">
            <span className="mvp-protect-entity-badge"><em>{questionEntityTypeLabel(entity.type)}</em><code>{entity.text}</code></span>
            <span className="mvp-protect-ai-view">AI 可见版本 <code>{credential ? credential.ref : entity.text}</code></span>
          </button>
          <button
            type="button"
            className="mvp-protect-plaintext"
            aria-label={`解除 ${questionEntityTypeLabel(entity.type)} 加密，提交时保存明文`}
            title="解除加密，提交时保存明文"
            onClick={() => void onRemoveEntity(entity)}
          >
            <LockOpen size={17} aria-hidden="true" />
          </button>
        </div>;
      })}
    </div>

    {editing && <div className="mvp-protect-modal">
      <div className="mvp-protect-modal-backdrop" onClick={() => setEditing(undefined)} />
      <div className="mvp-protect-modal-card mvp-edit-card" role="dialog" aria-modal="true" aria-label="编辑识别项">
        <header className="mvp-edit-head"><strong>编辑识别项</strong><button type="button" aria-label="关闭" onClick={() => setEditing(undefined)}><X size={18} /></button></header>
        <div className="mvp-edit-fields">
          <div className="mvp-edit-row"><span className="mvp-edit-label">识别值</span><input autoFocus value={value} onChange={(event) => setValue(event.target.value)} placeholder="识别值" /></div>
          <div className="mvp-edit-row"><span className="mvp-edit-label">脱敏类型</span><div className="mvp-edit-select"><select value={type} onChange={(event) => setType(event.target.value as EntityType)} aria-label="脱敏类型">{EDIT_TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><CaretDown size={14} /></div></div>
          <div className="mvp-edit-row"><span className="mvp-edit-label">备注</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="备注信息" /></div>
          <div className="mvp-edit-row"><span className="mvp-edit-label">脱敏后</span><div className="mvp-masked-chip"><code>{preview.credentials.find((item) => item.start === editing.start && item.end === editing.end)?.ref ?? "-"}</code></div></div>
        </div>
        <div className="mvp-original">
          <span>原文(在下方划动选择一段文本，自动作为识别值)</span>
          <textarea readOnly value={text} onSelect={(event) => { const element = event.currentTarget; const s = element.selectionStart ?? 0; const e = element.selectionEnd ?? 0; if (s !== e) { setSel({ start: s, end: e }); setValue(text.slice(s, e)); } }} />
        </div>
        <footer className="mvp-edit-actions">
          <button type="button" className="mvp-remove-enc" disabled={applying} onClick={() => void removeEncryptionItem()}>移除加密</button>
          <button type="button" className="mvp-cancel-enc" onClick={() => setEditing(undefined)}>取消</button>
          <button type="button" className="mvp-save-enc" disabled={applying} onClick={() => void saveEncryptionItem()}>保存更改</button>
        </footer>
      </div>
    </div>}
  </section>;

  async function saveEncryptionItem(): Promise<void> {
    if (!editing) return;
    const range = sel ?? { start: editing.start, end: editing.end };
    const resolvedText = sel ? text.slice(range.start, range.end) : editing.text;
    setApplying(true);
    try {
      await onSaveEntity(editing, { start: range.start, end: range.end, text: resolvedText, type, note });
      setEditing(undefined);
    } catch {
      // 错误信息由上层 saveEncryption 回显
    } finally {
      setApplying(false);
    }
  }
  async function removeEncryptionItem(): Promise<void> {
    if (!editing) return;
    setApplying(true);
    try {
      await onRemoveEntity(editing);
      setEditing(undefined);
    } catch {
      // 错误信息由上层 removeEncryption 回显
    } finally {
      setApplying(false);
    }
  }
}

export type CredentialTextPart =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "credential"; readonly credentialId: string; readonly value: string };

export function splitCredentialReferences(text: string): CredentialTextPart[] {
  const pattern = /\[CREDENTIAL:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\]/giu;
  const parts: CredentialTextPart[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index;
    if (index > cursor) parts.push({ type: "text", value: text.slice(cursor, index) });
    parts.push({ type: "credential", credentialId: match[1]!, value: match[0] });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ type: "text", value: text.slice(cursor) });
  return parts.length ? parts : [{ type: "text", value: text }];
}

function CredentialAwareAnswer({ text, revealingCredentialId, onReveal }: {
  readonly text: string;
  readonly revealingCredentialId: string | undefined;
  readonly onReveal: (credentialId: string) => Promise<void>;
}): JSX.Element {
  return <p>{splitCredentialReferences(text).map((part, index) => part.type === "text"
    ? <span key={`text:${index}`}>{part.value}</span>
    : <button className="mvp-credential-reference" type="button" key={`${part.credentialId}:${index}`} disabled={revealingCredentialId === part.credentialId} onClick={() => void onReveal(part.credentialId)}>{part.value}</button>)}</p>;
}

function SectionTitle({ icon, title, copy }: { readonly icon: JSX.Element; readonly title: string; readonly copy: string }): JSX.Element {
  return <header className="mvp-section-title"><span>{icon}</span><div><h2>{title}</h2><p>{copy}</p></div></header>;
}

function DatabasePage({ refreshToken, access, onAccessChange }: {
  readonly refreshToken: number;
  readonly access: DatabaseAccessStatus;
  readonly onAccessChange: (status: DatabaseAccessStatus) => void;
}): JSX.Element {
  const [activeTab, setActiveTab] = useState<DatabaseRecordTab>("saved");
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<readonly DemoSourceSummary[]>([]);
  const [credentials, setCredentials] = useState<readonly DemoCredentialSummary[]>([]);
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>();
  const [revealedSource, setRevealedSource] = useState<DemoSourceReveal>();
  const [revealedCredential, setRevealedCredential] = useState<DemoCredentialReveal>();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function load(search = query): Promise<void> {
    setIsLoading(true);
    setError(undefined);
    setRevealedSource(undefined);
    setRevealedCredential(undefined);
    try {
      const result = await searchDemoSources(search);
      const nextVisibleSources = result.sources.filter(({ kind }) => databaseRecordTab(kind) === activeTab);
      setSources(result.sources);
      setCredentials(result.credentials);
      setSelectedSourceId((current) => nextVisibleSources.some(({ sourceId }) => sourceId === current) ? current : nextVisibleSources[0]?.sourceId);
      setSelectedCredentialId((current) => result.credentials.some(({ credentialId }) => credentialId === current) ? current : result.credentials[0]?.credentialId);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void load("");
  }, [refreshToken]);
  const savedSources = sources.filter(({ kind }) => databaseRecordTab(kind) === "saved");
  const conversationSources = sources.filter(({ kind }) => databaseRecordTab(kind) === "conversation");
  const visibleSources = activeTab === "saved" ? savedSources : conversationSources;
  const selectedSource = visibleSources.find(({ sourceId }) => sourceId === selectedSourceId);
  const selectedCredential = credentials.find(({ credentialId }) => credentialId === selectedCredentialId);
  const linkedCredentials = credentials.filter(({ sourceIds }) => selectedSourceId && sourceIds.includes(selectedSourceId));

  function selectTab(tab: DatabaseRecordTab): void {
    setActiveTab(tab);
    if (tab === "credentials") setSelectedCredentialId(credentials[0]?.credentialId);
    else setSelectedSourceId((tab === "saved" ? savedSources : conversationSources)[0]?.sourceId);
    setRevealedSource(undefined);
    setRevealedCredential(undefined);
  }

  async function revealSource(sourceId = selectedSource?.sourceId): Promise<void> {
    if (!sourceId) return;
    try { setRevealedSource(await revealDemoSource(sourceId)); }
    catch (cause) { setError(messageFrom(cause)); }
  }

  async function revealSelectedCredential(): Promise<void> {
    if (!selectedCredential) return;
    try { setRevealedCredential(await revealCredential(selectedCredential.credentialId)); }
    catch (cause) { setError(messageFrom(cause)); }
  }

  async function lock(): Promise<void> {
    setRevealedSource(undefined);
    setRevealedCredential(undefined);
    onAccessChange(await lockDatabase());
  }

  return <div className="mvp-page">
    <PageHeader title="本地数据库" copy="查看主动保存、对话来源和保密信息之间的关联。" />
    <div className="mvp-toolbar"><div className="mvp-search"><MagnifyingGlass size={19} /><input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(); }} placeholder="搜索内容、Source ID 或凭据 ID" /></div><button className="mvp-secondary" type="button" disabled={isLoading} onClick={() => void load()}>{isLoading ? "查询中" : "查询"}</button><button className="mvp-security-state is-button" type="button" onClick={() => void lock()}><LockOpen size={17} weight="fill" />数据库已解锁 · 点击锁定</button></div>
    {error && <p className="mvp-alert error" role="alert">{error}</p>}
    <section className="mvp-card mvp-database-card">
      <nav className="mvp-database-tabs" aria-label="数据库记录分类">
        <button type="button" className={activeTab === "saved" ? "active" : ""} aria-pressed={activeTab === "saved"} onClick={() => selectTab("saved")}><FloppyDisk size={18} weight={activeTab === "saved" ? "fill" : "regular"} /><span><strong>主动保存</strong><small>用户主动录入的信息</small></span><em>{savedSources.length}</em></button>
        <button type="button" className={activeTab === "credentials" ? "active" : ""} aria-pressed={activeTab === "credentials"} onClick={() => selectTab("credentials")}><Key size={18} weight={activeTab === "credentials" ? "fill" : "regular"} /><span><strong>保密信息</strong><small>独立保存的 Credential</small></span><em>{credentials.length}</em></button>
        <button type="button" className={activeTab === "conversation" ? "active" : ""} aria-pressed={activeTab === "conversation"} onClick={() => selectTab("conversation")}><ChatCircleDots size={18} weight={activeTab === "conversation" ? "fill" : "regular"} /><span><strong>对话记录</strong><small>对话产生的安全来源</small></span><em>{conversationSources.length}</em></button>
      </nav>
      <div className="mvp-banner"><ShieldCheck size={21} weight="duotone" /><div><strong>本地数据已保护</strong><span>{window.brainBuddy ? "Source 与凭据保存在 Electron userData 的本地 SQLite。" : "Source 与凭据保存在 desktop-dev 专用的本地 SQLite。"}</span></div></div>
      {isLoading && !sources.length
        ? <LoadingState label="正在读取本地记录" />
        : activeTab === "credentials"
          ? credentials.length
            ? <div className="mvp-table-wrap"><table><thead><tr><th>类型</th><th>安全视图</th><th>Credential ID</th><th>关联记录</th><th>保存时间</th></tr></thead><tbody>{credentials.map((credential) => <tr key={credential.credentialId} tabIndex={0} aria-selected={credential.credentialId === selectedCredentialId} className={credential.credentialId === selectedCredentialId ? "selected" : ""} onClick={() => { setSelectedCredentialId(credential.credentialId); setRevealedCredential(undefined); setRevealedSource(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedCredentialId(credential.credentialId); setRevealedCredential(undefined); setRevealedSource(undefined); } }}><td>{questionEntityTypeLabel(credential.entityType)}</td><td><code className="mvp-mask-value">{credential.maskedValue}</code></td><td><code>{credential.credentialId}</code></td><td>{credential.sourceIds.length}</td><td>{formatTime(credential.savedAt)}</td></tr>)}</tbody></table></div>
            : <EmptyState icon={<Key size={30} />} title={query.trim() ? "没有匹配的保密信息" : "还没有保密信息"} copy={query.trim() ? "可以按 Credential ID、类型或关联内容查询。" : "保存包含敏感字段的信息后，Credential 会显示在这里。"} />
          : visibleSources.length
            ? <div className="mvp-table-wrap"><table><thead><tr><th>名称</th><th>Source ID</th><th>安全视图</th><th>凭据</th><th>保存时间</th></tr></thead><tbody>{visibleSources.map((source) => <tr key={source.sourceId} tabIndex={0} aria-selected={source.sourceId === selectedSourceId} className={source.sourceId === selectedSourceId ? "selected" : ""} onClick={() => { setSelectedSourceId(source.sourceId); setRevealedSource(undefined); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedSourceId(source.sourceId); setRevealedSource(undefined); } }}><td><strong className="mvp-record-title">{sourceTitle(source)}</strong></td><td><code>{source.sourceId}</code></td><td className="mvp-protected-cell">{source.protectedContent}</td><td>{source.credentialIds.length}</td><td>{formatTime(source.savedAt)}</td></tr>)}</tbody></table></div>
            : <EmptyState icon={activeTab === "saved" ? <FloppyDisk size={30} /> : <ChatCircleDots size={30} />} title={query.trim() ? "当前分类没有匹配记录" : activeTab === "saved" ? "还没有主动保存的信息" : "还没有对话记录"} copy={query.trim() ? "可以调整搜索条件，或切换另一个分类查看。" : activeTab === "saved" ? "回到主页直接保存一条信息，记录会显示在这里。" : "在主页与 lookingfor 对话后，本轮 Source 会显示在这里。"} />}
      {activeTab !== "credentials" && selectedSource && <div className="mvp-source-detail"><div><h2>{sourceTitle(selectedSource)}</h2><dl><dt>记录类型</dt><dd>{sourceKind(selectedSource.kind)}</dd><dt>Source ID</dt><dd><code>{selectedSource.sourceId}</code></dd><dt>AI 安全视图</dt><dd>{selectedSource.protectedContent}</dd><dt>关联凭据</dt><dd>{linkedCredentials.length ? linkedCredentials.map((credential) => <button className="mvp-inline-reference" type="button" key={credential.credentialId} onClick={() => { setActiveTab("credentials"); setSelectedCredentialId(credential.credentialId); setRevealedSource(undefined); }}>[CREDENTIAL:{credential.credentialId}]</button>) : "无"}</dd>{selectedSource.kind === "capture" && <><dt>Memory 索引</dt><dd><code>{manualCaptureMemoryPathForSource(selectedSource.sourceId)}</code></dd></>}</dl></div><div className="mvp-secret-panel"><div><span>用户输入原文</span>{revealedSource?.sourceId === selectedSource.sourceId && <button type="button" aria-label="关闭原文" onClick={() => setRevealedSource(undefined)}><X size={18} /></button>}</div>{revealedSource?.sourceId === selectedSource.sourceId ? <pre>{revealedSource.originalContent}</pre> : <><LockKey size={28} weight="duotone" /><p>点击查看这条 Source 保存的完整输入。</p><button className="mvp-secondary" type="button" onClick={() => void revealSource()}><Eye size={17} />查看原文</button></>}</div></div>}
      {activeTab === "credentials" && selectedCredential && <div className="mvp-credential-detail"><div className="mvp-credential-overview"><h2>{questionEntityTypeLabel(selectedCredential.entityType)}</h2><dl><dt>Credential ID</dt><dd><code>{selectedCredential.credentialId}</code></dd><dt>安全视图</dt><dd><code>{selectedCredential.maskedValue}</code></dd><dt>保存时间</dt><dd>{formatTime(selectedCredential.savedAt)}</dd><dt>关联记录</dt><dd>{selectedCredential.sourceIds.length}</dd></dl></div><div className="mvp-secret-panel"><div><span>保密信息明文</span>{revealedCredential?.credentialId === selectedCredential.credentialId && <button type="button" aria-label="关闭明文" onClick={() => setRevealedCredential(undefined)}><X size={18} /></button>}</div>{revealedCredential?.credentialId === selectedCredential.credentialId ? <pre>{revealedCredential.value}</pre> : <><Key size={28} weight="duotone" /><p>点击后从本地数据库解密这条 Credential。</p><button className="mvp-secondary" type="button" onClick={() => void revealSelectedCredential()}><Eye size={17} />查看明文</button></>}</div><section className="mvp-linked-sources"><h3>关联记录</h3>{selectedCredential.sourceIds.map((sourceId) => { const source = sources.find((candidate) => candidate.sourceId === sourceId); return <div key={sourceId}><div><strong>{source ? sourceTitle(source) : sourceId}</strong><code>{sourceId}</code></div><button className="mvp-secondary" type="button" onClick={() => void revealSource(sourceId)}><Eye size={16} />查看原文</button></div>; })}</section>{revealedSource && selectedCredential.sourceIds.includes(revealedSource.sourceId) && <section className="mvp-linked-source-reveal"><header><div><strong>关联记录原文</strong><code>{revealedSource.sourceId}</code></div><button type="button" aria-label="关闭关联记录原文" onClick={() => setRevealedSource(undefined)}><X size={18} /></button></header><pre>{revealedSource.originalContent}</pre></section>}</div>}
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
        <article className="mvp-memory-editor">{isLoading && !memories.length ? <LoadingState label="正在读取 Memory" /> : selected ? <><header><div><strong>{selected.path}</strong><span>版本 {selected.version.slice(0, 12)}</span></div><time>{formatTime(selected.updatedAt)}</time></header><div className="mvp-info-strip"><ShieldCheck size={18} />这是 AI 可见的本地记忆，不应包含真实 Secret。</div><pre>{selected.content}</pre></> : <EmptyState icon={<FileMd size={30} />} title="还没有 Memory" copy="主动保存信息或在对话中让 Agent 记住内容后，Memory 会显示在这里。" />}</article>
      </div>
    </section>
  </div>;
}

function SettingsPage({ runtimeSettings, access, onRuntimeSettingsChange, onAccessChange }: {
  readonly runtimeSettings: LocalStorageSettings | undefined;
  readonly access: DatabaseAccessStatus;
  readonly onRuntimeSettingsChange: (settings: LocalStorageSettings) => void;
  readonly onAccessChange: (status: DatabaseAccessStatus) => void;
}): JSX.Element {
  const [modelConnection, setModelConnection] = useState<ModelConnectionStatus>();
  const [modelForm, setModelForm] = useState({ apiKey: "", baseUrl: "https://api.deepseek.com", modelId: "deepseek-v4-flash" });
  const [storageForm, setStorageForm] = useState<LocalStorageSettings>({ memoryDirectory: "", databaseDirectory: "", memoryWritePolicy: "auto_apply" });
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [resetOpen, setResetOpen] = useState(false);
  const [resetPhrase, setResetPhrase] = useState("");
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [isSavingModel, setIsSavingModel] = useState(false);
  const [isTestingModel, setIsTestingModel] = useState(false);
  const [isSavingStorage, setIsSavingStorage] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [message, setMessage] = useState<{ readonly tone: "success" | "error"; readonly text: string }>();

  useEffect(() => {
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
      onAccessChange(await getDatabaseAccessStatus());
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
      const status = await configureDatabasePassword(passwords.current, passwords.next);
      onAccessChange(status);
      setPasswords({ current: "", next: "", confirm: "" });
      setMessage({ tone: "success", text: "SQLCipher 数据库密码已更新。" });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
    finally { setIsSavingPassword(false); }
  }

  async function lockNow(): Promise<void> {
    try {
      onAccessChange(await lockDatabase());
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
  }

  async function confirmReset(): Promise<void> {
    if (resetPhrase !== "清除数据库") return;
    setIsResetting(true);
    setMessage(undefined);
    try {
      const result = await resetDatabase();
      setResetOpen(false);
      setResetPhrase("");
      setMessage({ tone: "success", text: `数据库已重置：清除 ${result.deletedSourceCount} 条 Source 和 ${result.deletedCredentialCount} 条 Credential。Memory 与调试记录未受影响。` });
    } catch (cause) { setMessage({ tone: "error", text: messageFrom(cause) }); }
    finally { setIsResetting(false); }
  }

  return <div className="mvp-page">
    <PageHeader title="设置" copy="管理本地存储访问、模型连接和隐私边界。" />
    {message && <p className={`mvp-alert ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.text}</p>}
    <div className="mvp-settings-grid">
      <section className="mvp-card mvp-setting-card mvp-storage-settings"><div className="mvp-setting-icon"><Folder size={22} weight="duotone" /></div><div><h2>本地存储位置</h2><p>分别配置受控 Markdown 根目录和 SQLite 数据库目录；必须填写绝对路径。</p><form className="mvp-storage-form" onSubmit={(event) => void saveStorageSettings(event)}><label>本地记忆目录<input value={storageForm.memoryDirectory} required onChange={(event) => setStorageForm({ ...storageForm, memoryDirectory: event.target.value })} placeholder="例如 /Users/you/lookingfor/memories" /></label><label>数据库文件目录<input value={storageForm.databaseDirectory} required onChange={(event) => setStorageForm({ ...storageForm, databaseDirectory: event.target.value })} placeholder="例如 /Users/you/lookingfor/database" /></label><div className="mvp-form-actions"><button className="mvp-primary" type="submit" disabled={isSavingStorage || !storageForm.memoryDirectory.trim() || !storageForm.databaseDirectory.trim()}>{isSavingStorage ? "切换中" : "保存存储位置"}</button></div></form><p className="mvp-field-note">保存时会创建不存在的目录并立即切换；两个目录必须独立、可读写，且不会自动搬移旧目录中的数据。</p></div></section>
      <section className="mvp-card mvp-setting-card mvp-model-settings"><div className="mvp-setting-icon"><Key size={22} weight="duotone" /></div><div><div className="mvp-setting-heading"><div><h2>AI 连接</h2><p>连接信息由本地后端加密保存。API 地址可指向 DeepSeek 或兼容的中转服务。</p></div><span className={`mvp-status-pill ${modelConnection?.configured ? "unlocked" : "unset"}`}>{modelConnection?.configured ? "已配置" : "尚未配置"}</span></div><form className="mvp-model-form" onSubmit={(event) => void saveModelConnection(event)}><label className="mvp-model-url">API 地址<input type="url" value={modelForm.baseUrl} required maxLength={2000} onChange={(event) => setModelForm({ ...modelForm, baseUrl: event.target.value })} placeholder="https://api.deepseek.com" /></label><label>模型名称<input value={modelForm.modelId} required maxLength={100} onChange={(event) => setModelForm({ ...modelForm, modelId: event.target.value })} placeholder="deepseek-v4-flash" /></label><label className="mvp-model-key">API Key<input type="password" autoComplete="new-password" minLength={8} maxLength={512} required value={modelForm.apiKey} onChange={(event) => setModelForm({ ...modelForm, apiKey: event.target.value })} placeholder={modelConnection?.maskedApiKey ? `当前 ${modelConnection.maskedApiKey}，输入新 Key 可替换` : "输入 API Key"} /></label><div className="mvp-form-actions"><button className="mvp-secondary" type="button" disabled={isTestingModel || isSavingModel || !modelForm.baseUrl.trim() || !modelForm.modelId.trim() || (modelForm.apiKey.trim().length > 0 && modelForm.apiKey.trim().length < 8) || (!modelConnection?.configured && modelForm.apiKey.trim().length < 8)} onClick={() => void checkModelConnection()}><CheckCircle size={16} />{isTestingModel ? "测试中" : "测试连接"}</button><button className="mvp-primary" type="submit" disabled={isSavingModel || isTestingModel || modelForm.apiKey.trim().length < 8 || !modelForm.baseUrl.trim() || !modelForm.modelId.trim()}>{isSavingModel ? "保存中" : modelConnection?.configured ? "更新连接" : "保存连接"}</button></div></form><p className="mvp-field-note">测试连接会发送内容为“1”的请求并将输出限制为 1 token；Key 留空时使用已保存的连接。默认地址为 DeepSeek API，默认模型为 deepseek-v4-flash。</p></div></section>
      <section className="mvp-card mvp-setting-card mvp-password-settings"><div className="mvp-setting-icon"><LockKey size={22} weight="duotone" /></div><div><div className="mvp-setting-heading"><div><h2>SQLCipher 数据库密码</h2><p>这是数据库文件的实际加密密码；兼容程序获得密码后可直接打开数据库。</p></div><span className="mvp-status-pill unlocked">已加密 · 已解锁</span></div><form className="mvp-password-form" onSubmit={(event) => void savePassword(event)}><label>当前密码<input type="password" autoComplete="current-password" required value={passwords.current} onChange={(event) => setPasswords({ ...passwords, current: event.target.value })} /></label><label>新密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={passwords.next} onChange={(event) => setPasswords({ ...passwords, next: event.target.value })} placeholder="至少 8 个字符" /></label><label>确认新密码<input type="password" autoComplete="new-password" minLength={8} maxLength={128} required value={passwords.confirm} onChange={(event) => setPasswords({ ...passwords, confirm: event.target.value })} /></label><div className="mvp-form-actions"><button className="mvp-secondary" type="button" onClick={() => void lockNow()}><LockKey size={16} />立即锁定</button><button className="mvp-primary" type="submit" disabled={isSavingPassword || passwords.next.length < 8 || passwords.confirm.length < 8}>{isSavingPassword ? "保存中" : "更新数据库密码"}</button></div></form><p className="mvp-field-note">改密会重新加密整个数据库。忘记密码后无法恢复 Source、Credential 或数据库内的 AI 连接信息。</p></div></section>
      <section className="mvp-card mvp-setting-card mvp-security-settings"><div className="mvp-setting-icon"><ShieldCheck size={22} weight="duotone" /></div><div><h2>隐私与安全</h2><p>这些规则由运行时强制执行，不依赖模型自行遵守。</p><div className="mvp-policy-row mvp-policy-control"><div><strong>Memory 写入方式</strong><span>默认允许 Agent 自动写入，每次修改仍会保存 Revision。</span></div><select aria-label="Memory 写入方式" value={runtimeSettings?.memoryWritePolicy ?? "auto_apply"} disabled={!runtimeSettings} onChange={(event) => void changeMemoryWritePolicy(event.target.value as MemoryWritePolicy)}><option value="require_approval">每次需要批准</option><option value="auto_apply">允许 Agent 自动写入</option></select></div><div className="mvp-policy-row"><div><strong>凭据明文不发送给 AI</strong><span>Agent 只接收 Credential ID 与 Source 关联，不接收明文或掩码。</span></div><CheckCircle size={22} weight="fill" /></div><div className="mvp-policy-row"><div><strong>受控 Memory 根目录</strong><span>路径逃逸和符号链接会被拒绝。</span></div><CheckCircle size={22} weight="fill" /></div></div></section>
      <section className="mvp-card mvp-setting-card mvp-danger-settings"><div className="mvp-setting-icon"><Warning size={22} weight="duotone" /></div><div><h2>危险操作</h2><p>重置只清除加密数据库中的 Source、Credential 及其关联；不会删除 Memory 或 Agent 调试记录。</p>{!resetOpen ? <div className="mvp-danger-row"><div><strong>重置数据库</strong><span>此操作不可撤销，执行前会要求再次确认。</span></div><button className="mvp-danger-button" type="button" onClick={() => { setResetOpen(true); setMessage(undefined); }}><Trash size={16} />重置数据库</button></div> : <div className="mvp-reset-confirm" role="group" aria-labelledby="reset-database-title"><div><strong id="reset-database-title">确认永久清除数据库？</strong><span>请输入“清除数据库”完成二次确认。</span></div><label>确认文本<input value={resetPhrase} autoFocus onChange={(event) => setResetPhrase(event.target.value)} placeholder="清除数据库" /></label><div className="mvp-form-actions"><button className="mvp-secondary" type="button" disabled={isResetting} onClick={() => { setResetOpen(false); setResetPhrase(""); }}>取消</button><button className="mvp-danger-button" type="button" disabled={isResetting || resetPhrase !== "清除数据库"} onClick={() => void confirmReset()}>{isResetting ? "正在清除" : "确认清除数据库"}</button></div></div>}</div></section>
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

export function sourceTitle(source: Pick<DemoSourceSummary, "protectedContent">): string {
  return source.protectedContent.split(/\r?\n/u).find((line) => line.trim())?.trim() || "未命名记录";
}

export function manualCaptureMemoryPathForSource(sourceId: string): string {
  return `memories/manual-captures/${sourceId.replace(/^SOURCE_/u, "")}.md`;
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
    project: "项目",
    custom: "自定义信息"
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
  if (message.includes("LOCAL_STORAGE_PATH_INVALID")) return "存储目录包含当前系统不支持的字符。";
  if (message.includes("LOCAL_STORAGE_PATH_TOO_BROAD")) return "不能直接使用磁盘根目录或用户主目录，请选择专用子目录。";
  if (message.includes("LOCAL_STORAGE_PATHS_OVERLAP")) return "Memory 与数据库目录必须相互独立，不能相同或互相嵌套。";
  if (message.includes("LOCAL_STORAGE_PATH_SYMLINK")) return "存储目录不能是符号链接，请选择真实目录。";
  if (message.includes("LOCAL_STORAGE_PATH_NOT_DIRECTORY")) return "所选存储路径已被普通文件占用。";
  if (message.includes("LOCAL_STORAGE_PATH_NOT_ACCESSIBLE")) return "所选目录不可读写，请检查权限或选择其他目录。";
  if (message.includes("LOCAL_STORAGE_CONFIG_INVALID")) return "本地存储配置文件无效，请检查后重试。";
  if (message.includes("LOCAL_STORAGE_CONFIG_BLOCKED")) return "本地存储正在被 AI Run 使用，请先等待完成或取消 Run。";
  return message || "操作失败，请稍后重试。";
}
