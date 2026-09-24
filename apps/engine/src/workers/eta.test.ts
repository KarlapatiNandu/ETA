import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SseEvent } from "@busmitra/contracts";
import {
  createTestDb,
  seedRoute,
  seedStudent,
  seedTracker,
  seedTrip,
  type TestDb,
} from "@busmitra/db/testing";
import { buildRoute, pointAtOffset, type LatLng } from "@busmitra/geo";
import { writeFleetIfNewer, type FleetEntry } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { RouteCache } from "../lib/route-cache.ts";
import { HistoryCache, istBucket, osrmSegmentSpeeds } from "../lib/speed-model.ts";
import type { Osrm } from "../osrm.ts";
import { travelTime } from "../walk.ts";
import { EtaMemory, MATERIAL_CHANGE_S, processEtaEntries, processEvent } from "./eta.ts";
import { shouldLeave, tickOnce } from "./leave-now.ts";
import { writeStopEvents } from "./stop-events.ts";

/**
 * BUILD_PLAN Stage 5: the per-stop ETA engine (ARCH §5.5), the leave-now evaluator (§5.6),
 * walking ETAs and the predicted-vs-actual log.
 */

describe("istBucket", () => {
  it("buckets on IST, not UTC or the machine's zone", () => {
    // 2026-09-23 02:12 UTC = 07:42 IST, a Wednesday → bucket 7*4 + 2 = 30
    expect(istBucket(Date.parse("2026-09-23T02:12:00Z"))).toEqual({ weekday: 3, tod: 30 });
    // 19:00 UTC Saturday = 00:30 IST Sunday
    expect(istBucket(Date.parse("2026-09-26T19:00:00Z"))).toEqual({ weekday: 0, tod: 2 });
  });
});

describe("shouldLeave (ARCH §5.6)", () => {
  it("fires when the bus is as close as the walk plus the buffer plus the ETA spread", () => {
    const base = { travelTimeS: 420, bufferS: 180, p90MinusP50S: 120 };
    expect(shouldLeave({ ...base, remainingP50S: 721 })).toBe(false);
    expect(shouldLeave({ ...base, remainingP50S: 720 })).toBe(true);
  });

  it("a noisier ETA (wider p90) fires earlier, never later", () => {
    const tight = { travelTimeS: 420, bufferS: 180, remainingP50S: 700, p90MinusP50S: 60 };
    expect(shouldLeave(tight)).toBe(false);
    expect(shouldLeave({ ...tight, p90MinusP50S: 100 })).toBe(true);
    expect(shouldLeave({ ...tight, p90MinusP50S: -50 })).toBe(false); // never shrinks the buffer
  });
});

const live = await redisAvailable();
// 6 km due east, stops at 0, 2, 4, 6 km
const line: LatLng[] = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5812 },
];
const route = buildRoute(line);
const T0 = Date.parse("2026-09-23T02:00:00.000Z");

