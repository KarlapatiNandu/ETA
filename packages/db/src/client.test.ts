import { describe, expect, it } from "vitest";
import { createPgDb } from "./client.ts";

/**
 * Stage 8 chaos finding: a Postgres restart must not kill the process holding the pool. Needs a
 * real server (PGlite has no connections to lose): runs in CI's postgres15 job and locally with
 * TEST_DATABASE_URL.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("createPgDb survives the database dropping its connections", () => {
  it("an idle connection killed by the server is logged, replaced, and the next query works", async () => {
    const errors: string[] = [];
    const db = createPgDb(url!, { max: 2, onIdleError: (e) => errors.push(e.message) });
    const killer = createPgDb(url!, { max: 1 });
    try {
      // open an idle pooled connection and learn its backend pid
      const { rows } = await db.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      // what a restart or failover does to it
      await killer.query("SELECT pg_terminate_backend($1)", [rows[0]!.pid]);
      for (let i = 0; i < 50 && !errors.length; i++) await new Promise((r) => setTimeout(r, 20));
      expect(errors.length).toBe(1); // reported, not thrown: the process is still here
      const again = await db.query<{ ok: number }>("SELECT 1 AS ok");
      expect(again.rows[0]!.ok).toBe(1);
    } finally {
      await db.close();
      await killer.close();
    }
  });
});
