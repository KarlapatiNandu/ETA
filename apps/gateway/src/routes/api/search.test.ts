import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StopSearchResponse } from "@busmitra/contracts";
import { seedRoute, seedStudent, seedTracker, seedTrip } from "@busmitra/db/testing";
import { writeFleetIfNewer } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { createTestGateway, TRACKER_KEY } from "../../testing.ts";

/**
 * BUILD_PLAN Stage 5 exits, the deterministic half:
 *  - "Fuzzy search returns correct stops for 20 hand-written misspellings"
 *  - "Area search ('Dilsukhnagar') returns all stops within 2 km with serving buses"
 * plus the running / passed / scheduled / not-running-today rendering.
 *
 * The stops are real Hyderabad places at their real positions (synthetic data only in the
 * repo — these are public localities, not people).
 */

const live = await redisAvailable();

// [name, aliases, area, lat, lng]
const STOPS: [string, string[], string, number, number][] = [
  ["Dilsukhnagar Bus Stop", ["DSNR", "Dilsukh Nagar"], "Dilsukhnagar", 17.3688, 78.5247],
  ["Kothapet", [], "Kothapet", 17.3683, 78.5421],
  ["Chaitanyapuri", [], "Chaitanyapuri", 17.3715, 78.5384],
  ["Moosarambagh", [], "Malakpet", 17.3705, 78.5087],
  ["Victoria Memorial", [], "Kothapet", 17.3656, 78.5486],
  ["LB Nagar X Roads", ["LB Nagar"], "LB Nagar", 17.3457, 78.5522],
  ["Malakpet", [], "Malakpet", 17.3747, 78.4979],
  ["Koti", ["Koti Women's College"], "Koti", 17.385, 78.4867],
  ["Mehdipatnam", ["Mehdipatnam Rythu Bazar"], "Mehdipatnam", 17.3959, 78.4376],
  ["Tolichowki", [], "Tolichowki", 17.4, 78.418],
  ["Secunderabad Station", ["Secunderabad"], "Secunderabad", 17.4337, 78.5016],
  ["Ameerpet", [], "Ameerpet", 17.4375, 78.4482],
  ["Punjagutta", [], "Punjagutta", 17.426, 78.451],
  ["Begumpet", [], "Begumpet", 17.444, 78.462],
  ["Uppal X Roads", ["Uppal"], "Uppal", 17.401, 78.56],
  ["Habsiguda", [], "Habsiguda", 17.419, 78.542],
  ["Tarnaka", [], "Tarnaka", 17.428, 78.531],
  ["Kukatpally", ["KPHB"], "Kukatpally", 17.4849, 78.4138],
  ["Kondapur", [], "Kondapur", 17.469, 78.357],
  ["Kokapet", [], "Kokapet", 17.396, 78.339],
  ["Gachibowli", [], "Gachibowli", 17.4401, 78.3489],
  ["Lakdikapul", [], "Lakdikapul", 17.404, 78.465],
  ["CBIT Campus", ["CBIT", "Gandipet"], "Gandipet", 17.392, 78.319],
];

// 20 misspellings, as typed on a phone in a hurry → the stop that must come first
const MISSPELLINGS: [string, string][] = [
  ["dilsuknagar", "Dilsukhnagar Bus Stop"],
  ["dilshuknagar", "Dilsukhnagar Bus Stop"],
  ["dsnr", "Dilsukhnagar Bus Stop"],
  ["kothapeta", "Kothapet"],
  ["chaitanyapur", "Chaitanyapuri"],
  ["musarambagh", "Moosarambagh"],
  ["malakpeth", "Malakpet"],
  ["kothi", "Koti"],
  ["mehdipatnum", "Mehdipatnam"],
  ["mehdipatanam", "Mehdipatnam"],
  ["tolichowky", "Tolichowki"],
  ["secundrabad", "Secunderabad Station"],
  ["amirpet", "Ameerpet"],
  ["panjagutta", "Punjagutta"],
  ["begampet", "Begumpet"],
  ["upal x roads", "Uppal X Roads"],
  ["habsiguda", "Habsiguda"],
  ["tarnaka", "Tarnaka"],
  ["kukatpaly", "Kukatpally"],
  ["gachibowly", "Gachibowli"],
];

