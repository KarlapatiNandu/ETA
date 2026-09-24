import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SurveyPoint } from "@busmitra/contracts";
import { createTestDb, seedTracker, type TestDb } from "@busmitra/db/testing";
import {
  buildRoute,
  haversine,
  offsetPoint,
  pointAtOffset,
  projectPointOnSegment,
  type LatLng,
} from "@busmitra/geo";
import { createOsrm, type Osrm } from "../osrm.ts";
import { matchSurvey, matchTrace, prepareTrace } from "./survey.ts";

/**
 * A stand-in for OSRM that "matches" by projecting onto a known road — exact, so the tests
 * pin down the pipeline's chunking and stitching rather than OSRM's behaviour.
 */
function fakeOsrm(road: LatLng[], calls: number[] = []): Osrm {
  const route = buildRoute(road);
  return {
    async match(points) {
      calls.push(points.length);
      if (points.length > 100) throw new Error("too many coordinates"); // OSRM's default cap
      const snapped = points.map((p) => {
        let best = { d: Infinity, s: 0 };
        for (let i = 0; i < road.length - 1; i++) {
          const pr = projectPointOnSegment(p, road[i]!, road[i + 1]!);
          if (pr.distance < best.d) best = { d: pr.distance, s: route.cum[i]! + pr.along };
        }
        return best;
      });
      const from = snapped[0]!.s;
      const to = snapped[snapped.length - 1]!.s;
      const geometry = [pointAtOffset(route, from)];
      road.forEach((v, i) => {
        if (route.cum[i]! > from && route.cum[i]! < to) geometry.push(v);
      });
      geometry.push(pointAtOffset(route, to));
      return { matchings: [geometry], tracepoints: snapped.map((s) => pointAtOffset(route, s.s)) };
    },
    async route() {
      throw new Error("not used");
    },
  };
}

// Dilsukhnagar → Koti-ish: an L-shaped 4 km road
const road: LatLng[] = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5047 },
  { lat: 17.3848, lng: 78.5047 },
];

/** A 1 Hz survey along `road` at 30 km/h with ±6 m noise, like a phone on a dashboard. */
function survey(line: LatLng[], seconds?: number): SurveyPoint[] {
  const r = buildRoute(line);
  const n = seconds ?? Math.floor(r.total / (30 / 3.6));
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: n }, (_, i) => {
    const p = offsetPoint(pointAtOffset(r, (i * 30) / 3.6), rnd() * 6, rnd() * 360);
    return { t: new Date(Date.UTC(2026, 8, 22, 2) + i * 1000).toISOString(), ...p, accuracy_m: 8 };
  });
}

describe("prepareTrace", () => {
  it("drops bad fixes, simplifies, and never leaves a gap longer than 250 m", () => {
    const pts = survey(road);
    pts[100] = { ...pts[100]!, accuracy_m: 120 };
    const out = prepareTrace(pts);
    expect(out.length).toBeLessThan(pts.length / 5);
    for (let i = 1; i < out.length; i++) expect(haversine(out[i - 1]!, out[i]!)).toBeLessThan(260);
    expect(out.every((p, i) => i === 0 || p.t > out[i - 1]!.t)).toBe(true);
  });
});

describe("matchTrace", () => {
  it("chunks to ≤80 points per OSRM call and stitches a line the length of the road", async () => {
    const calls: number[] = [];
    // a 45-minute survey's worth of points on a long road, to force many chunks
    const long: LatLng[] = [road[0]!, { lat: 17.3688, lng: 78.3047 }];
    const { line, report } = await matchTrace(fakeOsrm(long, calls), survey(long, 2700));
    expect(Math.max(...calls)).toBeLessThanOrEqual(80);
    expect(report.chunks).toBe(calls.length);
    expect(report.chunks).toBeGreaterThan(1);
    expect(report.gaps).toBe(0);
    expect(report.matchedPct).toBe(100);
    // the survey covers 2700 s at 30 km/h = 22.5 km of the road
    expect(report.lengthM).toBeGreaterThan(22_400);
    expect(report.lengthM).toBeLessThan(22_600);
    expect(line.length).toBeLessThan(50); // collinear vertices removed
  });

  it("keeps the corner", async () => {
    const { line } = await matchTrace(fakeOsrm(road), survey(road));
    expect(line.some((p) => haversine(p, road[1]!) < 5)).toBe(true);
  });

  it("refuses a survey with nothing usable in it", async () => {
    const pts = survey(road).map((p) => ({ ...p, accuracy_m: 500 }));
    await expect(matchTrace(fakeOsrm(road), pts)).rejects.toThrow(/usable/);
  });
});

