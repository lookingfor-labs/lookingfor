import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  CredentialDraft,
  DemoCredentialSummary,
  DemoOfflineSearchResult,
  DemoSaveReceipt,
  DemoSourceReveal,
  DemoSourceSummary,
  EntityType,
  ProtectionPlan,
  SourceSubmissionKind
} from "@brainbuddy/domain";
import { findCredentialReferences, toProtectionPreview } from "@brainbuddy/privacy-engine";

interface SqliteSourceStoreOptions {
  readonly databasePath: string;
  readonly encryptionKey: Uint8Array;
  readonly now?: () => Date;
  readonly sourceIdFactory?: () => string;
}

interface EncryptedValue {
  readonly ciphertext: string;
  readonly iv: string;
  readonly tag: string;
}

export class SqliteSourceStore {
  readonly #database: DatabaseSync;
  readonly #key: Buffer;
  readonly #now: () => Date;
  readonly #sourceIdFactory: () => string;

  constructor(options: SqliteSourceStoreOptions) {
    if (options.encryptionKey.byteLength !== 32) throw new Error("The database encryption key must contain 32 bytes");
    this.#database = new DatabaseSync(options.databasePath);
    this.#key = Buffer.from(options.encryptionKey);
    this.#now = options.now ?? (() => new Date());
    this.#sourceIdFactory = options.sourceIdFactory ?? (() => `SOURCE_${randomUUID()}`);
    this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    this.#migrate();
  }

