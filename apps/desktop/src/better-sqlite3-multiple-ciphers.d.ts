declare module "better-sqlite3-multiple-ciphers" {
  export interface CipherStatement {
    run(...params: readonly unknown[]): { readonly changes: number; readonly lastInsertRowid: number | bigint };
    get(...params: readonly unknown[]): unknown;
    all(...params: readonly unknown[]): unknown[];
  }

  export interface CipherDatabase {
    prepare(source: string): CipherStatement;
    exec(source: string): this;
    pragma(source: string, options?: { readonly simple?: boolean }): unknown;
    close(): this;
  }

  const Database: new (filename: string, options?: { readonly fileMustExist?: boolean }) => CipherDatabase;
  export default Database;
}
