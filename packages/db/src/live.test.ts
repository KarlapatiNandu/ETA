import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDb,
  seedRoute,
  seedStudent,
  seedTracker,
  seedTrip,
  type TestDb,
} from "./testing/index.ts";

/** Stage 3 schema: dead_zones and signal_outages (SCHEMA §3, migration 0005). */

const KEY = "test-tracker-key-0123456789abcdef0123";
const coords = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5447 },
];

let db: TestDb;
let student: string;
let admin: string;
let tripId: string;
let busId: string;

beforeAll(async () => {
  db = await createTestDb();
  student = (await seedStudent(db, { rollNo: "160125737001" })).userId!;
  admin = (await seedStudent(db, { rollNo: "TDADMIN01", role: "td_admin", phone: "+919999900099" }))
    .userId!;
  const { routeId } = await seedRoute(db, { coords, published: true });
  ({ busId } = await seedTracker(db, {
    busNumber: "31",
    deviceUid: "d-31",
    secret: "x",
    key: KEY,
  }));
  tripId = await seedTrip(db, { busId, routeId });
});
afterAll(() => db.close());

const openOutage = (at = "2026-09-23 02:00:00+00") =>
  db.query<{ id: string }>(
    `INSERT INTO signal_outages (trip_id, bus_id, entry_point, started_at)
     VALUES ($1, $2, ST_MakePoint(78.53, 17.3688)::geography, $3) RETURNING id`,
    [tripId, busId, at],
  );

describe("signal_outages", () => {
  it("derives the duration when the outage closes", async () => {
    const { rows } = await openOutage();
    const closed = await db.query<{ duration_s: number }>(
      `UPDATE signal_outages SET recovered_at = started_at + interval '97 seconds',
              exit_point = ST_MakePoint(78.54, 17.3688)::geography
        WHERE id = $1 RETURNING duration_s`,
      [rows[0]!.id],
    );
    expect(closed.rows[0]!.duration_s).toBe(97);
  });

  it("allows one open outage per trip, so a restarted sweeper cannot open a second", async () => {
    await openOutage("2026-09-23 03:00:00+00");
    await expect(openOutage("2026-09-23 03:00:05+00")).rejects.toThrow(/one_open_outage|unique/);
  });

  it("is admin-only: a student reads zero rows and cannot write", async () => {
    expect((await db.as(student, (q) => q.query(`SELECT * FROM signal_outages`))).rows).toEqual([]);
    expect(
      (await db.as(admin, (q) => q.query(`SELECT * FROM signal_outages`))).rows.length,
    ).toBeGreaterThan(0);
    await expect(
      db.as(student, (q) =>
        q.query(
          `INSERT INTO signal_outages (trip_id, bus_id, entry_point, started_at)
           VALUES ($1, $2, ST_MakePoint(78.5, 17.3)::geography, now())`,
          [tripId, busId],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("dead_zones", () => {
  it("students can read them (the map explains a known zone) but not write them", async () => {
    await db.query(
      `INSERT INTO dead_zones (polygon, label, sample_count, avg_outage_s, p90_outage_s, confidence,
                               last_observed_at)
       VALUES (ST_Buffer(ST_MakePoint(78.53, 17.3688)::geography, 150)::geography,
               'Test underpass', 6, 90, 140, 0.8, now())`,
    );
    const seen = await db.as(student, (q) =>
      q.query<{ label: string }>(`SELECT label FROM dead_zones`),
    );
    expect(seen.rows).toEqual([{ label: "Test underpass" }]);
    await expect(
      db.as(student, (q) => q.query(`UPDATE dead_zones SET label = 'x' RETURNING id`)),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("classifies a point inside the polygon, and not one outside it", async () => {
    const hit = await db.query<{ label: string }>(
      `SELECT label FROM dead_zones WHERE ST_Covers(polygon, ST_MakePoint($1, $2)::geography)`,
      [78.5305, 17.3689],
    );
    expect(hit.rows).toEqual([{ label: "Test underpass" }]);
    const miss = await db.query(
      `SELECT 1 FROM dead_zones WHERE ST_Covers(polygon, ST_MakePoint($1, $2)::geography)`,
      [78.54, 17.3688],
    );
    expect(miss.rows).toEqual([]);
  });

  it("anonymous has no access to either table", async () => {
    for (const t of ["dead_zones", "signal_outages"]) {
      await expect(db.as(null, (q) => q.query(`SELECT * FROM ${t}`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
