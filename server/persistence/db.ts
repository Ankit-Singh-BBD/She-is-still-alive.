import DatabaseConstructor, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

export interface DatabaseOptions {
  path?: string;
  readonly?: boolean;
  fileMustExist?: boolean;
  verbose?: (message?: unknown, ...additionalArgs: unknown[]) => void;
}

export class Database {
  private db: DatabaseType;
  private readonly dbPath: string;

  constructor(options: DatabaseOptions = {}) {
    const rawPath = options.path ?? process.env['DATABASE_PATH'] ?? ':memory:';
    this.dbPath = rawPath;

    if (rawPath !== ':memory:') {
      const dir = path.dirname(path.resolve(rawPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseConstructor(rawPath, {
      readonly: options.readonly ?? false,
      fileMustExist: options.fileMustExist ?? false,
      verbose: options.verbose,
    });

    this.configurePragmas();
  }

  private configurePragmas(): void {
    // Enable WAL mode for concurrent readers and write durability
    this.db.pragma('journal_mode = WAL');
    // Enable foreign keys
    this.db.pragma('foreign_keys = ON');
    // Set busy timeout to 5000ms
    this.db.pragma('busy_timeout = 5000');
    // Synchronous normal is safe and performant with WAL
    this.db.pragma('synchronous = NORMAL');
  }

  public get raw(): DatabaseType {
    return this.db;
  }

  public get path(): string {
    return this.dbPath;
  }

  public get isMemory(): boolean {
    return this.dbPath === ':memory:';
  }

  public getJournalMode(): string {
    const result = this.db.pragma('journal_mode', { simple: true });
    return String(result).toLowerCase();
  }

  public getForeignKeysEnabled(): boolean {
    const result = this.db.pragma('foreign_keys', { simple: true });
    return Number(result) === 1;
  }

  public transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  public close(): void {
    if (this.db.open) {
      this.db.close();
    }
  }

  public isOpen(): boolean {
    return this.db.open;
  }
}

let defaultInstance: Database | null = null;

export function getDatabase(options?: DatabaseOptions): Database {
  if (!defaultInstance || !defaultInstance.isOpen()) {
    defaultInstance = new Database(options);
  }
  return defaultInstance;
}

export function closeDatabase(): void {
  if (defaultInstance) {
    defaultInstance.close();
    defaultInstance = null;
  }
}
