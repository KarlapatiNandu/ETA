import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "./client.ts";
import { createTestDb, seedStudent, type TestDb } from "./testing/index.ts";

/** Migration 0007 — the admin console's tables: constraints, RLS and audit (Stage 7). */

let db: TestDb;
let a: string, b: string, admin: string, busId: string;

beforeAll(async () => {
  db = await createTestDb();
  a = (await seedStudent(db, { rollNo: "160125737101" })).userId!;
  b = (await seedStudent(db, { rollNo: "160125737102", phone: "+919999900102" })).userId!;
  admin = (await seedStudent(db, { rollNo: "TDADMIN07", role: "td_admin", phone: "+919999900107" }))
    .userId!;
  busId = (
    await db.query<{ id: string }>(`INSERT INTO buses (bus_number) VALUES ('14') RETURNING id`)
  ).rows[0]!.id;
});
afterAll(() => db.close());

const ticket = (kind: string, extra = "") =>
  db.query<{ id: string }>(
    `INSERT INTO tickets (kind, severity, bus_id, title) VALUES ($1, 0, $2, 'x') ${extra} RETURNING id`,
    [kind, busId],
  );

describe("constraints", () => {
  it("allows one open out-of-commission ticket per bus, and a new one once it is resolved", async () => {
    const first = await ticket("out_of_commission");
    await expect(ticket("out_of_commission")).rejects.toThrow(/one_open_commission_ticket/);
    await db.query(`UPDATE tickets SET status = 'resolved' WHERE id = $1`, [first.rows[0]!.id]);
    await expect(ticket("out_of_commission")).resolves.toBeTruthy();
    // other kinds are not limited
    await ticket("breakdown");
    await ticket("breakdown");
  });

  it("names exactly one route or bus for a scoped audience, and nothing otherwise", async () => {
    const ins = (audience: string, ref: string | null) =>
      db.query(
        `INSERT INTO announcements (tier, audience, audience_ref, title, body_md, confirmed_count, created_by)
         VALUES (2, $1, $2, 't', 'b', 0, $3)`,
        [audience, ref, admin],
      );
    await expect(ins("bus", null)).rejects.toThrow(/check/i);
    await expect(ins("juniors", busId)).rejects.toThrow(/check/i);
    await expect(ins("bus", busId)).resolves.toBeTruthy();
    await expect(ins("custom", null)).resolves.toBeTruthy();
  });

  it("keeps one main favourite per student", async () => {
    const bus2 = (
      await db.query<{ id: string }>(`INSERT INTO buses (bus_number) VALUES ('22') RETURNING id`)
    ).rows[0]!.id;
    await db.query(`INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, 'main')`, [
      a,
      busId,
    ]);
    await expect(
      db.query(`INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, 'main')`, [a, bus2]),
    ).rejects.toThrow(/one_main_fav/);
    await db.query(`INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, 'starred')`, [
      a,
      bus2,
    ]);
  });
});

describe("row-level security", () => {
  it("shows a student only their own favourites, and an admin none of them", async () => {
    await db.query(`INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, 'starred')`, [
      b,
      busId,
    ]);
    const mine = await db.as(a, (q) =>
      q.query<{ user_id: string }>("SELECT user_id FROM favourites"),
    );
    expect(new Set(mine.rows.map((r) => r.user_id))).toEqual(new Set([a]));
    const asAdmin = await db.as(admin, (q) => q.query("SELECT * FROM favourites"));
    expect(asAdmin.rows).toEqual([]);
    // A cannot star on B's behalf
    await expect(
      db.as(a, (q) =>
        q.query(`INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, 'starred')`, [
          b,
          busId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("lets students read tickets but never write them, and hides cancelled ones", async () => {
    const t = (await ticket("breakdown")).rows[0]!.id;
    const c = (await ticket("other", "")).rows[0]!.id;
    await db.query(`UPDATE tickets SET status = 'cancelled' WHERE id = $1`, [c]);
    const seen = await db.as(a, (q) => q.query<{ id: string }>("SELECT id FROM tickets"));
    const ids = seen.rows.map((r) => r.id);
    expect(ids).toContain(t);
    expect(ids).not.toContain(c);
    const upd = await db.as(a, (q) =>
      q.query(`UPDATE tickets SET status = 'resolved' WHERE id = $1 RETURNING id`, [t]),
    );
    expect(upd.rows).toEqual([]);
  });

  it("keeps drivers, announcements and their recipients admin-only", async () => {
    await db.query(
      `INSERT INTO drivers (full_name, phone_e164) VALUES ('Ramesh', '+919999900150')`,
    );
    for (const table of ["drivers", "announcements", "announcement_recipients"]) {
      const s = await db.as(a, (q) => q.query(`SELECT * FROM ${table}`));
      expect(s.rows, table).toEqual([]);
    }
    const d = await db.as(admin, (q) => q.query("SELECT full_name FROM drivers"));
    expect(d.rows).toEqual([{ full_name: "Ramesh" }]);
  });

  it("lets anyone signed in read the applied event-day list; only admins write it", async () => {
    const up = await db.query<{ id: string }>(
      `INSERT INTO roster_uploads (kind, service_date, file_path, original_name, content_hash, uploaded_by, status)
       VALUES ('event_day_buses', '2026-10-02', 'x', 'x.csv', 'h', $1, 'applied') RETURNING id`,
      [admin],
    );
    await db.query(
      `INSERT INTO event_day_buses (upload_id, service_date, cohort, bus_id, bus_number_raw)
       VALUES ($1, '2026-10-02', 'junior', $2, '14')`,
      [up.rows[0]!.id, busId],
    );
    const s = await db.as(a, (q) => q.query("SELECT bus_number_raw FROM event_day_buses"));
    expect(s.rows).toEqual([{ bus_number_raw: "14" }]);
    await expect(
      db.as(a, (q) => q.query(`DELETE FROM event_day_buses RETURNING id`)),
    ).resolves.toMatchObject({ rows: [] });
  });
});

describe("audit", () => {
  it("records a ticket transition with actor and before/after", async () => {
    const t = (await ticket("delay")).rows[0]!.id;
    await withContext(db, { actorId: admin, ip: "10.0.0.7", userAgent: "vitest" }, (q) =>
      q.query(`UPDATE tickets SET status = 'acknowledged' WHERE id = $1`, [t]),
    );
    const { rows } = await db.query<{
      actor_id: string;
      before: { status: string };
      after: { status: string };
    }>(
      `SELECT actor_id, before, after FROM audit_log
        WHERE entity = 'tickets' AND entity_id = $1 AND action = 'tickets.update'`,
      [t],
    );
    expect(rows[0]).toMatchObject({
      actor_id: admin,
      before: { status: "open" },
      after: { status: "acknowledged" },
    });
  });

  it("does not audit a student starring a bus", async () => {
    const n = async () =>
      (
        await db.query<{ n: number }>(
          `SELECT count(*)::int n FROM audit_log WHERE entity = 'favourites'`,
        )
      ).rows[0]!.n;
    expect(await n()).toBe(0);
  });
});