  save(plan: ProtectionPlan, originalContent: string, kind: SourceSubmissionKind = "capture"): DemoSaveReceipt {
    const initialPreview = toProtectionPreview(plan);
    if (!initialPreview.readyToSave) throw new Error("Protection checks must pass before saving");

    const sourceId = this.#sourceIdFactory();
    const savedAt = this.#now().toISOString();
    const encryptedSource = encrypt(originalContent, this.#key);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const resolvedCredentials = plan.credentialDrafts.map((draft) => this.#resolveCredential(draft, savedAt));
      const protectedContent = appendSourceReference(
        replaceCredentialReferences(plan.protectedContent, plan.credentialDrafts, resolvedCredentials),
        sourceId
      );
      const credentialIds = [...new Set(findCredentialReferences(protectedContent).map(({ credentialId }) => credentialId))];
      const unknownCredentialId = credentialIds.find((credentialId) => !this.#credentialExists(credentialId));
      if (unknownCredentialId) throw new Error(`Credential reference does not exist: ${unknownCredentialId}`);
      this.#database.prepare(`
        INSERT INTO sources (
          source_id, submission_kind, protected_content, original_ciphertext, original_iv, original_tag, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(sourceId, kind, protectedContent, encryptedSource.ciphertext, encryptedSource.iv, encryptedSource.tag, savedAt);

      for (const credentialId of credentialIds) {
        this.#database.prepare(`
          INSERT OR IGNORE INTO credential_sources (credential_id, source_id) VALUES (?, ?)
        `).run(credentialId, sourceId);
      }
      this.#database.exec("COMMIT");

      const normalizedPlan: ProtectionPlan = {
        ...plan,
        protectedContent,
        credentialDrafts: resolvedCredentials
      };
      return {
        sourceId,
        kind,
        credentialIds,
        savedAt,
        storage: "sqlite",
        preview: toProtectionPreview(normalizedPlan)
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string): readonly DemoSourceSummary[] {
    return this.searchOffline(query).sources;
  }

  searchOffline(query: string, excludeSourceId?: string): DemoOfflineSearchResult {
    const pattern = `%${escapeLike(query.trim().toLocaleLowerCase())}%`;
    const sources = this.#database.prepare(`
      SELECT source_id, submission_kind, protected_content, saved_at
      FROM sources
      WHERE (? = '' OR lower(source_id) LIKE ? ESCAPE '\\' OR lower(submission_kind) LIKE ? ESCAPE '\\'
        OR lower(protected_content) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR source_id <> ?)
      ORDER BY saved_at DESC
    `).all(query.trim(), pattern, pattern, pattern, excludeSourceId ?? null, excludeSourceId ?? null)
      .map((row) => this.#sourceSummary(row as Record<string, unknown>));

    const credentials = this.#database.prepare(`
      SELECT credential_id, entity_type, masked_value, saved_at
      FROM credentials AS credential
      WHERE ? = '' OR lower(credential_id) LIKE ? ESCAPE '\\' OR lower(entity_type) LIKE ? ESCAPE '\\'
        OR lower(masked_value) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM credential_sources AS link
          JOIN sources AS source ON source.source_id = link.source_id
          WHERE link.credential_id = credential.credential_id
            AND (lower(source.source_id) LIKE ? ESCAPE '\\'
              OR lower(source.submission_kind) LIKE ? ESCAPE '\\'
              OR lower(source.protected_content) LIKE ? ESCAPE '\\')
        )
      ORDER BY saved_at DESC
    `).all(query.trim(), pattern, pattern, pattern, pattern, pattern, pattern)
      .map((row) => this.#credentialSummary(row as Record<string, unknown>));

    return { sources, credentials };
  }

  revealSource(sourceId: string): DemoSourceReveal {
    const row = this.#database.prepare(`
      SELECT source_id, submission_kind, original_ciphertext, original_iv, original_tag, saved_at
      FROM sources WHERE source_id = ?
    `).get(sourceId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Source record not found");
    return {
      sourceId: String(row.source_id),
      kind: asSourceKind(row.submission_kind),
      originalContent: decrypt({
        ciphertext: String(row.original_ciphertext),
        iv: String(row.original_iv),
        tag: String(row.original_tag)
      }, this.#key),
      savedAt: String(row.saved_at)
    };
  }

  close(): void {
    this.#database.close();
  }

  #resolveCredential(draft: CredentialDraft, savedAt: string): CredentialDraft {
    const secretHash = createHmac("sha256", this.#key).update(draft.secret).digest("hex");
    const existingByHash = this.#database.prepare(`
      SELECT credential_id FROM credentials WHERE secret_hash = ?
    `).get(secretHash) as { credential_id?: unknown } | undefined;
    if (existingByHash) {
      const credentialId = String(existingByHash.credential_id);
      return { ...draft, credentialId, ref: `[CREDENTIAL:${credentialId}]` };
    }

    const existingById = this.#database.prepare(`
      SELECT secret_hash FROM credentials WHERE credential_id = ?
    `).get(draft.credentialId) as { secret_hash?: unknown } | undefined;
    if (existingById && String(existingById.secret_hash) !== secretHash) {
      throw new Error("A credential id cannot identify different secrets");
    }
    if (!existingById) {
      const encrypted = encrypt(draft.secret, this.#key);
      this.#database.prepare(`
        INSERT INTO credentials (
          credential_id, entity_type, masked_value, secret_hash, secret_ciphertext, secret_iv, secret_tag, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        draft.credentialId,
        draft.entityType,
        draft.maskedValue,
        secretHash,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.tag,
        savedAt
      );
    }
    return draft;
  }

  #credentialExists(credentialId: string): boolean {
    return Boolean(this.#database.prepare("SELECT 1 FROM credentials WHERE credential_id = ?").get(credentialId));
  }

  #sourceSummary(row: Record<string, unknown>): DemoSourceSummary {
    const sourceId = String(row.source_id);
    const credentialRows = this.#database.prepare(`
      SELECT credential_id FROM credential_sources WHERE source_id = ? ORDER BY credential_id
    `).all(sourceId) as Array<{ credential_id: unknown }>;
    return {
      sourceId,
      kind: asSourceKind(row.submission_kind),
      protectedContent: String(row.protected_content),
      credentialIds: credentialRows.map((credential) => String(credential.credential_id)),
      savedAt: String(row.saved_at)
    };
  }

  #credentialSummary(row: Record<string, unknown>): DemoCredentialSummary {
    const credentialId = String(row.credential_id);
    const sourceRows = this.#database.prepare(`
      SELECT source_id FROM credential_sources WHERE credential_id = ? ORDER BY source_id
    `).all(credentialId) as Array<{ source_id: unknown }>;
    return {
      credentialId,
      entityType: row.entity_type as EntityType,
      maskedValue: String(row.masked_value),
      sourceIds: sourceRows.map((source) => String(source.source_id)),
      savedAt: String(row.saved_at)
    };
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY,
        submission_kind TEXT NOT NULL CHECK (submission_kind IN ('capture', 'local_search', 'conversation')),
        protected_content TEXT NOT NULL,
        original_ciphertext TEXT NOT NULL,
        original_iv TEXT NOT NULL,
        original_tag TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        credential_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        masked_value TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        secret_ciphertext TEXT NOT NULL,
        secret_iv TEXT NOT NULL,
        secret_tag TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_sources (
        credential_id TEXT NOT NULL REFERENCES credentials(credential_id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        PRIMARY KEY (credential_id, source_id)
      );
    `);
    this.#migrateLegacySourceKinds();
    this.#database.exec(`
      CREATE INDEX IF NOT EXISTS source_saved_at ON sources(saved_at DESC);
      CREATE INDEX IF NOT EXISTS credential_source_source ON credential_sources(source_id);
    `);
  }

  #migrateLegacySourceKinds(): void {
    const table = this.#database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sources'")
      .get() as { sql?: unknown } | undefined;
    if (!String(table?.sql ?? "").includes("'write'")) return;
    this.#database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
    try {
      this.#database.exec(`
        ALTER TABLE credential_sources RENAME TO credential_sources_legacy;
        ALTER TABLE sources RENAME TO sources_legacy;
        CREATE TABLE sources (
          source_id TEXT PRIMARY KEY,
          submission_kind TEXT NOT NULL CHECK (submission_kind IN ('capture', 'local_search', 'conversation')),
          protected_content TEXT NOT NULL,
          original_ciphertext TEXT NOT NULL,
          original_iv TEXT NOT NULL,
          original_tag TEXT NOT NULL,
          saved_at TEXT NOT NULL
        );
        INSERT INTO sources
        SELECT source_id,
          CASE submission_kind WHEN 'write' THEN 'capture' WHEN 'query' THEN 'local_search' ELSE submission_kind END,
          protected_content, original_ciphertext, original_iv, original_tag, saved_at
        FROM sources_legacy;
        CREATE TABLE credential_sources (
          credential_id TEXT NOT NULL REFERENCES credentials(credential_id) ON DELETE CASCADE,
          source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
          PRIMARY KEY (credential_id, source_id)
        );
        INSERT INTO credential_sources SELECT credential_id, source_id FROM credential_sources_legacy;
        DROP TABLE credential_sources_legacy;
        DROP TABLE sources_legacy;
        COMMIT;
      `);
    } catch (error) {
      this.#database.exec("ROLLBACK;");
      throw error;
    } finally {
      this.#database.exec("PRAGMA foreign_keys = ON;");
    }
  }
}

function appendSourceReference(content: string, sourceId: string): string {
  return `${content}\n\n来源：[SOURCE:${sourceId}]`;
}

function replaceCredentialReferences(
  content: string,
  original: readonly CredentialDraft[],
  resolved: readonly CredentialDraft[]
): string {
  return original.reduce((current, credential, index) => {
    const next = resolved[index];
    return next ? current.replaceAll(credential.ref, next.ref) : current;
  }, content);
}

function encrypt(plaintext: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}

function decrypt(value: EncryptedValue, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(value.iv, "base64"));
  decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function asSourceKind(value: unknown): SourceSubmissionKind {
  if (value === "capture" || value === "local_search" || value === "conversation") return value;
  throw new Error("Stored source kind is invalid");
}