describe("matchSurvey → draft route", () => {
  let db: TestDb;
  let surveyId: string;
  const files = new Map<string, string>();

  beforeAll(async () => {
    db = await createTestDb();
    const { trackerId, busId } = await seedTracker(db, {
      busNumber: "14",
      deviceUid: "phone-14",
      secret: "s",
      key: "k".repeat(32),
    });
    files.set("surveys/a.json", JSON.stringify({ points: survey(road) }));
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO route_surveys (tracker_id, bus_id, started_at, ended_at, point_count, file_path)
       VALUES ($1, $2, now(), now(), 480, 'surveys/a.json') RETURNING id`,
      [trackerId, busId],
    );
    surveyId = rows[0]!.id;
  });
  afterAll(() => db.close());

  const deps = () => ({ osrm: fakeOsrm(road), readTrace: async (p: string) => files.get(p)! });

  it("creates a draft with a fresh lineage and records the report on the survey", async () => {
    const out = await matchSurvey(db, deps(), surveyId, { name: "Route 14", direction: "inbound" });
    const { rows } = await db.query<{ version: number; published_at: Date | null; total: number }>(
      `SELECT version, published_at, total_distance_m AS total FROM routes WHERE id = $1`,
      [out.routeId],
    );
    expect(rows[0]).toMatchObject({ version: 1, published_at: null });
    expect(rows[0]!.total).toBeCloseTo(out.report.lengthM, -1);
    const s = await db.query<{ status: string; route_id: string }>(
      `SELECT status, route_id FROM route_surveys WHERE id = $1`,
      [surveyId],
    );
    expect(s.rows[0]).toEqual({ status: "matched", route_id: out.routeId });
  });

  it("a re-survey inherits the lineage and becomes the next version", async () => {
    const first = await db.query<{ lineage_id: string }>(
      `SELECT lineage_id FROM routes WHERE name = 'Route 14'`,
    );
    const lineage = first.rows[0]!.lineage_id;
    const out = await matchSurvey(db, deps(), surveyId, {
      name: "Route 14",
      direction: "inbound",
      lineageId: lineage,
    });
    const { rows } = await db.query<{ lineage_id: string; version: number }>(
      `SELECT lineage_id, version FROM routes WHERE id = $1`,
      [out.routeId],
    );
    expect(rows[0]).toEqual({ lineage_id: lineage, version: 2 });
  });

  it("refuses unknown and discarded surveys", async () => {
    await expect(
      matchSurvey(db, deps(), "00000000-0000-4000-8000-000000000000", {
        name: "x",
        direction: "inbound",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await db.query(`UPDATE route_surveys SET status = 'discarded' WHERE id = $1`, [surveyId]);
    await expect(
      matchSurvey(db, deps(), surveyId, { name: "y", direction: "inbound" }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

/** Against the real self-hosted OSRM (Hyderabad extract) when it is running; skipped otherwise. */
const OSRM_URL = process.env.OSRM_CAR_URL ?? "http://127.0.0.1:5000";
const osrmUp = await fetch(`${OSRM_URL}/route/v1/driving/78.5247,17.3688;78.5301,17.3702`, {
  // generous: this probe decides whether the suite runs at all, and a busy machine (a load
  // run in the background) must not turn "OSRM is up" into "skip the integration test"
  signal: AbortSignal.timeout(10_000),
})
  .then((r) => r.ok)
  .catch(() => false);

describe.skipIf(!osrmUp)("the pipeline against real OSRM", () => {
  it("matches a noisy 1 Hz trace of a real road back onto that road", async () => {
    const osrm = createOsrm(OSRM_URL, { timeoutMs: 30_000 });
    // ground truth: OSRM's own route Dilsukhnagar → Malakpet, then a phone "drives" it
    const truth = await osrm.route([
      { lat: 17.3688, lng: 78.5247 },
      { lat: 17.373, lng: 78.5 },
    ]);
    const { line, report } = await matchTrace(osrm, survey(truth.line));
    expect(report.matchedPct).toBeGreaterThan(90);
    expect(report.gaps).toBe(0);
    // same road: the matched length is within 3% of the true route length
    expect(Math.abs(report.lengthM - truth.distanceM) / truth.distanceM).toBeLessThan(0.03);
    // and every matched vertex lies on (within 15 m of) the true route
    const truthRoute = buildRoute(truth.line);
    for (const p of line) {
      let d = Infinity;
      for (let i = 0; i < truthRoute.coords.length - 1; i++) {
        d = Math.min(
          d,
          projectPointOnSegment(p, truthRoute.coords[i]!, truthRoute.coords[i + 1]!).distance,
        );
      }
      expect(d).toBeLessThan(15);
    }
  });
});
