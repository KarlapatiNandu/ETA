import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedRoute, type TestDb } from "@busmitra/db/testing";
import { offsetPoint, type LatLng } from "@busmitra/geo";
import { learnDeadZones, nightlyDue, ringWkt, clusterOutages, type Outage } from "./deadzone.ts";
import { classifyDeadZone } from "./presence.ts";

/** BUILD_PLAN Stage 8 — dead-zone learning against the real schema (PGlite + PostGIS). */

let db: TestDb;
let busId: string;
let route: { routeId: string; lineageId: string; stopIds: string[] };
const UPPAL: LatLng = { lat: 17.4015, lng: 78.5591 };
const KOTI: LatLng = { lat: 17.3833, lng: 78.4867 };
const NOW = Date.parse("2026-10-20T00:00:00Z");
const DAY = 86_400_000;
let runSeq = 0;

async function trip(daysAgo: number, status = "completed"): Promise<string> {
  const at = new Date(NOW - daysAgo * DAY).toISOString();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO trips (bus_id, route_id, service_date, shift, run_seq, status, started_at, ended_at)
     VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'Asia/Kolkata')::date, 'morning', $4,
             $5::trip_status_t, $3, CASE WHEN $5 IN ('completed','cancelled') THEN $3::timestamptz END)
     RETURNING id`,
    [busId, route.routeId, at, ++runSeq, status],
  );
  return rows[0]!.id;
}

async function outage(
  tripId: string,
  at: LatLng,
  daysAgo: number,
  opts: { durationS?: number; recovered?: boolean } = {},
) {
  const started = NOW - daysAgo * DAY + 3600_000;
  const recovered = opts.recovered ?? true;
  await db.query(
    `INSERT INTO signal_outages (trip_id, bus_id, entry_point, started_at, recovered_at, exit_point)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6,
             CASE WHEN $7 THEN ST_SetSRID(ST_MakePoint($3 + 0.004, $4), 4326)::geography END)`,
    [
      tripId,
      busId,
      at.lng,
      at.lat,
      new Date(started).toISOString(),
      new Date(started + (opts.durationS ?? 80) * 1000).toISOString(),
      recovered,
    ],
  );
}

/** a zone seen on `trips` trips, one per day, entry points scattered ≤ 60 m */
async function recurring(center: LatLng, trips: number, firstDayAgo: number, durationS = 80) {
  for (let i = 0; i < trips; i++) {
    const t = await trip(firstDayAgo - i);
    await outage(t, offsetPoint(center, 15 + (i % 4) * 15, i * 97), firstDayAgo - i, {
      durationS: durationS + i * 10,
    });
  }
}

beforeAll(async () => {
  db = await createTestDb();
  route = await seedRoute(db, {
    coords: [UPPAL, KOTI],
    name: "Uppal",
    published: true,
    stops: [
      { name: "Uppal X Roads", offset: 0, lat: UPPAL.lat, lng: UPPAL.lng },
      { name: "Koti", offset: 8000, lat: KOTI.lat, lng: KOTI.lng },
    ],
  });
  busId = (
    await db.query<{ id: string }>(`INSERT INTO buses (bus_number) VALUES ('7') RETURNING id`)
  ).rows[0]!.id;
});
afterAll(() => db.close());

describe("learnDeadZones", () => {
  it("learns a recurring zone, labels it after the nearest stop, and classifies a bus inside it", async () => {
    await recurring(UPPAL, 5, 10);
    // noise: one lonely outage elsewhere, a phone that died (closed by trip end), a 40-minute one
    await outage(await trip(9), offsetPoint(KOTI, 3000, 0), 9);
    const ended = await trip(8, "running");
    await outage(ended, offsetPoint(KOTI, 50, 0), 8, { recovered: false });
    await outage(await trip(7), offsetPoint(KOTI, 60, 90), 7, { durationS: 2400 });

    const r = await learnDeadZones(db, NOW);
    expect(r.clusters).toBe(1);
    expect(r.inserted).toHaveLength(1);
    const z = await db.query(
      `SELECT label, sample_count, avg_outage_s, p90_outage_s, confidence, route_lineage_id,
              retired_at FROM dead_zones WHERE id = $1`,
      r.inserted,
    );
    expect(z.rows[0]).toMatchObject({
      label: "Uppal X Roads",
      sample_count: 5,
      avg_outage_s: 100,
      p90_outage_s: 120,
      route_lineage_id: route.lineageId,
      retired_at: null,
    });
    expect(Number(z.rows[0]!.confidence)).toBeGreaterThan(0.9);

    const hit = await classifyDeadZone(db, offsetPoint(UPPAL, 40, 200), route.lineageId);
    expect(hit).toEqual({ id: r.inserted[0], label: "Uppal X Roads", avgOutageS: 100 });
    expect(await classifyDeadZone(db, KOTI, route.lineageId)).toBeNull();
    await db.query(`UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1`, [
      ended,
    ]);
  });

  it("an outage closed by its trip's end is never an observation (0009 trigger)", async () => {
    const t = await trip(3, "running");
    await outage(t, UPPAL, 3, { recovered: false });
    await db.query(`UPDATE signal_outages SET recovered_at = NULL WHERE trip_id = $1`, [t]);
    await db.query(`UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1`, [t]);
    const o = await db.query<{ closed: boolean; exit: boolean }>(
      `SELECT recovered_at IS NOT NULL AS closed, exit_point IS NOT NULL AS exit
         FROM signal_outages WHERE trip_id = $1`,
      [t],
    );
    expect(o.rows[0]).toEqual({ closed: true, exit: false });
  });

  it("is idempotent, keeps the zone's id and an admin's label across runs", async () => {
    const before = await db.query<{ id: string }>(
      `SELECT id FROM dead_zones WHERE retired_at IS NULL`,
    );
    await db.query(`UPDATE dead_zones SET label = 'Uppal flyover underpass'`);
    const again = await learnDeadZones(db, NOW + 3600_000);
    expect(again.inserted).toEqual([]);
    expect(again.updated).toEqual(before.rows.map((r) => r.id));
    expect(again.retired).toEqual([]);
    const label = await db.query(`SELECT label FROM dead_zones WHERE id = $1`, [
      before.rows[0]!.id,
    ]);
    expect(label.rows[0]!.label).toBe("Uppal flyover underpass");
  });

  it("retires a zone with no support left in the window, and never touches a hand-drawn one", async () => {
    await db.query(
      `INSERT INTO dead_zones (polygon, sample_count, avg_outage_s, p90_outage_s, confidence,
                               last_observed_at, label)
       VALUES (ST_GeogFromText($1), 1, 60, 60, 1, now(), 'drawn by the TD')`,
      [ringWkt([KOTI, offsetPoint(KOTI, 100, 0), offsetPoint(KOTI, 100, 90), KOTI])],
    );
    // 70 days later every Uppal outage is outside the 60-day window
    const later = await learnDeadZones(db, NOW + 70 * DAY);
    expect(later.clusters).toBe(0);
    expect(later.retired).toHaveLength(1);
    expect(await classifyDeadZone(db, UPPAL, route.lineageId)).toBeNull();
    const drawn = await db.query(
      `SELECT retired_at FROM dead_zones WHERE label = 'drawn by the TD'`,
    );
    expect(drawn.rows[0]!.retired_at).toBeNull();
    // history keeps pointing at the retired zone
    const kept = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM dead_zones`);
    expect(kept.rows[0]!.n).toBe(2);
  });

  it("a retired zone that recurs comes back as a new zone, not a resurrected one", async () => {
    await recurring(offsetPoint(UPPAL, 20, 0), 4, -65); // days 65..68 after NOW
    const r = await learnDeadZones(db, NOW + 70 * DAY);
    expect(r.inserted).toHaveLength(1);
    expect(r.updated).toEqual([]);
  });

  it("the metrics views expose aggregates only", async () => {
    const zones = await db.query(`SELECT * FROM obs_dead_zones`);
    expect(zones.rows.length).toBeGreaterThan(0);
    expect(Object.keys(zones.rows[0]!)).not.toContain("entry_point");
    const out = await db.query<{ outages: number }>(
      `SELECT sum(outages)::int AS outages FROM obs_signal_outages`,
    );
    expect(out.rows[0]!.outages).toBeGreaterThan(10);
  });
});

