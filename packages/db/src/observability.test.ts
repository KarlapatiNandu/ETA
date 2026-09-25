import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedStudent, type TestDb } from "./testing/index.ts";

/**
 * Migration 0009 (Stage 8): the dashboards' Postgres role reads aggregate views and nothing
 * else — no student, phone number, position or push endpoint (SCHEMA §9, ARCH §10).
 */

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
  await seedStudent(db, { rollNo: "160125738001" });
  // on Supabase `postgres` is not a superuser: it may only become a role it is a member of.
  // Name the role: `GRANT … TO CURRENT_USER` SEGFAULTS Supabase Postgres 15.8.1.085 and takes
  // every connection on the server down with it (M08 gotchas)
  const me = (await db.query<{ u: string }>("SELECT current_user AS u")).rows[0]!.u;
  await db.query(`GRANT busmitra_metrics TO "${me}"`);
});
afterAll(() => db.close());

const asMetrics = <T>(sql: string) =>
  db.tx(async (q) => {
    await q.query("SET LOCAL ROLE busmitra_metrics");
    return (await q.query<T>(sql)).rows;
  });

describe("busmitra_metrics (Grafana's database role)", () => {
  it("reads every obs_* view", async () => {
    for (const v of [
      "obs_eta_accuracy",
      "obs_notification_delivery",
      "obs_signal_outages",
      "obs_dead_zones",
    ]) {
      await expect(asMetrics(`SELECT * FROM ${v} LIMIT 1`), v).resolves.toBeDefined();
    }
  });

  it("cannot read a single table behind them", async () => {
    for (const t of [
      "profiles",
      "roster_students",
      "positions",
      "push_subscriptions",
      "notification_recipients",
      "signal_outages",
      "trackers",
      "audit_log",
    ]) {
      await expect(asMetrics(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toThrow(/permission denied/);
    }
  });
});