describe.skipIf(!live)("ETA engine, leave-now, walking ETA (Stage 5)", () => {
  let db: TestDb;
  let t: TestRedis;
  let routes: RouteCache;
  let history: HistoryCache;
  let ids: { routeId: string; lineageId: string; busId: string; tripId: string; stopIds: string[] };
  let student: string;
  const osrmCalls: number[] = [];
  // free-flow 36 km/h everywhere: 200 m legs of 20 s
  const osrm: Osrm = {
    async match() {
      throw new Error("unused");
    },
    async route(points) {
      osrmCalls.push(points.length);
      const legs = points.slice(1).map(() => ({ distanceM: 200, durationS: 20 }));
      return {
        line: [...points],
        distanceM: 200 * legs.length,
        durationS: 20 * legs.length,
        waypoints: [...points],
        legs,
      };
    },
  };
  const deps = () => ({ redis: t.redis, keys: t.keys, routes, history, db, osrm });
  const position = (s: number, at: number, extra: Record<string, unknown> = {}): SseEvent => ({
    type: "bus.position",
    data: {
      id: ids.busId,
      ...pointAtOffset(route, s),
      spd: 36,
      hdg: 90,
      s,
      ts: new Date(at).toISOString(),
      tripId: ids.tripId,
      routeId: ids.routeId,
      seq: 0,
      cadence: 5,
      flag: null,
      ...extra,
    },
  });

  beforeAll(async () => {
    db = await createTestDb();
    t = await createTestRedis();
    routes = new RouteCache(db, t.redis, t.keys);
    history = new HistoryCache(db, 0);
    const r = await seedRoute(db, {
      coords: line,
      published: true,
      stops: [0, 2000, 4000, route.total - 1].map((offset, i) => ({
        name: `E${i + 1}`,
        offset,
        ...pointAtOffset(route, offset),
      })),
    });
    const tr = await seedTracker(db, {
      busNumber: "61",
      deviceUid: "d-61",
      secret: "s",
      key: "k".repeat(32),
    });
    ids = {
      routeId: r.routeId,
      lineageId: r.lineageId,
      busId: tr.busId,
      stopIds: r.stopIds,
      tripId: await seedTrip(db, { busId: tr.busId, routeId: r.routeId }),
    };
    student = (await seedStudent(db, { rollNo: "160125737301" })).userId!;
    await t.redis.set(t.keys.busEwma(ids.busId), "36");
  });
  afterAll(async () => {
    await t.close();
    await db.close();
  });

  it("caches OSRM free-flow speeds per route: one call per version, then Redis", async () => {
    const loaded = (await routes.get(ids.routeId))!;
    const a = await osrmSegmentSpeeds(loaded.route, ids.routeId, {
      redis: t.redis,
      keys: t.keys,
      osrm,
    });
    expect(a).toHaveLength(Math.ceil(route.total / 200));
    expect(a[0]).toBeCloseTo(36, 3);
    const calls = osrmCalls.length;
    await osrmSegmentSpeeds(loaded.route, ids.routeId, { redis: t.redis, keys: t.keys, osrm });
    expect(osrmCalls.length).toBe(calls);
  });

  it("computes a range to every stop ahead, cold start, and writes trip:{id}:eta", async () => {
    const mem = new EtaMemory();
    const frames = await processEvent(deps(), mem, position(1000, T0));
    expect(frames.map((f) => f.stopId)).toEqual(ids.stopIds.slice(1));
    const hash = await t.redis.hgetall(t.keys.tripEta(ids.tripId));
    const toStop2 = JSON.parse(hash[ids.stopIds[1]!]!) as {
      p50: number;
      p90: number;
      confidence: string;
    };
    // 1 km at 36 km/h (cold blend of OSRM 36 and live 36) = 100 s; p90 wider; no history → low
    expect(toStop2.p50).toBeCloseTo(100, -1);
    expect(toStop2.p90).toBeGreaterThan(toStop2.p50);
    expect(toStop2.confidence).toBe("low");
    // stop 3 adds the 30 s default dwell at stop 2
    const toStop3 = JSON.parse(hash[ids.stopIds[2]!]!) as { p50: number };
    expect(toStop3.p50).toBeCloseTo(300 + 30, -1);
  });

  it("announces only material changes (> 30 s against the countdown)", async () => {
    const mem = new EtaMemory();
    await processEvent(deps(), mem, position(1000, T0));
    // 5 s later, 50 m further on: the countdown already said so
    expect(await processEvent(deps(), mem, position(1050, T0 + 5000))).toEqual([]);
    // the bus stalls for a minute: every stop is now > 30 s later than the countdown expected
    await t.redis.set(t.keys.busEwma(ids.busId), "6");
    const late = await processEvent(deps(), mem, position(1060, T0 + 65_000, { spd: 0 }));
    expect(late.length).toBeGreaterThan(0);
    expect(MATERIAL_CHANGE_S).toBe(30);
    await t.redis.set(t.keys.busEwma(ids.busId), "36");
  });

  it("uses learned history when a rung has ≥ 5 samples, and says so in confidence", async () => {
    const { weekday, tod } = istBucket(T0);
    for (let seg = 0; seg < 31; seg++) {
      await db.query(
        `INSERT INTO segment_speeds (route_lineage_id, segment_idx, weekday, tod_bucket, median_kmh, p10_kmh, p90_kmh, sample_count)
         VALUES ($1, $2, $3, $4, 18, 12, 24, 9)`,
        [ids.lineageId, seg, weekday, tod],
      );
    }
    const mem = new EtaMemory();
    // (the previous test left a later fix behind: this one is older, as a replay would be)
    await processEvent(deps(), mem, position(1000, T0));
    const toStop2 = JSON.parse(
      (await t.redis.hget(t.keys.tripEta(ids.tripId), ids.stopIds[1]!))!,
    ) as {
      p50: number;
      confidence: string;
      rung: number;
    };
    // 0.55·18 + 0.35·36 + 0.10·36 = 26.1 km/h over 1 km ≈ 138 s
    expect(toStop2.p50).toBeCloseTo(138, -1);
    expect(toStop2.confidence).toBe("high");
    expect(toStop2.rung).toBe(1);
    await db.query(`DELETE FROM segment_speeds WHERE route_lineage_id = $1`, [ids.lineageId]);
  });

  it("withdraws every ETA when the bus goes off-route, re-snaps, or goes DARK — never fabricates", async () => {
    const mem = new EtaMemory();
    await processEvent(deps(), mem, position(1000, T0));
    const off = await processEvent(
      deps(),
      mem,
      position(1000, T0 + 5000, { s: null, flag: "off_route" }),
    );
    expect(off.every((f) => f.withdrawn)).toBe(true);
    expect(await t.redis.exists(t.keys.tripEta(ids.tripId))).toBe(0);

    await processEvent(deps(), mem, position(1100, T0 + 10_000));
    const resnap = await processEvent(
      deps(),
      mem,
      position(900, T0 + 15_000, { flag: "resnapped" }),
    );
    expect(resnap.length).toBeGreaterThan(0);
    expect(resnap.every((f) => f.withdrawn)).toBe(true);

    await processEvent(deps(), mem, position(1100, T0 + 20_000));
    const dark = await processEvent(deps(), mem, {
      type: "bus.status",
      data: {
        id: ids.busId,
        state: "DARK",
        cadence: 5,
        lastSeenAt: new Date(T0 + 20_000).toISOString(),
        tripId: ids.tripId,
      },
    });
    expect(dark.length).toBe(3);
    expect(await t.redis.exists(t.keys.tripEta(ids.tripId))).toBe(0);
  });

  it("drops a stop from the hash once the bus has passed it", async () => {
    const mem = new EtaMemory();
    await processEvent(deps(), mem, position(1900, T0));
    const after = await processEvent(deps(), mem, position(2150, T0 + 25_000, { seq: 1 }));
    expect(after).toContainEqual(
      expect.objectContaining({ stopId: ids.stopIds[1], withdrawn: true }),
    );
    expect(await t.redis.hexists(t.keys.tripEta(ids.tripId), ids.stopIds[1]!)).toBe(0);
  });

  it("publishes frames on pubsub:eta, not on the replayable stream (invariant 9)", async () => {
    const sub = t.connect();
    const got: string[] = [];
    await sub.subscribe(t.keys.etaChannel);
    sub.on("message", (_c, m) => got.push(m));
    const before = await t.redis.xlen(t.keys.streamEvents);
    await t.redis.del(t.keys.tripEta(ids.tripId));
    await processEtaEntries(deps(), new EtaMemory(), [{ id: "1-1", data: position(500, T0) }]);
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0]!)).toContainEqual(expect.objectContaining({ tripId: ids.tripId }));
    expect(await t.redis.xlen(t.keys.streamEvents)).toBe(before);
  });

  it("logs predictions at the 10-minute horizon, and the stop-events worker fills in the actual", async () => {
    await t.redis.set(t.keys.busEwma(ids.busId), "36");
    const mem = new EtaMemory();
    // ~10 minutes out from the last stop (6 km − 30 s dwell × 2)
    await processEvent(deps(), mem, position(0 + 1, T0));
    const { rows } = await db.query<{ seq: number; horizon_s: number; p50_s: number }>(
      `SELECT seq, horizon_s, p50_s FROM eta_predictions WHERE trip_id = $1 ORDER BY seq`,
      [ids.tripId],
    );
    expect(rows.some((r) => r.horizon_s === 600 && r.p50_s > 540 && r.p50_s <= 600)).toBe(true);
    const logged = rows.find((r) => r.horizon_s === 600)!;
    await writeStopEvents({ db, redis: t.redis, keys: t.keys }, [
      {
        id: "9-9",
        data: {
          type: "stop.reached",
          data: {
            tripId: ids.tripId,
            busId: ids.busId,
            stopId: ids.stopIds[logged.seq - 1],
            seq: logged.seq,
            event: "arrived",
            at: new Date(T0 + (logged.p50_s + 45) * 1000).toISOString(),
          },
        },
      },
    ]);
    const err = await db.query<{ error_s: number }>(
      `SELECT error_s FROM eta_predictions WHERE trip_id = $1 AND seq = $2 AND horizon_s = 600`,
      [ids.tripId, logged.seq],
    );
    expect(err.rows[0]!.error_s).toBe(45);
  });

  describe("leave-now", () => {
    let sub: string;
    const clock = { now: T0 };
    const fleet = (s: number, state: FleetEntry["state"] = "LIVE", seq = 0): FleetEntry => ({
      ...pointAtOffset(route, s),
      spd: 36,
      hdg: 90,
      s,
      seq,
      tripId: ids.tripId,
      routeId: ids.routeId,
      ts: new Date(clock.now).toISOString(),
      state,
      cadence: 5,
    });
    const tick = () => tickOnce({ db, redis: t.redis, keys: t.keys, now: () => clock.now });

    beforeAll(async () => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO trip_subscriptions (user_id, trip_id, target_stop_id, travel_time_s, buffer_s)
         VALUES ($1, $2, $3, 300, 120) RETURNING id`,
        [student, ids.tripId, ids.stopIds[2]],
      );
      sub = r.rows[0]!.id;
    });
    beforeEach(async () => {
      await t.redis.del(t.keys.streamNotify, t.keys.fleetLive);
    });

    const setEta = (p50: number, p90: number, atMs = clock.now) =>
      t.redis.hset(
        t.keys.tripEta(ids.tripId),
        ids.stopIds[2]!,
        JSON.stringify({ p50, p90, confidence: "low", at: new Date(atMs).toISOString() }),
      );

    it("waits while the bus is further than walk + buffer + spread", async () => {
      clock.now = T0 + 1_000_000;
      await writeFleetIfNewer(t.redis, t.keys, ids.busId, fleet(1000));
      await setEta(700, 780); // 700 > 300 + 120 + 80
      const r = await tick();
      expect(r.fired).toEqual([]);
      expect(r.evaluated).toBe(1);
    });

    it("will not fire from a DEGRADED bus or a stale ETA", async () => {
      clock.now += 5000;
      await writeFleetIfNewer(t.redis, t.keys, ids.busId, fleet(1200, "DEGRADED"));
      await setEta(400, 480);
      expect((await tick()).waiting).toContainEqual(
        expect.objectContaining({ reason: "bus DEGRADED" }),
      );
      await t.redis.del(t.keys.fleetLive);
      await writeFleetIfNewer(t.redis, t.keys, ids.busId, fleet(1200));
      await setEta(400, 480, clock.now - 60_000); // computed from a fix a minute old
      expect((await tick()).waiting).toContainEqual(
        expect.objectContaining({ reason: "ETA stale" }),
      );
    });

    it("fires exactly once, to stream:notify, when the bus is close enough", async () => {
      clock.now += 5000;
      await writeFleetIfNewer(t.redis, t.keys, ids.busId, fleet(2500));
      await setEta(480, 560); // 480 ≤ 300 + 120 + 80
      const first = await tick();
      expect(first.fired).toHaveLength(1);
      expect(first.fired[0]).toMatchObject({
        type: "leave_now",
        subscriptionId: sub,
        userId: student,
        etaP50S: 480,
      });
      // a second evaluator, a restart, a replay: the database gate holds
      const second = await tick();
      expect(second.fired).toEqual([]);
      expect(await t.redis.xlen(t.keys.streamNotify)).toBe(1);
      const row = await db.query<{ notified: boolean }>(
        `SELECT notified_departure_at IS NOT NULL AS notified FROM trip_subscriptions WHERE id = $1`,
        [sub],
      );
      expect(row.rows[0]!.notified).toBe(true);
    });

    it("marks a subscription missed when the bus passes the stop first, completed when the trip ends", async () => {
      const other = await seedStudent(db, { rollNo: "160125737302", phone: "+919999900302" });
      const r = await db.query<{ id: string }>(
        `INSERT INTO trip_subscriptions (user_id, trip_id, target_stop_id, travel_time_s)
         VALUES ($1, $2, $3, 300) RETURNING id`,
        [other.userId, ids.tripId, ids.stopIds[1]],
      );
      await writeFleetIfNewer(t.redis, t.keys, ids.busId, fleet(2600, "LIVE", 1));
      expect((await tick()).missed).toBe(1);
      await db.query(`UPDATE trip_subscriptions SET state = 'active' WHERE id = $1`, [
        r.rows[0]!.id,
      ]);
      await db.query(`UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1`, [
        ids.tripId,
      ]);
      expect((await tick()).completed).toBeGreaterThanOrEqual(1);
      await db.query(`UPDATE trips SET status = 'running', ended_at = NULL WHERE id = $1`, [
        ids.tripId,
      ]);
    });
  });

  describe("walking ETA", () => {
    it("is null without a pin, then computed once and served from the cache", async () => {
      const foot: Osrm = {
        ...osrm,
        route: async () => ({ line: [], distanceM: 600, durationS: 450, waypoints: [], legs: [] }),
      };
      let calls = 0;
      const counted: Osrm = { ...foot, route: async (p) => (calls++, foot.route(p)) };
      expect(await travelTime({ db, foot: counted }, student, ids.stopIds[0]!)).toBeNull();
      await db.query(
        `UPDATE profiles SET home_location = ST_SetSRID(ST_MakePoint(78.521, 17.371), 4326)::geography WHERE id = $1`,
        [student],
      );
      const a = await travelTime({ db, foot: counted }, student, ids.stopIds[0]!);
      expect(a).toMatchObject({ mode: "foot", durationS: 450, distanceM: 600 });
      await travelTime({ db, foot: counted }, student, ids.stopIds[0]!);
      expect(calls).toBe(1);
    });

    it("rides a bicycle at 15 km/h over the foot route, and recomputes after a mode change", async () => {
      const foot: Osrm = {
        ...osrm,
        route: async () => ({
          line: [],
          distanceM: 1500,
          durationS: 1100,
          waypoints: [],
          legs: [],
        }),
      };
      await db.query(`UPDATE profiles SET travel_mode = 'bicycle' WHERE id = $1`, [student]);
      const b = await travelTime({ db, foot }, student, ids.stopIds[0]!);
      expect(b).toMatchObject({ mode: "bicycle", durationS: 360, distanceM: 1500 });
      await db.query(`UPDATE profiles SET travel_mode = 'foot' WHERE id = $1`, [student]);
    });

    it("says nothing rather than guessing when OSRM is down", async () => {
      await db.query(`UPDATE profiles SET travel_mode = 'car' WHERE id = $1`, [student]);
      const down: Osrm = { ...osrm, route: async () => Promise.reject(new Error("ECONNREFUSED")) };
      expect(await travelTime({ db, car: down }, student, ids.stopIds[1]!)).toBeNull();
      await db.query(`UPDATE profiles SET travel_mode = 'foot' WHERE id = $1`, [student]);
    });
  });
});
