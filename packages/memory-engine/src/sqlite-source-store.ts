import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import Database from "better-sqlite3-multiple-ciphers";
import type { CipherDatabase } from "better-sqlite3-multiple-ciphers";
import type {
  DatabaseAccessStatus,
  CredentialDraft,
  DemoCredentialReveal,
  DemoCredentialSummary,
  DatabaseResetResult,
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
  readonly now?: () => Date;
  readonly sourceIdFactory?: () => string;
}

export class SqliteSourceStore {
  readonly #databasePath: string;
  #database: CipherDatabase | undefined;
  readonly #now: () => Date;
  readonly #sourceIdFactory: () => string;

  constructor(options: SqliteSourceStoreOptions) {
    this.#databasePath = options.databasePath;
    this.#now = options.now ?? (() => new Date());
    this.#sourceIdFactory = options.sourceIdFactory ?? (() => `SOURCE_${randomUUID()}`);
  }

  status(): DatabaseAccessStatus {
    return { passwordConfigured: databaseExists(this.#databasePath), unlocked: Boolean(this.#database) };
  }

  configure(currentPassword: string | undefined, newPassword: string): DatabaseAccessStatus {
    assertPasswordStrength(newPassword);
    const configured = databaseExists(this.#databasePath);
    if (configured && !currentPassword) throw new Error("DATABASE_PASSWORD_INVALID: Current database password is required");
    if (!configured) {
      this.lock();
      const database = openDatabase(this.#databasePath, newPassword, false);
      this.#migrate(database);
      this.#database = database;
    } else {
      // Validate first so a mistyped current password does not lock an already
      // open application. Rekeying itself needs an exclusive connection.
      const validationDatabase = openDatabase(this.#databasePath, currentPassword!, true);
      validationDatabase.close();
      this.lock();
      const database = openDatabase(this.#databasePath, currentPassword!, true);
      try {
        database.pragma(`rekey=${quoteSqlCipherPassphrase(newPassword)}`);
        database.prepare("SELECT count(*) AS count FROM sqlite_schema").get();
        this.#database = database;
      } catch (error) {
        database.close();
        throw normalizeDatabasePasswordError(error);
      }
    }
    restrictDatabaseFiles(this.#databasePath);
    return this.status();
  }

  unlock(password: string): DatabaseAccessStatus {
    if (!databaseExists(this.#databasePath)) throw new Error("DATABASE_PASSWORD_NOT_CONFIGURED: Create the encrypted database first");
    this.lock();
    this.#database = openDatabase(this.#databasePath, password, true);
    this.#migrate(this.#database);
    restrictDatabaseFiles(this.#databasePath);
    return this.status();
  }

  lock(): DatabaseAccessStatus {
    this.#database?.close();
    this.#database = undefined;
    return this.status();
  }

  assertUnlocked(): void {
    if (!this.#database) throw new Error("DATABASE_LOCKED: Unlock the encrypted local database first");
  }

  save(plan: ProtectionPlan, originalContent: string, kind: SourceSubmissionKind = "capture"): DemoSaveReceipt {
    const database = this.#requireDatabase();
    const initialPreview = toProtectionPreview(plan);
    if (!initialPreview.readyToSave) throw new Error("Protection checks must pass before saving");

    const sourceId = this.#sourceIdFactory();
    const savedAt = this.#now().toISOString();
    database.exec("BEGIN IMMEDIATE");
    try {
      const resolvedCredentials = plan.credentialDrafts.map((draft) => this.#resolveCredential(draft, savedAt));
      const protectedContent = appendSourceReference(
        replaceCredentialReferences(plan.protectedContent, plan.credentialDrafts, resolvedCredentials),
        sourceId
      );
      const credentialIds = [...new Set(findCredentialReferences(protectedContent).map(({ credentialId }) => credentialId))];
      const unknownCredentialId = credentialIds.find((credentialId) => !this.#credentialExists(credentialId));
      if (unknownCredentialId) throw new Error(`Credential reference does not exist: ${unknownCredentialId}`);
      database.prepare(`
        INSERT INTO sources (
          source_id, submission_kind, protected_content, original_content, saved_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(sourceId, kind, protectedContent, originalContent, savedAt);

      for (const credentialId of credentialIds) {
        database.prepare(`
          INSERT OR IGNORE INTO credential_sources (credential_id, source_id) VALUES (?, ?)
        `).run(credentialId, sourceId);
      }
      database.exec("COMMIT");

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
      database.exec("ROLLBACK");
      throw error;
    }
  }

  search(query: string): readonly DemoSourceSummary[] {
    return this.searchOffline(query).sources;
  }

  searchOffline(query: string, excludeSourceId?: string): DemoOfflineSearchResult {
    const database = this.#requireDatabase();
    const pattern = `%${escapeLike(query.trim().toLocaleLowerCase())}%`;
    const sources = database.prepare(`
      SELECT source_id, submission_kind, protected_content, saved_at
      FROM sources
      WHERE (? = '' OR lower(source_id) LIKE ? ESCAPE '\\' OR lower(submission_kind) LIKE ? ESCAPE '\\'
        OR lower(protected_content) LIKE ? ESCAPE '\\')
        AND (? IS NULL OR source_id <> ?)
      ORDER BY saved_at DESC
    `).all(query.trim(), pattern, pattern, pattern, excludeSourceId ?? null, excludeSourceId ?? null)
      .map((row: unknown) => this.#sourceSummary(row as Record<string, unknown>));

    const credentials = database.prepare(`
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
      .map((row: unknown) => this.#credentialSummary(row as Record<string, unknown>));

    return { sources, credentials };
  }

  revealSource(sourceId: string): DemoSourceReveal {
    const row = this.#requireDatabase().prepare(`
      SELECT source_id, submission_kind, original_content, saved_at
      FROM sources WHERE source_id = ?
    `).get(sourceId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Source record not found");
    return {
      sourceId: String(row.source_id),
      kind: asSourceKind(row.submission_kind),
      originalContent: String(row.original_content),
      savedAt: String(row.saved_at)
    };
  }

  revealCredential(credentialId: string): DemoCredentialReveal {
    const database = this.#requireDatabase();
    const row = database.prepare(`
      SELECT credential_id, entity_type, secret, saved_at
      FROM credentials WHERE credential_id = ?
    `).get(credentialId) as Record<string, unknown> | undefined;
    if (!row) throw new Error("Credential record not found");
    const sourceRows = database.prepare(`
      SELECT source_id FROM credential_sources WHERE credential_id = ? ORDER BY source_id
    `).all(credentialId) as Array<{ source_id: unknown }>;
    return {
      credentialId: String(row.credential_id),
      entityType: row.entity_type as EntityType,
      value: String(row.secret),
      sourceIds: sourceRows.map(({ source_id }) => String(source_id)),
      savedAt: String(row.saved_at)
    };
  }

  hasSource(sourceId: string): boolean {
    return Boolean(this.#requireDatabase().prepare("SELECT 1 FROM sources WHERE source_id = ?").get(sourceId));
  }

  hasCredential(credentialId: string): boolean {
    return this.#credentialExists(credentialId);
  }

  reset(): DatabaseResetResult {
    const database = this.#requireDatabase();
    const deletedSourceCount = Number((database.prepare("SELECT count(*) AS count FROM sources").get() as { count: number }).count);
    const deletedCredentialCount = Number((database.prepare("SELECT count(*) AS count FROM credentials").get() as { count: number }).count);
    database.exec("BEGIN IMMEDIATE");
    try {
      database.exec("DELETE FROM sources; DELETE FROM credentials; COMMIT");
      return { deletedSourceCount, deletedCredentialCount };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.lock();
  }

  getSetting(key: string): string | undefined {
    const row = this.#requireDatabase().prepare("SELECT setting_value FROM settings WHERE setting_key = ?").get(key) as { setting_value?: unknown } | undefined;
    return row ? String(row.setting_value) : undefined;
  }

  setSetting(key: string, value: string): void {
    this.#requireDatabase().prepare(`
      INSERT INTO settings (setting_key, setting_value) VALUES (?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value
    `).run(key, value);
  }

  #resolveCredential(draft: CredentialDraft, savedAt: string): CredentialDraft {
    const database = this.#requireDatabase();
    const secretHash = createHash("sha256").update(draft.secret).digest("hex");
    const existingByHash = database.prepare(`
      SELECT credential_id FROM credentials WHERE secret_hash = ?
    `).get(secretHash) as { credential_id?: unknown } | undefined;
    if (existingByHash) {
      const credentialId = String(existingByHash.credential_id);
      return { ...draft, credentialId, ref: `[CREDENTIAL:${credentialId}]` };
    }

    const existingById = database.prepare(`
      SELECT secret_hash FROM credentials WHERE credential_id = ?
    `).get(draft.credentialId) as { secret_hash?: unknown } | undefined;
    if (existingById && String(existingById.secret_hash) !== secretHash) {
      throw new Error("A credential id cannot identify different secrets");
    }
    if (!existingById) {
      database.prepare(`
        INSERT INTO credentials (
          credential_id, entity_type, masked_value, secret_hash, secret, saved_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        draft.credentialId,
        draft.entityType,
        draft.maskedValue,
        secretHash,
        draft.secret,
        savedAt
      );
    }
    return draft;
  }

  #credentialExists(credentialId: string): boolean {
    return Boolean(this.#requireDatabase().prepare("SELECT 1 FROM credentials WHERE credential_id = ?").get(credentialId));
  }

  #sourceSummary(row: Record<string, unknown>): DemoSourceSummary {
    const sourceId = String(row.source_id);
    const credentialRows = this.#requireDatabase().prepare(`
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
    const sourceRows = this.#requireDatabase().prepare(`
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

  #migrate(database: CipherDatabase): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY,
        submission_kind TEXT NOT NULL CHECK (submission_kind IN ('capture', 'local_search', 'conversation')),
        protected_content TEXT NOT NULL,
        original_content TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credentials (
        credential_id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        masked_value TEXT NOT NULL,
        secret_hash TEXT NOT NULL UNIQUE,
        secret TEXT NOT NULL,
        saved_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credential_sources (
        credential_id TEXT NOT NULL REFERENCES credentials(credential_id) ON DELETE CASCADE,
        source_id TEXT NOT NULL REFERENCES sources(source_id) ON DELETE CASCADE,
        PRIMARY KEY (credential_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL
      );
    `);
    database.exec(`
      CREATE INDEX IF NOT EXISTS source_saved_at ON sources(saved_at DESC);
      CREATE INDEX IF NOT EXISTS credential_source_source ON credential_sources(source_id);
      PRAGMA user_version = 1;
    `);
  }

  #requireDatabase(): CipherDatabase {
    if (!this.#database) throw new Error("DATABASE_LOCKED: Unlock the encrypted local database first");
    return this.#database;
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

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function openDatabase(path: string, password: string, fileMustExist: boolean): CipherDatabase {
  const database = new Database(path, { fileMustExist });
  try {
    database.pragma("cipher='sqlcipher'");
    database.pragma("legacy=4");
    database.pragma(`key=${quoteSqlCipherPassphrase(password)}`);
    database.prepare("SELECT count(*) AS count FROM sqlite_schema").get();
    database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    return database;
  } catch (error) {
    database.close();
    throw normalizeDatabasePasswordError(error);
  }
}

function quoteSqlCipherPassphrase(password: string): string {
  return `'${password.replaceAll("'", "''")}'`;
}

function assertPasswordStrength(password: string): void {
  if (password.length < 8 || password.length > 128) {
    throw new Error("DATABASE_PASSWORD_WEAK: Database password must contain 8 to 128 characters");
  }
}

function normalizeDatabasePasswordError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/not a database|file is encrypted|cipher|malformed/iu.test(message)) {
    return new Error("DATABASE_PASSWORD_INVALID: Database password is incorrect");
  }
  return error instanceof Error ? error : new Error(message);
}

function databaseExists(path: string): boolean {
  return existsSync(path) && statSync(path).size > 0;
}

function asSourceKind(value: unknown): SourceSubmissionKind {
  if (value === "capture" || value === "local_search" || value === "conversation") return value;
  throw new Error("Stored source kind is invalid");
}

function restrictDatabaseFiles(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
