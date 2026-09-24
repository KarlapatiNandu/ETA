import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCumulativeDistances, type LatLng } from "@busmitra/geo";
import {
  createTestDb,
  seedRoute,
  seedStudent,
  seedTracker,
  seedTrip,
  type TestDb,
} from "./testing/index.ts";

/** Stage 1–2 schema: routes, stops, trackers, trips, positions (SCHEMA §2–§4). */

const KEY = "test-tracker-key-0123456789abcdef0123";
// ~3 km through Hyderabad with a bend, so the prefix sums are not trivially linear
const coords: LatLng[] = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3702, lng: 78.5301 },
  { lat: 17.3721, lng: 78.5355 },
  { lat: 17.3775, lng: 78.5381 },
  { lat: 17.3842, lng: 78.5396 },
];

let db: TestDb;
let student: string;
let admin: string;

beforeAll(async () => {
  db = await createTestDb();
  student = (await seedStudent(db, { rollNo: "160125737001" })).userId!;
  admin = (await seedStudent(db, { rollNo: "TDADMIN01", role: "td_admin", phone: "+919999900099" }))
    .userId!;
});
afterAll(() => db.close());

describe("routes: derived distances", () => {
  it("cumulative_dist_m matches packages/geo to the millimetre (same sphere)", async () => {
    const { routeId } = await seedRoute(db, { coords, name: "D[] parity" });
    const { rows } = await db.query<{ d: number[]; total: number }>(
      `SELECT cumulative_dist_m AS d, total_distance_m AS total FROM routes WHERE id = $1`,
      [routeId],
    );
    const expected = buildCumulativeDistances(coords);
    expect(rows[0]!.d).toHaveLength(coords.length);
    rows[0]!.d.forEach((d, i) => expect(Math.abs(d - expected[i]!)).toBeLessThan(0.001));
    expect(rows[0]!.total).toBeCloseTo(expected[expected.length - 1]!, 3);
  });

  it("recomputes when a draft's geometry changes", async () => {
    const { routeId } = await seedRoute(db, { coords, name: "reshaped" });
    await db.query(
      `UPDATE routes SET geometry = ST_GeomFromText('LINESTRING(78.5247 17.3688, 78.5301 17.3702)', 4326)::geography
        WHERE id = $1`,
      [routeId],
    );
    const { rows } = await db.query<{ d: number[] }>(
      `SELECT cumulative_dist_m AS d FROM routes WHERE id = $1`,
      [routeId],
    );
    expect(rows[0]!.d).toHaveLength(2);
    expect(rows[0]!.d[1]!).toBeCloseTo(buildCumulativeDistances(coords.slice(0, 2))[1]!, 3);
  });
});

describe("routes: versioning (ADR-0003)", () => {
  it("a published route is immutable, but can be archived", async () => {
    const { routeId, stopIds } = await seedRoute(db, {
      coords,
      name: "frozen",
      published: true,
      stops: [{ name: "Dilsukhnagar", offset: 0, ...coords[0]! }],
    });
    await expect(db.query(`UPDATE routes SET name = 'x' WHERE id = $1`, [routeId])).rejects.toThrow(
      /immutable/,
    );
    await expect(
      db.query(`UPDATE route_stops SET cumulative_dist_m = 5 WHERE route_id = $1`, [routeId]),
    ).rejects.toThrow(/frozen/);
    await expect(
      db.query(
        `INSERT INTO route_stops (route_id, seq, stop_id, cumulative_dist_m) VALUES ($1, 9, $2, 10)`,
        [routeId, stopIds[0]],
      ),
    ).rejects.toThrow(/frozen/);
    await expect(db.query(`DELETE FROM routes WHERE id = $1`, [routeId])).rejects.toThrow(
      /cannot be deleted/,
    );
    await db.query(`UPDATE routes SET archived_at = now() WHERE id = $1`, [routeId]);
  });

  it("allows exactly one live published version per lineage", async () => {
    const v1 = await seedRoute(db, { coords, name: "lineage", published: true });
    const v2 = await seedRoute(db, {
      coords,
      name: "lineage",
      lineageId: v1.lineageId,
      version: 2,
    });
    await expect(
      db.query(`UPDATE routes SET published_at = now() WHERE id = $1`, [v2.routeId]),
    ).rejects.toThrow(/one_live_route/);
    // the publish sequence: archive the old version first, then publish the new one
    await db.tx(async (q) => {
      await q.query(`UPDATE routes SET archived_at = now() WHERE id = $1`, [v1.routeId]);
      await q.query(`UPDATE routes SET published_at = now() WHERE id = $1`, [v2.routeId]);
    });
  });

  it("a draft can be deleted", async () => {
    const { routeId } = await seedRoute(db, { coords, name: "scratch" });
    await db.query(`DELETE FROM routes WHERE id = $1`, [routeId]);
  });
});

