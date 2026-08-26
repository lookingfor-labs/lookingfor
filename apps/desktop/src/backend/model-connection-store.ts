import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { ModelConnectionStatus } from "@brainbuddy/domain";

export interface ModelConnection {
  readonly apiKey: string;
  readonly modelId: string;
}

export function modelConnectionFromEnvironment(environment: NodeJS.ProcessEnv): ModelConnection | undefined {
  const apiKey = environment.SECRET_DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    modelId: environment.SECRET_DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL_ID
  };
}

interface StoredModelConnection {
  readonly version: 1;
  readonly provider: "deepseek";
  readonly modelId: string;
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

const DEFAULT_MODEL_ID = "deepseek-chat";
const AAD = Buffer.from("brainbuddy:model-connection:v1", "utf8");

export class ModelConnectionStore {
  readonly #metadataPath: string;
  readonly #encryptionKey: Buffer;

  constructor(options: {
    readonly metadataPath: string;
    readonly encryptionKey: Buffer;
    readonly initialConnection?: ModelConnection;
  }) {
    this.#metadataPath = options.metadataPath;
    this.#encryptionKey = options.encryptionKey;
    if (!existsSync(this.#metadataPath) && options.initialConnection?.apiKey.trim()) {
      this.configure(options.initialConnection.apiKey, options.initialConnection.modelId);
    }
    if (existsSync(this.#metadataPath)) chmodSync(this.#metadataPath, 0o600);
  }

  status(): ModelConnectionStatus {
    if (!existsSync(this.#metadataPath)) {
      return { provider: "deepseek", configured: false, modelId: DEFAULT_MODEL_ID };
    }
    const connection = this.requireConnection();
    return {
      provider: "deepseek",
      configured: true,
      modelId: connection.modelId,
      maskedApiKey: maskApiKey(connection.apiKey)
    };
  }

  configure(apiKey: string, modelId = DEFAULT_MODEL_ID): ModelConnectionStatus {
    const normalizedApiKey = apiKey.trim();
    const normalizedModelId = modelId.trim();
    if (normalizedApiKey.length < 8 || normalizedApiKey.length > 512) throw new Error("MODEL_API_KEY_INVALID");
    if (!normalizedModelId || normalizedModelId.length > 100) throw new Error("MODEL_ID_INVALID");

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, iv);
    cipher.setAAD(AAD);
    const ciphertext = Buffer.concat([cipher.update(normalizedApiKey, "utf8"), cipher.final()]);
    const stored: StoredModelConnection = {
      version: 1,
      provider: "deepseek",
      modelId: normalizedModelId,
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64")
    };
    writePrivateJsonAtomically(this.#metadataPath, stored);
    return this.status();
  }

  requireConnection(): ModelConnection {
    if (!existsSync(this.#metadataPath)) throw new Error("MODEL_NOT_CONFIGURED");
    try {
      const stored = JSON.parse(readFileSync(this.#metadataPath, "utf8")) as StoredModelConnection;
      if (stored.version !== 1 || stored.provider !== "deepseek") throw new Error("invalid metadata");
      const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, Buffer.from(stored.iv, "base64"));
      decipher.setAAD(AAD);
      decipher.setAuthTag(Buffer.from(stored.authTag, "base64"));
      const apiKey = Buffer.concat([
        decipher.update(Buffer.from(stored.ciphertext, "base64")),
        decipher.final()
      ]).toString("utf8");
      if (!apiKey || !stored.modelId) throw new Error("invalid connection");
      return { apiKey, modelId: stored.modelId };
    } catch {
      throw new Error("MODEL_CONFIG_INVALID");
    }
  }
}

function maskApiKey(apiKey: string): string {
  const prefix = apiKey.slice(0, Math.min(3, apiKey.length));
  const suffix = apiKey.length > 7 ? apiKey.slice(-4) : "";
  return `${prefix}••••${suffix}`;
}

function writePrivateJsonAtomically(path: string, value: unknown): void {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(value, null, 2), { flag: "wx", mode: 0o600 });
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    try { unlinkSync(temporaryPath); } catch { /* Nothing to clean up. */ }
    throw error;
  }
}
