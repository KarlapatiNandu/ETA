import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createTestDb,
  seedRoute,
  seedStudent,
  seedTracker,
  seedTrip,
  type TestDb,
} from "./testing/index.ts";

/** Stage 5 schema (migration 0006): the traffic model, subscriptions, the home pin, RLS. */

const KEY = "test-tracker-key-0123456789abcdef0123";
const coords = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5647 },
];

let db: TestDb;
let a: string;
let b: string;
let admin: string;
let routeId: string;
let lineageId: string;
let stopIds: string[];
let busId: string;

beforeAll(async () => {
  db = await createTestDb();
  a = (await seedStudent(db, { rollNo: "160125737001" })).userId!;
  b = (await seedStudent(db, { rollNo: "160125737002", phone: "+919999900002" })).userId!;
  admin = (await seedStudent(db, { rollNo: "TDADMIN01", role: "td_admin", phone: "+919999900099" }))
    .userId!;
  ({ routeId, lineageId, stopIds } = await seedRoute(db, {
    coords,
    published: true,
    stops: [
      { name: "S1", offset: 0, lat: 17.3688, lng: 78.5247 },
      { name: "S2", offset: 2000, lat: 17.3688, lng: 78.5436 },
    ],
  }));
  ({ busId } = await seedTracker(db, {
    busNumber: "51",
    deviceUid: "d-51",
    secret: "x",
    key: KEY,
  }));
});
afterAll(() => db.close());

