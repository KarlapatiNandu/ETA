import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedStudent, type TestDb } from "./testing/index.ts";

/** Migration 0008 — the notification center's tables: dedupe in the database, and RLS A-vs-B. */

let db: TestDb;
let a: string, b: string, admin: string, nid: string;

beforeAll(async () => {
  db = await createTestDb();
  a = (await seedStudent(db, { rollNo: "160125738001" })).userId!;
  b = (await seedStudent(db, { rollNo: "160125738002", phone: "+919999900802" })).userId!;
  admin = (await seedStudent(db, { rollNo: "TDADMIN08", role: "td_admin", phone: "+919999900808" }))
    .userId!;
  nid = (
    await db.query<{ id: string }>(
      `INSERT INTO notifications (source_key, tier, category, title, body)
       VALUES ('announcement:x', 2, 'announcement', 'Exam day', 'Early buses') RETURNING id`,
    )
  ).rows[0]!.id;
  await db.query(
    `INSERT INTO notification_recipients (notification_id, user_id, dedupe_key) VALUES ($1, $2, 'ka'), ($1, $3, 'kb')`,
    [nid, a, b],
  );
  await db.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://p/a', 'x', 'y'), ($2, 'https://p/b', 'x', 'y')`,
    [a, b],
  );
});
afterAll(() => db.close());

describe("idempotency in the database (invariant 5)", () => {
  it("refuses a second recipient row with the same dedupe_key, and a second parent for the same source", async () => {
    await expect(
      db.query(
        `INSERT INTO notification_recipients (notification_id, user_id, dedupe_key) VALUES ($1, $2, 'ka')`,
        [nid, admin],
      ),
    ).rejects.toThrow(/notif_dedupe/);
    await expect(
      db.query(
        `INSERT INTO notifications (source_key, tier, category, title, body) VALUES ('announcement:x', 2, 'announcement', 't', 'b')`,
      ),
    ).rejects.toThrow(/source_key/);
  });
});

describe("row-level security, student A against student B", () => {
  it("shows A only A's recipient rows and the notifications behind them", async () => {
    const mine = await db.as(a, (q) =>
      q.query<{ user_id: string }>("SELECT user_id FROM notification_recipients"),
    );
    expect(mine.rows.map((r) => r.user_id)).toEqual([a]);
    const n = await db.as(a, (q) => q.query("SELECT id FROM notifications"));
    expect(n.rows).toHaveLength(1);
    const other = await db.as(admin, (q) => q.query("SELECT id FROM notifications"));
    expect(other.rows).toHaveLength(1); // admins read notifications…
    const recips = await db.as(admin, (q) => q.query("SELECT * FROM notification_recipients"));
    expect(recips.rows).toEqual([]); // …but not who received them (counts only)
  });

  it("lets A mark A's row read and acknowledged — and nothing else, and never B's", async () => {
    await db.as(
      a,
      (q) =>
        q.query(`UPDATE notification_recipients SET read_at = now() WHERE notification_id = $1`, [
          nid,
        ]),
      true,
    );
    const rows = await db.query<{ user_id: string; read: boolean }>(
      `SELECT user_id, read_at IS NOT NULL AS read FROM notification_recipients ORDER BY user_id = $1 DESC`,
      [a],
    );
    expect(rows.rows).toEqual([
      { user_id: a, read: true },
      { user_id: b, read: false },
    ]);
    await expect(
      db.as(a, (q) =>
        q.query(`UPDATE notification_recipients SET channel = 'push' WHERE user_id = $1`, [a]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps push subscriptions private to their owner, admins included", async () => {
    const mine = await db.as(a, (q) =>
      q.query<{ endpoint: string }>("SELECT endpoint FROM push_subscriptions"),
    );
    expect(mine.rows.map((r) => r.endpoint)).toEqual(["https://p/a"]);
    expect((await db.as(admin, (q) => q.query("SELECT * FROM push_subscriptions"))).rows).toEqual(
      [],
    );
    await expect(
      db.as(a, (q) =>
        q.query(
          `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, 'https://p/evil', 'x', 'y')`,
          [b],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("gives admins delivery counts, never names; students get nothing from it", async () => {
    const counts = await db.as(admin, (q) =>
      q.query(`SELECT * FROM notification_delivery($1)`, [nid]),
    );
    expect(counts.rows[0]).toMatchObject({ recipients: 2, pending: 2, read: 1 });
    const none = await db.as(a, (q) => q.query(`SELECT * FROM notification_delivery($1)`, [nid]));
    expect(none.rows[0]).toMatchObject({ recipients: 0 });
  });
});
