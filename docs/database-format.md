# lookingfor encrypted database format

lookingfor stores Sources, Credentials, their provenance links, and the AI connection in `lookingfor.sqlite`. The file uses a SQLCipher 4-compatible database format so authorized programs can query it with ordinary SQL after the user supplies the database password.

Memory remains a separate, AI-readable Markdown directory. It is not part of the encrypted database.

## Open the database

Use a SQLCipher-compatible client and apply these settings before the first schema query:

```sql
PRAGMA cipher = 'sqlcipher';
PRAGMA legacy = 4;
PRAGMA key = 'your database password';
SELECT count(*) FROM sqlite_schema;
```

The final query succeeds only when the password and cipher settings are correct. A standard SQLite client without SQLCipher support cannot open the file.

Applications must obtain the password directly from the user or their chosen secret manager. Do not read passwords from command-line arguments, commit them to source control, or store them beside the database.

## Schema version

`PRAGMA user_version` is currently `1`. Consumers should reject newer versions they do not understand instead of guessing at column meanings.

## Schema v1

### `sources`

| Column | Meaning |
| --- | --- |
| `source_id` | Stable Source identifier and primary key |
| `submission_kind` | `capture`, `local_search`, or `conversation` |
| `protected_content` | AI-safe representation, which may include Credential references |
| `original_content` | Complete user-submitted text |
| `saved_at` | ISO 8601 timestamp |

### `credentials`

| Column | Meaning |
| --- | --- |
| `credential_id` | UUID primary key used by `[CREDENTIAL:<id>]` references |
| `entity_type` | Detected or user-selected information type |
| `masked_value` | Human-readable masked preview |
| `secret_hash` | SHA-256 digest used only for deduplication inside the encrypted database |
| `secret` | Credential plaintext, protected by SQLCipher at rest |
| `saved_at` | ISO 8601 timestamp |

### `credential_sources`

Many-to-many provenance links between Credentials and Sources. Its composite primary key is `(credential_id, source_id)`.

### `settings`

| Column | Meaning |
| --- | --- |
| `setting_key` | Stable setting name |
| `setting_value` | UTF-8 setting value |

The `model.connection` setting is JSON with `version`, `provider`, `baseUrl`, `modelId`, and `apiKey` fields. It is plaintext after the database is unlocked and encrypted as part of the SQLCipher file at rest.

## Agent access rule

Database compatibility does not grant the built-in Agent direct SQL access. lookingfor exposes only protected Source projections and opaque Credential references through the Agent's controlled record interface. External programs receive full access only when the user deliberately gives them the database password.
