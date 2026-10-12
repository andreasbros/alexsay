import { DurableObject } from "cloudflare:workers";
import { MIGRATIONS } from "./migrations.generated";

/** One statement as the shim sends it to the store. */
export interface Query {
  sql: string;
  params: unknown[];
}

export interface QueryResult {
  results: Record<string, unknown>[];
  meta: { changes: number; last_row_id: number; rows_read: number; rows_written: number; duration: number };
}

/** D1 turns booleans into integers and refuses undefined; the store does the same. */
function toSql(value: unknown): unknown {
  if (value === undefined) {
    throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return value;
}

/**
 * The self-hosted server's database: D1's semantics on a Durable Object's own SQLite storage, the
 * way Cloudflare's local tools implement it. One instance holds the whole database, so every query
 * is serialised, and a batch runs in one transaction.
 */
export class D1Store extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => applyMigrations(ctx.storage.sql));
  }

  query(statements: Query[], batch: boolean): QueryResult[] {
    const sql = this.ctx.storage.sql;
    const run = () => statements.map((statement) => runOne(sql, statement));
    return batch ? this.ctx.storage.transactionSync(run) : run();
  }
}

function runOne(sql: SqlStorage, statement: Query): QueryResult {
  const started = Date.now();
  const cursor = sql.exec(statement.sql, ...statement.params.map(toSql));
  const results = cursor.toArray() as Record<string, unknown>[];
  const wrote = cursor.rowsWritten > 0;
  const last = sql.exec("SELECT changes() AS changes, last_insert_rowid() AS id").one() as {
    changes: number;
    id: number;
  };
  return {
    results,
    meta: {
      changes: wrote ? last.changes : 0,
      last_row_id: last.id,
      rows_read: cursor.rowsRead,
      rows_written: cursor.rowsWritten,
      duration: Date.now() - started,
    },
  };
}

/** wrangler's migration table and order: every file in api/migrations, once, by name. */
export function applyMigrations(sql: SqlStorage): string[] {
  sql.exec(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
  );
  const done = new Set(
    sql
      .exec("SELECT name FROM d1_migrations")
      .toArray()
      .map((row) => String(row.name)),
  );
  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (done.has(migration.name)) {
      continue;
    }
    sql.exec(migration.sql);
    sql.exec("INSERT INTO d1_migrations (name) VALUES (?)", migration.name);
    applied.push(migration.name);
  }
  return applied;
}

type Store = DurableObjectNamespace<D1Store>;

/** RPC types cannot prove `unknown` row values serialisable, so the result type is restated here. */
/** A stub per call: workerd ties stubs to the request that made them, as Cloudflare does. */
async function call(store: Store, statements: Query[], batch: boolean): Promise<QueryResult[]> {
  const stub = store.get(store.idFromName(DATABASE));
  return (await stub.query(statements, batch)) as unknown as QueryResult[];
}

const DATABASE = "alexsay";

/** A prepared statement with D1's interface; nothing runs until first, all, run or a batch. */
class Statement {
  constructor(
    private readonly store: Store,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.store, this.sql, params);
  }

  private async exec(): Promise<QueryResult> {
    const [result] = await call(this.store, [{ sql: this.sql, params: this.params }], false);
    if (!result) {
      throw new Error("D1_ERROR: no result");
    }
    return result;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = (await this.exec()).results[0];
    if (!row) {
      return null;
    }
    return (column ? row[column] : row) as T;
  }

  async all<T = Record<string, unknown>>() {
    const { results, meta } = await this.exec();
    return { success: true as const, results: results as T[], meta };
  }

  async run<T = Record<string, unknown>>() {
    return this.all<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    return (await this.exec()).results.map((row) => Object.values(row) as T);
  }
}

/** D1Database for the self-hosted server: the API cannot tell it from Cloudflare's binding. */
export class D1Shim {
  constructor(private readonly store: Store) {}

  prepare(sql: string): Statement {
    return new Statement(this.store, sql);
  }

  async batch(statements: Statement[]) {
    const results = await call(
      this.store,
      statements.map((s) => ({ sql: s.sql, params: s.params })),
      true,
    );
    return results.map(({ results: rows, meta }) => ({ success: true as const, results: rows, meta }));
  }

  async exec(sql: string) {
    const results = await call(this.store, [{ sql, params: [] }], false);
    return { count: results.length, duration: 0 };
  }
}
