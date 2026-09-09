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
    // `:memory:` is the right default for a bare `new Database()` — that is a
    // test or a scratch script. The application never relies on it: the
    // composition root reads `DATABASE_PATH` through `server/config/env.ts`
    // (the one place environment is parsed) and passes the resolved path here.
    const rawPath = options.path ?? ':memory:';
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

/**
 * The process-wide database.
 *
 * `MemoryRepository`, `IdentityRepository`, `EventBus` and `CognitiveRuntime`
 * all fall back to this when constructed without an explicit `db`. That makes
 * the singleton load-bearing: if the composition root builds its database and
 * forgets to install it here, any subsystem constructed without one silently
 * opens a *second*, empty, in-memory database and the application runs
 * split-brained — writing her memories to one and reading them from the other.
 *
 * So a conflicting request is an error rather than a shrug. Asking for a
 * specific path when a different one is already open cannot be satisfied, and
 * quietly handing back the wrong database is how that becomes a data-loss bug
 * instead of a startup message.
 */
export function getDatabase(options?: DatabaseOptions): Database {
  if (defaultInstance && defaultInstance.isOpen()) {
    if (options?.path !== undefined && options.path !== defaultInstance.path) {
      throw new Error(
        `getDatabase() was asked for '${options.path}' but '${defaultInstance.path}' is already open. ` +
          'Call closeDatabase() first, or pass the database explicitly instead of using the singleton.',
      );
    }
    return defaultInstance;
  }
  defaultInstance = new Database(options);
  return defaultInstance;
}

/**
 * Installs an already-constructed database as the process-wide one.
 *
 * The composition root builds the database, runs migrations against it, and
 * then publishes it here so the subsystems that default to `getDatabase()` find
 * the real one. Replacing a live instance is refused for the reason above.
 */
export function setDatabase(db: Database): void {
  if (defaultInstance && defaultInstance !== db && defaultInstance.isOpen()) {
    throw new Error(
      `setDatabase() refused: '${defaultInstance.path}' is already open. Call closeDatabase() first.`,
    );
  }
  defaultInstance = db;
}

export function closeDatabase(): void {
  if (defaultInstance) {
    defaultInstance.close();
    defaultInstance = null;
  }
}
