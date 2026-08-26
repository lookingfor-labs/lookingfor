import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseAccessStatus } from "@brainbuddy/domain";

interface PasswordVerifier {
  readonly version: 1;
  readonly salt: string;
  readonly hash: string;
}

export class DatabaseAccessGate {
  readonly #metadataPath: string | undefined;
  #verifier: PasswordVerifier | undefined;
  #unlocked = false;

  constructor(options: { readonly metadataPath?: string } = {}) {
    this.#metadataPath = options.metadataPath;
    this.#verifier = options.metadataPath ? readVerifier(options.metadataPath) : undefined;
  }

  status(): DatabaseAccessStatus {
    return { passwordConfigured: Boolean(this.#verifier), unlocked: !this.#verifier || this.#unlocked };
  }

  configure(currentPassword: string | undefined, newPassword: string): DatabaseAccessStatus {
    assertPasswordStrength(newPassword);
    if (this.#verifier && (!currentPassword || !verifyPassword(currentPassword, this.#verifier))) {
      throw new Error("DATABASE_PASSWORD_INVALID: Current database password is incorrect");
    }
    const salt = randomBytes(16);
    this.#verifier = {
      version: 1,
      salt: salt.toString("base64"),
      hash: derivePassword(newPassword, salt).toString("base64")
    };
    this.#unlocked = true;
    this.#persist();
    return this.status();
  }

  unlock(password: string): DatabaseAccessStatus {
    if (!this.#verifier) return this.status();
    if (!verifyPassword(password, this.#verifier)) throw new Error("DATABASE_PASSWORD_INVALID: Database password is incorrect");
    this.#unlocked = true;
    return this.status();
  }

  lock(): DatabaseAccessStatus {
    this.#unlocked = false;
    return this.status();
  }

  assertUnlocked(): void {
    if (!this.status().unlocked) throw new Error("DATABASE_LOCKED: Unlock the local database first");
  }

  #persist(): void {
    if (!this.#metadataPath || !this.#verifier) return;
    mkdirSync(dirname(this.#metadataPath), { recursive: true });
    const temporaryPath = join(dirname(this.#metadataPath), `.${randomUUID()}.tmp`);
    writeFileSync(temporaryPath, JSON.stringify(this.#verifier, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, this.#metadataPath);
  }
}

function assertPasswordStrength(password: string): void {
  if (password.length < 8 || password.length > 128) {
    throw new Error("DATABASE_PASSWORD_WEAK: Database password must contain 8 to 128 characters");
  }
}

function derivePassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 64);
}

function verifyPassword(password: string, verifier: PasswordVerifier): boolean {
  const expected = Buffer.from(verifier.hash, "base64");
  const actual = derivePassword(password, Buffer.from(verifier.salt, "base64"));
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function readVerifier(path: string): PasswordVerifier | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Partial<PasswordVerifier>;
    if (value.version !== 1 || typeof value.salt !== "string" || typeof value.hash !== "string") {
      throw new Error("Stored database password metadata is invalid");
    }
    return value as PasswordVerifier;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
