import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import copyStreams from "pg-copy-streams";

/**
 * The minimal database surface every server component uses. Two implementations: node-pg
 * against Supabase Postgres, and PGlite in tests (`@busmitra/db/testing`). Keeping it this
 * small is what lets the gateway's route tests run against a real Postgres without Docker.
 */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /**
   * `COPY table (columns) FROM STDIN (FORMAT csv)` on this connection. Only transaction
   * handles (inside `tx`) are guaranteed to have it: COPY into a temp table must run on the
   * same connection as the statements around it.
   */
  copyFrom?(table: string, columns: readonly string[], csv: string): Promise<void>;
}

/** Quote one value for COPY … (FORMAT csv). null → unquoted empty field, which COPY reads as NULL. */
export function csvField(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) || s === "" ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: readonly (readonly unknown[])[]): string {
  return rows.map((r) => r.map(csvField).join(",")).join("\n") + (rows.length ? "\n" : "");
}

export function copySql(table: string, columns: readonly string[], source: string): string {
  const ident = /^[a-z_][a-z0-9_]*$/;
  if (!ident.test(table) || !columns.every((c) => ident.test(c))) {
    throw new Error(`refusing to COPY into unsafe identifier ${table}(${columns.join(",")})`);
  }
  return `COPY ${table} (${columns.join(", ")}) FROM ${source} WITH (FORMAT csv)`;
}

/** COPY over a node-pg client, streaming the CSV text. */
export async function pgCopyFrom(
  client: pg.PoolClient | pg.Client,
  table: string,
  columns: readonly string[],
  csv: string,
): Promise<void> {
  const stream = client.query(copyStreams.from(copySql(table, columns, "STDIN")));
  await pipeline(Readable.from([csv]), stream);
}

export interface Db extends Queryable {
  /** Run `fn` inside one transaction; rolls back if it throws. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface RequestContext {
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Run `fn` in a transaction that carries the HTTP request context, so the audit_row
 * trigger can record actor, ip and user agent (SCHEMA §8).
 *
 * The settings are transaction-local (`set_config(..., true)`), so a pooled connection can
 * never carry one request's identity into the next. Every audited mutation must go
 * through here — a mutation outside it is audited with NULL context.
 */
export function withContext<T>(
  db: Db,
  ctx: RequestContext,
  fn: (q: Queryable) => Promise<T>,
): Promise<T> {
  return db.tx(async (q) => {
    await q.query(
      `SELECT set_config('app.actor_id', $1, true),
              set_config('app.client_ip', $2, true),
              set_config('app.user_agent', $3, true)`,
      [ctx.actorId ?? "", ctx.ip ?? "", ctx.userAgent ?? ""],
    );
    return fn(q);
  });
}

export function createPgDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    query: async (sql, params) => pool.query(sql, params) as never,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn({
          query: async (sql, params) => client.query(sql, params) as never,
          copyFrom: (table, columns, csv) => pgCopyFrom(client, table, columns, csv),
        });
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