describe.skipIf(!live)("stop search (Stage 5)", () => {
  let t: TestRedis;
  let gw: Awaited<ReturnType<typeof createTestGateway>>;
  let token: string;
  const stopId = new Map<string, string>();
  let route: { routeId: string; lineageId: string };
  let buses: { running: string; passed: string; scheduled: string; idle: string };
  let trips: { running: string; passed: string };
  const geocoded: string[] = [];

  const search = async (q: string) => {
    const res = await gw.app.inject({
      url: `/v1/search/stops?q=${encodeURIComponent(q)}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as StopSearchResponse;
  };

  beforeAll(async () => {
    t = await createTestRedis();
    gw = await createTestGateway({
      redis: t,
      geocoder: {
        async geocode(q) {
          geocoded.push(q);
          // Photon's answer for a locality that is not a stop name
          if (/saroornagar/i.test(q)) return { label: "Saroornagar", lat: 17.3667, lng: 78.538 };
          return null;
        },
      },
    });
    token = await gw.tokenFor((await seedStudent(gw.db, { rollNo: "160125737401" })).userId!);
    // one long route through every stop (the order does not matter to search)
    const coords = STOPS.map(([, , , lat, lng]) => ({ lat, lng }));
    const r = await seedRoute(gw.db, {
      coords,
      published: false, // published below, once its timetable offset is set (stops freeze on publish)
      stops: STOPS.map(([name, , , lat, lng], i) => ({ name, offset: i * 1000, lat, lng })),
    });
    route = r;
    for (const [i, [name, aliases, area]] of STOPS.entries()) {
      stopId.set(name, r.stopIds[i]!);
      await gw.db.query(`UPDATE stops SET aliases = $2, area_name = $3 WHERE id = $1`, [
        r.stopIds[i],
        aliases,
        area,
      ]);
    }
    // an unserved stop: it exists, but no published route stops there
    await gw.db.query(
      `INSERT INTO stops (name, area_name, location) VALUES ('Dilsukhnagar Depot', 'Dilsukhnagar', ST_MakePoint(78.5250, 17.3690)::geography)`,
    );
    const mk = async (n: string) =>
      (
        await seedTracker(gw.db, {
          busNumber: n,
          deviceUid: `d-${n}`,
          secret: "s",
          key: TRACKER_KEY,
        })
      ).busId;
    buses = {
      running: await mk("14"),
      passed: await mk("9"),
      scheduled: await mk("22"),
      idle: await mk("27"),
    };
    await gw.db.query(`UPDATE buses SET default_route_id = $1`, [r.routeId]);
    trips = {
      running: await seedTrip(gw.db, { busId: buses.running, routeId: r.routeId }),
      passed: await seedTrip(gw.db, { busId: buses.passed, routeId: r.routeId }),
    };
    await gw.db.query(
      `INSERT INTO trips (bus_id, route_id, service_date, shift, status, scheduled_start_at)
       VALUES ($1, $2, operating_date(), 'morning', 'scheduled', '2026-09-23 02:00:00+00')`,
      [buses.scheduled, r.routeId],
    );
    await gw.db.query(
      `UPDATE route_stops SET scheduled_offset_s = 600 WHERE route_id = $1 AND seq = 1`,
      [r.routeId],
    );
    await gw.db.query(`UPDATE routes SET published_at = now() WHERE id = $1`, [r.routeId]);
    const fleet = (tripId: string, seq: number) => ({
      lat: 17.36,
      lng: 78.5,
      spd: 20,
      hdg: 90,
      s: 10,
      seq,
      tripId,
      routeId: r.routeId,
      ts: new Date().toISOString(),
      state: "LIVE" as const,
      cadence: 5,
    });
    // bus 14 is before the first stop, with an ETA; bus 9 is already past it
    await writeFleetIfNewer(t.redis, t.keys, buses.running, fleet(trips.running, -1));
    await writeFleetIfNewer(t.redis, t.keys, buses.passed, fleet(trips.passed, 3));
    await t.redis.hset(
      t.keys.tripEta(trips.running),
      stopId.get("Dilsukhnagar Bus Stop")!,
      JSON.stringify({ p50: 360, p90: 480, confidence: "low", at: new Date().toISOString() }),
    );
  });
  afterAll(async () => {
    await gw.app.close();
    await gw.db.close();
    await t.close();
  });

  it("finds the right stop first for 20 hand-written misspellings", async () => {
    const wrong: string[] = [];
    for (const [q, want] of MISSPELLINGS) {
      const r = await search(q);
      if (r.results[0]?.name !== want)
        wrong.push(`${q} → ${r.results[0]?.name ?? "nothing"} (wanted ${want})`);
    }
    expect(wrong).toEqual([]);
  });

  it("an exact phonetic match does not drag in weak look-alikes from across the city", async () => {
    const names = (await search("kothi")).results.map((x) => x.name);
    expect(names[0]).toBe("Koti");
    expect(names).not.toContain("Kondapur");
    expect(names).not.toContain("Kokapet");
  });

  it("area search: every served stop within 2 km of Dilsukhnagar, nothing further, never an unserved one", async () => {
    const r = await search("Dilsukhnagar");
    expect(r.anchor).toMatchObject({ source: "stop" });
    const names = r.results.map((x) => x.name);
    // the truth, from PostGIS directly
    const truth = await gw.db.query<{ name: string }>(
      `SELECT s.name FROM stops s JOIN route_stops rs ON rs.stop_id = s.id
        WHERE rs.route_id = $1 AND ST_DWithin(s.location, ST_MakePoint(78.5247, 17.3688)::geography, 2000)`,
      [route.routeId],
    );
    expect(new Set(names)).toEqual(new Set(truth.rows.map((x) => x.name)));
    expect(names).not.toContain("Dilsukhnagar Depot");
    expect(names).not.toContain("LB Nagar X Roads"); // 2.9 km: outside
    for (const x of r.results) {
      if (x.match === "nearby") expect(x.distanceM).toBeLessThanOrEqual(2000);
      expect(x.buses.length).toBeGreaterThan(0); // every result says which buses serve it
    }
  });

  it("falls back to the geocoder for a place that is not a stop, and searches around it", async () => {
    const r = await search("saroornagar");
    expect(geocoded).toContain("saroornagar");
    expect(r.anchor).toMatchObject({ source: "geocoder", label: "Saroornagar" });
    expect(r.results.map((x) => x.name)).toEqual(
      expect.arrayContaining(["Kothapet", "Chaitanyapuri", "Victoria Memorial"]),
    );
  });

  it("renders each bus as running (with a live ETA), passed, scheduled or not running today", async () => {
    const r = await search("dilsukhnagar bus stop");
    const stop = r.results[0]!;
    expect(stop.name).toBe("Dilsukhnagar Bus Stop");
    const by = Object.fromEntries(stop.buses.map((b) => [b.number, b]));
    expect(by["14"]).toMatchObject({
      status: "running",
      presence: "LIVE",
      eta: { p50: 360, p90: 480 },
    });
    expect(by["9"]).toMatchObject({ status: "passed", eta: null });
    expect(by["22"]).toMatchObject({
      status: "scheduled",
      scheduledAt: "2026-09-23T02:10:00.000Z",
    });
    expect(by["27"]).toMatchObject({ status: "not_running", tripId: null });
    expect(stop.buses.map((b) => b.number)).toEqual(["14", "22", "9", "27"]);
  });

  it("caches the matching for five minutes but joins the buses fresh", async () => {
    await search("tarnaka");
    const keys = await t.redis.keys(`${t.keys.ns}search:stops:*`);
    expect(keys.length).toBeGreaterThan(0);
    expect(await t.redis.ttl(keys[0]!)).toBeGreaterThan(290);
    // the ETA changes; the cached search still shows the new one
    await t.redis.hset(
      t.keys.tripEta(trips.running),
      stopId.get("Dilsukhnagar Bus Stop")!,
      JSON.stringify({ p50: 120, p90: 200, confidence: "low", at: new Date().toISOString() }),
    );
    const again = await search("dilsukhnagar bus stop");
    expect(again.results[0]!.buses[0]!.eta!.p50).toBe(120);
  });

  it("requires a signed-in student", async () => {
    const res = await gw.app.inject({ url: "/v1/search/stops?q=koti" });
    expect(res.statusCode).toBe(401);
  });

  it("stop detail: the stop, its buses, and no walk without a home pin", async () => {
    const res = await gw.app.inject({
      url: `/v1/stops/${stopId.get("Koti")}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "Koti", walk: null });
    const missing = await gw.app.inject({
      url: `/v1/stops/00000000-0000-4000-8000-000000000000`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});