describe("clusterOutages and scheduling", () => {
  const o = (i: number, trip: string, p: LatLng): Outage => ({
    ...p,
    id: `o${i}`,
    tripId: trip,
    lineageId: i % 2 ? "L1" : "L2",
    durationS: 60,
    startedAt: `2026-10-0${1 + (i % 3)}T01:00:00.000Z`,
    day: `2026-10-0${1 + (i % 3)}`,
  });

  it("one trip stuttering four times is not a zone; two routes through one zone apply to any route", () => {
    const same = [0, 1, 2, 3].map((i) => o(i, "t1", offsetPoint(UPPAL, i * 10, 0)));
    expect(clusterOutages(same)).toEqual([]);
    const mixed = [0, 1, 2, 3].map((i) => o(i, `t${i}`, offsetPoint(UPPAL, i * 10, 0)));
    const [c] = clusterOutages(mixed);
    expect(c!.lineageId).toBeNull();
    expect(c!.days).toBe(3);
  });

  it("the nightly run is due once per IST day, after 02:30 IST", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(nightlyDue(at("2026-10-19T20:59:00Z"), null)).toEqual({ due: false, day: "2026-10-20" });
    expect(nightlyDue(at("2026-10-19T21:00:00Z"), null)).toEqual({ due: true, day: "2026-10-20" });
    expect(nightlyDue(at("2026-10-20T08:00:00Z"), "2026-10-20").due).toBe(false);
  });
});
