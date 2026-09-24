import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "./client.ts";
import { createTestDb, seedStudent, type TestDb } from "./testing/index.ts";

let db: TestDb;
let admin: string;
beforeAll(async () => {
  db = await createTestDb();
  admin = (await seedStudent(db, { rollNo: "TDADMIN01", role: "td_admin" })).userId!;
  await seedStudent(db, { rollNo: "S1", claimed: false, phone: null });
});
afterAll(() => db.close());

type Row = {
  actor_id: string | null;
  action: string;
  ip: string | null;
  user_agent: string | null;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
};

describe("audit_log", () => {
  it("records actor, ip, user agent and before/after when context is pushed", async () => {
    await withContext(db, { actorId: admin, ip: "10.1.2.3", userAgent: "vitest" }, (q) =>
      q.query(`UPDATE roster_students SET phone_e164 = '+919999900010' WHERE roll_no = 'S1'`),
    );
    const { rows } = await db.query<Row>(
      `SELECT actor_id, action, host(ip) AS ip, user_agent, before, after FROM audit_log
        WHERE action = 'roster_students.update' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({ actor_id: admin, ip: "10.1.2.3", user_agent: "vitest" });
    expect(rows[0]!.before.phone_e164).toBeNull();
    expect(rows[0]!.after.phone_e164).toBe("+919999900010");
  });

  it("does not leak context into the next transaction on the same connection", async () => {
    await db.query(`UPDATE roster_students SET branch = 'IT' WHERE roll_no = 'S1'`);
    const { rows } = await db.query<Row>(
      `SELECT actor_id, host(ip) AS ip FROM audit_log ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toEqual({ actor_id: null, ip: null });
  });

  it("never writes a pinned home location into the log", async () => {
    await withContext(db, { actorId: null, ip: null, userAgent: null }, (q) =>
      q.query(
        `UPDATE profiles SET home_location = 'SRID=4326;POINT(78.4 17.4)', home_label = 'home'`,
      ),
    );
    const { rows } = await db.query<Row>(
      `SELECT before, after FROM audit_log WHERE entity = 'profiles' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.after).not.toHaveProperty("home_location");
    expect(rows[0]!.after).not.toHaveProperty("home_label");
  });

  it("does not audit a student editing their own preferences", async () => {
    const { userId } = await seedStudent(db, { rollNo: "S2" });
    const before = (await db.query<{ n: number }>("SELECT count(*)::int n FROM audit_log")).rows[0]!
      .n;
    await db.as(
      userId,
      (q) => q.query("UPDATE profiles SET travel_mode = 'car' WHERE id = $1", [userId]),
      true,
    );
    const after = (await db.query<{ n: number }>("SELECT count(*)::int n FROM audit_log")).rows[0]!
      .n;
    expect(after).toBe(before);
  });
});
