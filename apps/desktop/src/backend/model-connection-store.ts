import type { ModelConnectionStatus } from "@brainbuddy/domain";

export interface ModelConnection {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
}

export function modelConnectionFromEnvironment(environment: NodeJS.ProcessEnv): ModelConnection | undefined {
  const apiKey = environment.SECRET_DEEPSEEK_API_KEY?.trim();
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseUrl: environment.SECRET_DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL,
    modelId: environment.SECRET_DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL_ID
  };
}

interface StoredModelConnection {
  readonly version: 1;
  readonly provider: "deepseek";
  readonly baseUrl: string;
  readonly modelId: string;
  readonly apiKey: string;
}

export const DEFAULT_MODEL_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";
const DEFAULT_BASE_URL = DEFAULT_MODEL_BASE_URL;

export interface ModelConnectionSettings {
  read(): string | undefined;
  write(value: string): void;
}

export class ModelConnectionStore {
  readonly #settings: ModelConnectionSettings;
  readonly #initialConnection: ModelConnection | undefined;

  constructor(options: {
    readonly settings: ModelConnectionSettings;
    readonly initialConnection?: ModelConnection;
  }) {
    this.#settings = options.settings;
    this.#initialConnection = options.initialConnection;
  }

  status(): ModelConnectionStatus {
    const connection = this.#readOrImport();
    if (!connection) {
      return { provider: "deepseek", configured: false, baseUrl: DEFAULT_BASE_URL, modelId: DEFAULT_MODEL_ID };
    }
    return {
      provider: "deepseek",
      configured: true,
      baseUrl: connection.baseUrl,
      modelId: connection.modelId,
      maskedApiKey: maskApiKey(connection.apiKey)
    };
  }

  configure(apiKey: string, baseUrl = DEFAULT_BASE_URL, modelId = DEFAULT_MODEL_ID): ModelConnectionStatus {
    const normalizedApiKey = apiKey.trim();
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const normalizedModelId = modelId.trim();
    if (normalizedApiKey.length < 8 || normalizedApiKey.length > 512) throw new Error("MODEL_API_KEY_INVALID");
    if (!normalizedModelId || normalizedModelId.length > 100) throw new Error("MODEL_ID_INVALID");

    const stored: StoredModelConnection = {
      version: 1,
      provider: "deepseek",
      baseUrl: normalizedBaseUrl,
      modelId: normalizedModelId,
      apiKey: normalizedApiKey
    };
    this.#settings.write(JSON.stringify(stored));
    return this.status();
  }

  requireConnection(): ModelConnection {
    const connection = this.#readOrImport();
    if (!connection) throw new Error("MODEL_NOT_CONFIGURED");
    return connection;
  }

  #readOrImport(): ModelConnection | undefined {
    const value = this.#settings.read();
    if (!value && this.#initialConnection?.apiKey.trim()) {
      this.configure(this.#initialConnection.apiKey, this.#initialConnection.baseUrl, this.#initialConnection.modelId);
      return this.#read();
    }
    return value ? this.#read(value) : undefined;
  }

  #read(value = this.#settings.read()): ModelConnection {
    if (!value) throw new Error("MODEL_NOT_CONFIGURED");
    try {
      const stored = JSON.parse(value) as Partial<StoredModelConnection>;
      if (stored.version !== 1 || stored.provider !== "deepseek" || !stored.apiKey || !stored.modelId || !stored.baseUrl) {
        throw new Error("invalid metadata");
      }
      return {
        apiKey: stored.apiKey,
        baseUrl: normalizeBaseUrl(stored.baseUrl),
        modelId: stored.modelId
      };
    } catch {
      throw new Error("MODEL_CONFIG_INVALID");
    }
  }
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/u, "");
  try {
    const url = new URL(normalized);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
    return url.toString().replace(/\/$/u, "");
  } catch {
    throw new Error("MODEL_BASE_URL_INVALID");
  }
}

function maskApiKey(apiKey: string): string {
  const prefix = apiKey.slice(0, Math.min(3, apiKey.length));
  const suffix = apiKey.length > 7 ? apiKey.slice(-4) : "";
  return `${prefix}••••${suffix}`;
}