describe("RLS: routes and fleet", () => {
  it("students see published routes only — never drafts or archived versions", async () => {
    const live = await seedRoute(db, { coords, name: "visible", published: true });
    const draft = await seedRoute(db, { coords, name: "hidden draft" });
    const seen = await db.as(student, (q) =>
      q.query<{ id: string }>(`SELECT id FROM routes WHERE id = ANY($1)`, [
        [live.routeId, draft.routeId],
      ]),
    );
    expect(seen.rows.map((r) => r.id)).toEqual([live.routeId]);
    const adminSeen = await db.as(admin, (q) =>
      q.query(`SELECT id FROM routes WHERE id = ANY($1)`, [[live.routeId, draft.routeId]]),
    );
    expect(adminSeen.rows).toHaveLength(2);
  });

  it("students cannot write routes, stops or buses", async () => {
    await expect(
      db.as(student, (q) =>
        q.query(`INSERT INTO stops (name, location) VALUES ('x', ST_MakePoint(78, 17)::geography)`),
      ),
    ).rejects.toThrow(/row-level security/);
    const upd = await db.as(student, (q) =>
      q.query(`UPDATE buses SET status_note = 'x' RETURNING id`),
    );
    expect(upd.rows).toEqual([]);
  });

  it("nobody reads a tracker secret through the API — not even an admin", async () => {
    await seedTracker(db, {
      busNumber: "S1",
      deviceUid: "dev-secret-test",
      secret: "s3cret",
      key: KEY,
    });
    await expect(db.as(admin, (q) => q.query(`SELECT secret_enc FROM trackers`))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      db.as(admin, (q) => q.query(`SELECT secret_prev_enc FROM trackers`)),
    ).rejects.toThrow(/permission denied/);
    const ok = await db.as(admin, (q) =>
      q.query<{ device_uid: string }>(
        `SELECT device_uid FROM trackers WHERE device_uid = 'dev-secret-test'`,
      ),
    );
    expect(ok.rows).toHaveLength(1);
    const none = await db.as(student, (q) => q.query(`SELECT device_uid FROM trackers`));
    expect(none.rows).toEqual([]);
  });

  it("the secret decrypts with the gateway key and with nothing else", async () => {
    const { rows } = await db.query<{ s: string }>(
      `SELECT pgp_sym_decrypt(secret_enc, $1) AS s FROM trackers WHERE device_uid = 'dev-secret-test'`,
      [KEY],
    );
    expect(rows[0]!.s).toBe("s3cret");
    await expect(
      db.query(
        `SELECT pgp_sym_decrypt(secret_enc, 'wrong-key') FROM trackers WHERE device_uid = 'dev-secret-test'`,
      ),
    ).rejects.toThrow();
  });

  it("the audit log records tracker changes without the secret", async () => {
    const { rows } = await db.query<{ after: Record<string, unknown> }>(
      `SELECT after FROM audit_log WHERE entity = 'trackers' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.after.device_uid).toBe("dev-secret-test");
    expect(rows[0]!.after).not.toHaveProperty("secret_enc");
  });
});

describe("trips and positions (Stage 2)", () => {
  let tripId: string;
  let busId: string;
  let routeId: string;

  beforeAll(async () => {
    ({ routeId } = await seedRoute(db, { coords, name: "ingest route", published: true }));
    ({ busId } = await seedTracker(db, {
      busNumber: "22",
      deviceUid: "dev-22",
      secret: "x",
      key: KEY,
    }));
    tripId = await seedTrip(db, { busId, routeId });
  });

  it("allows one live trip per bus", async () => {
    await expect(seedTrip(db, { busId, routeId })).rejects.toThrow(/one_live_trip|unique/);
  });

  it("positions are idempotent on (trip_id, recorded_at)", async () => {
    // a fixed instant, as the persister writes it (the tracker's recorded_at, ms precision)
    const insert = `INSERT INTO positions (trip_id, bus_id, recorded_at, location)
                    VALUES ($1, $2, date_trunc('second', now()) - interval '1 minute',
                            ST_MakePoint(78.52, 17.37)::geography)
                    ON CONFLICT (trip_id, recorded_at) DO NOTHING RETURNING id`;
    expect((await db.query(insert, [tripId, busId])).rows).toHaveLength(1);
    // the same instant again (a retried batch) is a no-op, not a failure
    expect((await db.query(insert, [tripId, busId])).rows).toEqual([]);
  });

  it("positions are admin-only until Stage 5 adds the subscription policy", async () => {
    expect((await db.as(student, (q) => q.query(`SELECT * FROM positions`))).rows).toEqual([]);
    expect(
      (await db.as(admin, (q) => q.query(`SELECT * FROM positions`))).rows.length,
    ).toBeGreaterThan(0);
  });

  it("students see running trips, not scheduled ones", async () => {
    const other = await seedTracker(db, {
      busNumber: "23",
      deviceUid: "dev-23",
      secret: "x",
      key: KEY,
    });
    const scheduled = await seedTrip(db, { busId: other.busId, routeId, status: "scheduled" });
    const seen = await db.as(student, (q) =>
      q.query<{ id: string }>(`SELECT id FROM trips WHERE id = ANY($1)`, [[tripId, scheduled]]),
    );
    expect(seen.rows.map((r) => r.id)).toEqual([tripId]);
  });

  it("trip_stop_events are unique on (trip_id, seq, event)", async () => {
    const stop = await db.query<{ id: string }>(
      `INSERT INTO stops (name, location) VALUES ('X', ST_MakePoint(78.52, 17.37)::geography) RETURNING id`,
    );
    const ins = `INSERT INTO trip_stop_events (trip_id, stop_id, seq, event, occurred_at, source)
                 VALUES ($1, $2, 1, 'arrived', now(), 'crossing') ON CONFLICT DO NOTHING RETURNING id`;
    expect((await db.query(ins, [tripId, stop.rows[0]!.id])).rows).toHaveLength(1);
    expect((await db.query(ins, [tripId, stop.rows[0]!.id])).rows).toEqual([]);
  });

  it("partition maintenance is idempotent and keeps current data", async () => {
    const { rows } = await db.query<{ n: number }>(`SELECT ensure_positions_partitions() AS n`);
    expect(rows[0]!.n).toBe(0);
    const dropped = await db.query<{ n: number }>(
      `SELECT drop_expired_positions_partitions() AS n`,
    );
    expect(dropped.rows[0]!.n).toBe(0);
    const later = await db.query<{ n: number }>(`SELECT ensure_positions_partitions(0, 12) AS n`);
    expect(later.rows[0]!.n).toBe(4);
  });

  it("a ping outside every partition is rejected, not silently lost", async () => {
    await expect(
      db.query(
        `INSERT INTO positions (trip_id, bus_id, recorded_at, location)
         VALUES ($1, $2, now() + interval '1 year', ST_MakePoint(78.52, 17.37)::geography)`,
        [tripId, busId],
      ),
    ).rejects.toThrow(/no partition/);
  });
});
