import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { postgis } from "@electric-sql/pglite-postgis";
import pg from "pg";
import { copySql, pgCopyFrom, type Db, type Queryable } from "../client.ts";
import { listMigrations } from "../migrations.ts";

export { lineWkt, seedRoute, seedStudent, seedTracker, seedTrip } from "./fixtures.ts";

export interface TestDb extends Db {
  /**
   * Unqueued access to the single test connection, for fakes of services that would have
   * their own connection in production (Supabase Auth). Going through the queue from inside
   * a transaction deadlocks.
   */
  raw: Queryable;
  /** "pglite" (default) or "postgres" when TEST_DATABASE_URL points at a real server. */
  engine: "pglite" | "postgres";
  /**
   * Run `fn` as a Supabase client would: role `authenticated` with `sub` = userId, or role
   * `anon` when userId is null. RLS applies. Rolled back afterwards unless `commit` is set.
   */
  as<T>(userId: string | null, fn: (q: Queryable) => Promise<T>, commit?: boolean): Promise<T>;
  /** Insert an auth.users row, as Supabase Auth's admin API would. */
  createAuthUser(email: string, id?: string): Promise<string>;
}

interface Engine {
  exec(sql: string): Promise<void>;
  query: Queryable["query"];
  copyFrom: NonNullable<Queryable["copyFrom"]>;
  close(): Promise<void>;
}

const STUB = readFileSync(resolve(import.meta.dirname, "supabase-stub.sql"), "utf8");

async function pgliteEngine(): Promise<Engine> {
  const db = new PGlite({ extensions: { postgis, pgcrypto, pg_trgm } });
  return {
    exec: async (sql) => void (await db.exec(sql)),
    query: async (sql, params) => (await db.query(sql, params)) as never,
    // PGlite has no STDIN; its COPY reads a Blob mounted at /dev/blob
    copyFrom: async (table, columns, csv) =>
      void (await db.query(copySql(table, columns, "'/dev/blob'"), [], { blob: new Blob([csv]) })),
    close: () => db.close(),
  };
}

/**
 * A throwaway database on a real server — e.g. the local Supabase Postgres 15 at
 * postgresql://postgres:postgres@127.0.0.1:54322/postgres. Roles are cluster-wide and
 * already exist there; the stub creates the `auth` schema slice the fresh database lacks.
 */
async function postgresEngine(url: string): Promise<Engine> {
  const name = `busmitra_test_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: target.toString() });
  await client.connect();
  return {
    exec: async (sql) => void (await client.query(sql)),
    query: async (sql, params) => (await client.query(sql, params as unknown[])) as never,
    copyFrom: (table, columns, csv) => pgCopyFrom(client, table, columns, csv),
    close: async () => {
      await client.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** A fresh database with the Supabase stub and every migration applied. */
export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;
  const e = url ? await postgresEngine(url) : await pgliteEngine();
  await e.exec(STUB);
  for (const m of listMigrations()) {
    try {
      await e.exec(m.sql);
    } catch (err) {
      throw new Error(`migration ${m.name} failed: ${(err as Error).message}`, { cause: err });
    }
  }

  // One connection either way: serialise transactions so concurrent tests can't interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
  const q: Queryable = { query: e.query, copyFrom: e.copyFrom };

  const inTx = async <T>(fn: () => Promise<T>, commit = true): Promise<T> => {
    await e.exec("BEGIN");
    try {
      const out = await fn();
      await e.exec(commit ? "COMMIT" : "ROLLBACK");
      return out;
    } catch (err) {
      await e.exec("ROLLBACK");
      throw err;
    }
  };

  return {
    engine: url ? "postgres" : "pglite",
    raw: q,
    query: (sql, params) => serial(() => q.query(sql, params)),
    tx: (fn) => serial(() => inTx(() => fn(q))),
    close: () => e.close(),
    as: (userId, fn, commit = false) =>
      serial(() =>
        inTx(async () => {
          await q.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
            JSON.stringify(userId ? { sub: userId, role: "authenticated" } : { role: "anon" }),
          ]);
          await e.exec(`SET LOCAL ROLE ${userId ? "authenticated" : "anon"}`);
          return fn(q);
        }, commit),
      ),
    createAuthUser: async (email, id) => {
      const { rows } = await serial(() =>
        q.query<{ id: string }>(
          `INSERT INTO auth.users (id, email) VALUES (COALESCE($1::uuid, gen_random_uuid()), $2) RETURNING id`,
          [id ?? null, email],
        ),
      );
      return rows[0]!.id;
    },
  };
}