/** A trip on a past service day with fixes every `stepS` seconds at `kmh`. */
async function pastTrip(day: string, startIst: string, kmh: number, n: number, stepS = 5) {
  const bus = await seedTracker(db, {
    busNumber: `P${Math.random().toString(36).slice(2, 7)}`,
    deviceUid: `p-${Math.random()}`,
    secret: "x",
    key: KEY,
  });
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO trips (bus_id, route_id, service_date, shift, status, started_at, ended_at)
     VALUES ($1, $2, $3, 'morning', 'completed', now(), now()) RETURNING id`,
    [bus.busId, routeId, day],
  );
  const trip = rows[0]!.id;
  // make sure a partition exists for the day
  await db.query(`SELECT ensure_positions_partitions(4, 1)`);
  for (let i = 0; i < n; i++) {
    await db.query(
      `INSERT INTO positions (trip_id, bus_id, recorded_at, location, route_offset_m)
       VALUES ($1, $2, ($3::timestamp AT TIME ZONE 'Asia/Kolkata') + make_interval(secs => $4),
               ST_MakePoint(78.53, 17.3688)::geography, $5)`,
      [trip, bus.busId, `${day} ${startIst}`, i * stepS, 100 + (i * stepS * kmh) / 3.6],
    );
  }
  return trip;
}

describe("segment_speeds aggregation (ARCH §5.5 ladder)", () => {
  it("writes all four rungs for a day, from forward progress only", async () => {
    // yesterday-ish: a Wednesday, 08:00 IST, 36 km/h for 2 minutes
    const day = (await db.query<{ d: string }>(`SELECT (operating_date() - 7)::text AS d`)).rows[0]!
      .d;
    await pastTrip(day, "08:00:00", 36, 25);
    const n = await db.query<{ n: number }>(`SELECT aggregate_segment_speeds($1::date) AS n`, [
      day,
    ]);
    expect(n.rows[0]!.n).toBe(24);
    const rungs = await db.query<{
      weekday: number | null;
      tod_bucket: number | null;
      median_kmh: number;
      sample_count: number;
    }>(
      `SELECT weekday, tod_bucket, median_kmh, sample_count FROM segment_speeds
        WHERE route_lineage_id = $1 AND segment_idx = 1 ORDER BY weekday NULLS LAST, tod_bucket NULLS LAST`,
      [lineageId],
    );
    const dow = new Date(`${day}T12:00:00+05:30`).getUTCDay();
    expect(rungs.rows.map((r) => [r.weekday, r.tod_bucket])).toEqual([
      [dow, 32],
      [dow === 0 || dow === 6 ? 8 : 7, 32],
      [null, 32],
      [null, null],
    ]);
    for (const r of rungs.rows) expect(r.median_kmh).toBeCloseTo(36, 0);
  });

  it("is idempotent per day: running it again counts nothing twice", async () => {
    const day = (await db.query<{ d: string }>(`SELECT (operating_date() - 7)::text AS d`)).rows[0]!
      .d;
    const before = await db.query<{ n: number }>(
      `SELECT sum(sample_count)::int AS n FROM segment_speeds`,
    );
    expect(
      (await db.query<{ n: number }>(`SELECT aggregate_segment_speeds($1::date) AS n`, [day]))
        .rows[0]!.n,
    ).toBe(0);
    const after = await db.query<{ n: number }>(
      `SELECT sum(sample_count)::int AS n FROM segment_speeds`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("merges a later day by sample count, and catch-up finds only unaggregated days", async () => {
    const day = (await db.query<{ d: string }>(`SELECT (operating_date() - 6)::text AS d`)).rows[0]!
      .d;
    await pastTrip(day, "08:01:00", 18, 25);
    const caught = await db.query<{ n: number }>(`SELECT aggregate_segment_speeds_catchup() AS n`);
    expect(caught.rows[0]!.n).toBe(24);
    const any = await db.query<{ median_kmh: number; sample_count: number }>(
      `SELECT median_kmh, sample_count FROM segment_speeds
        WHERE route_lineage_id = $1 AND segment_idx = 1 AND weekday IS NULL AND tod_bucket IS NULL`,
      [lineageId],
    );
    expect(any.rows[0]!.median_kmh).toBeGreaterThan(18);
    expect(any.rows[0]!.median_kmh).toBeLessThan(36);
    expect(
      (await db.query<{ n: number }>(`SELECT aggregate_segment_speeds_catchup() AS n`)).rows[0]!.n,
    ).toBe(0);
  });

  it("ignores standing still and GPS spikes", async () => {
    const day = (await db.query<{ d: string }>(`SELECT (operating_date() - 5)::text AS d`)).rows[0]!
      .d;
    await pastTrip(day, "09:00:00", 0, 10); // parked: no progress, no samples
    await pastTrip(day, "09:30:00", 400, 3); // 400 km/h: not a bus
    expect(
      (await db.query<{ n: number }>(`SELECT aggregate_segment_speeds($1::date) AS n`, [day]))
        .rows[0]!.n,
    ).toBe(0);
  });
});

describe("home pin (ARCH §10)", () => {
  it("is coarsened to ~100 m by the database, whoever writes it", async () => {
    // (db.as() rolls its transaction back, so the student's write is read from RETURNING)
    const pin = `ST_SetSRID(ST_MakePoint(78.523456, 17.367891), 4326)::geography`;
    const asStudent = await db.as(a, (q) =>
      q.query<{ lat: number; lng: number }>(
        `UPDATE profiles SET home_location = ${pin} WHERE id = $1
         RETURNING ST_Y(home_location::geometry) AS lat, ST_X(home_location::geometry) AS lng`,
        [a],
      ),
    );
    expect(asStudent.rows[0]).toEqual({ lat: 17.368, lng: 78.523 });
    const asService = await db.query<{ lat: number; lng: number }>(
      `UPDATE profiles SET home_location = ${pin} WHERE id = $1
       RETURNING ST_Y(home_location::geometry) AS lat, ST_X(home_location::geometry) AS lng`,
      [a],
    );
    expect(asService.rows[0]).toEqual({ lat: 17.368, lng: 78.523 });
  });

  it("moving the pin or changing travel mode empties the walk cache", async () => {
    await db.query(
      `INSERT INTO walk_eta_cache (user_id, stop_id, travel_mode, duration_s, distance_m) VALUES ($1, $2, 'foot', 400, 500)`,
      [a, stopIds[0]],
    );
    await db.query(`UPDATE profiles SET max_tier = 2 WHERE id = $1`, [a]); // unrelated: kept
    expect(
      (await db.query(`SELECT 1 FROM walk_eta_cache WHERE user_id = $1`, [a])).rows,
    ).toHaveLength(1);
    await db.query(`UPDATE profiles SET travel_mode = 'bicycle' WHERE id = $1`, [a]);
    expect((await db.query(`SELECT 1 FROM walk_eta_cache WHERE user_id = $1`, [a])).rows).toEqual(
      [],
    );
  });
});

describe("RLS: subscriptions, walk cache, positions, the model", () => {
  let trip: string;
  beforeAll(async () => {
    trip = await seedTrip(db, { busId, routeId });
    await db.query(
      `INSERT INTO trip_subscriptions (user_id, trip_id, target_stop_id) VALUES ($1, $2, $3)`,
      [a, trip, stopIds[1]],
    );
    await db.query(
      `INSERT INTO positions (trip_id, bus_id, recorded_at, location) VALUES ($1, $2, now() - interval '1 minute', ST_MakePoint(78.53, 17.3688)::geography)`,
      [trip, busId],
    );
    await db.query(
      `INSERT INTO walk_eta_cache (user_id, stop_id, travel_mode, duration_s, distance_m) VALUES ($1, $2, 'foot', 400, 500)`,
      [b, stopIds[0]],
    );
  });

  it("student A sees only their own subscription; B's returns zero rows", async () => {
    const own = await db.as(a, (q) => q.query(`SELECT trip_id FROM trip_subscriptions`));
    expect(own.rows).toEqual([{ trip_id: trip }]);
    expect((await db.as(b, (q) => q.query(`SELECT * FROM trip_subscriptions`))).rows).toEqual([]);
  });

  it("a student cannot subscribe someone else", async () => {
    await expect(
      db.as(b, (q) =>
        q.query(
          `INSERT INTO trip_subscriptions (user_id, trip_id, target_stop_id) VALUES ($1, $2, $3)`,
          [a, trip, stopIds[0]],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("walk times are private, from admins too", async () => {
    expect((await db.as(a, (q) => q.query(`SELECT * FROM walk_eta_cache`))).rows).toEqual([]);
    expect((await db.as(b, (q) => q.query(`SELECT * FROM walk_eta_cache`))).rows).toHaveLength(1);
    expect((await db.as(admin, (q) => q.query(`SELECT * FROM walk_eta_cache`))).rows).toEqual([]);
    expect((await db.as(admin, (q) => q.query(`SELECT * FROM trip_subscriptions`))).rows).toEqual(
      [],
    );
  });

  it("positions: a student reads the trip they follow, and nothing else", async () => {
    const mine = await db.as(a, (q) =>
      q.query(`SELECT trip_id FROM positions WHERE trip_id = $1`, [trip]),
    );
    expect(mine.rows.length).toBe(1);
    expect((await db.as(b, (q) => q.query(`SELECT * FROM positions`))).rows).toEqual([]);
  });

  it("the traffic model and the accuracy log are admin-only", async () => {
    expect((await db.as(a, (q) => q.query(`SELECT * FROM segment_speeds`))).rows).toEqual([]);
    expect((await db.as(a, (q) => q.query(`SELECT * FROM eta_predictions`))).rows).toEqual([]);
    expect(
      (await db.as(admin, (q) => q.query(`SELECT * FROM segment_speeds`))).rows.length,
    ).toBeGreaterThan(0);
  });

  it("eta_predictions derives the error once the arrival is known", async () => {
    await db.query(
      `INSERT INTO eta_predictions (trip_id, seq, stop_id, horizon_s, predicted_at, p50_s, p90_s, confidence, predicted_arrival_at)
       VALUES ($1, 2, $2, 600, '2026-09-23 02:00:00+00', 600, 780, 'low', '2026-09-23 02:10:00+00')`,
      [trip, stopIds[1]],
    );
    const r = await db.query<{ error_s: number }>(
      `UPDATE eta_predictions SET actual_arrival_at = '2026-09-23 02:11:12+00' WHERE trip_id = $1 RETURNING error_s`,
      [trip],
    );
    expect(r.rows[0]!.error_s).toBe(72);
  });
});
