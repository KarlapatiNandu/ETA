import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SseEvent, type StreamPing } from "@busmitra/contracts";
import { createTestDb, seedRoute, seedTracker, seedTrip, type TestDb } from "@busmitra/db/testing";
import { buildRoute, pointAtOffset, type LatLng } from "@busmitra/geo";
import { readFleetEntry, writeFleetIfNewer, type FleetEntry } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { rehydrateFleet } from "../lib/rehydrate.ts";
import { RouteCache } from "../lib/route-cache.ts";
import { presenceAtIngest, processEntries } from "./geo.ts";
import { judgePresence, sweepOnce } from "./presence.ts";
import { writeStopEvents } from "./stop-events.ts";

/**
 * BUILD_PLAN Stage 3: "All four presence states render and transition on real timing, at both
 * the moving and the stationary cadence — a parked bus never goes amber."
 */

const T0 = Date.parse("2026-09-23T02:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const entry = (cadence: number, extra: Partial<FleetEntry> = {}): FleetEntry => ({
  lat: 17.3688,
  lng: 78.53,
  spd: 0,
  hdg: 90,
  s: 500,
  seq: 0,
  tripId: "00000000-0000-4000-8000-000000000001",
  ts: at(0),
  state: "LIVE",
  cadence,
  ...extra,
});

describe("judgePresence (invariant 3: thresholds are multiples of cadence)", () => {
  const states = (cadence: number, ages: number[]) =>
    ages.map((a) => judgePresence(entry(cadence), T0 + a * 1000));

  it("moving bus (5 s): amber at 15 s, red at 45 s, gone 10 minutes after red", () => {
    expect(states(5, [0, 14.9, 15, 44.9, 45, 644.9, 645])).toEqual([
      "LIVE",
      "LIVE",
      "DEGRADED",
      "DEGRADED",
      "DARK",
      "DARK",
      "ENDED",
    ]);
  });

  it("parked bus (15 s): still green at 44 s — the ages that turn a moving bus amber and red", () => {
    expect(states(15, [15, 30, 44.9])).toEqual(["LIVE", "LIVE", "LIVE"]);
    expect(states(15, [45, 134.9, 135, 734.9, 735])).toEqual([
      "DEGRADED",
      "DEGRADED",
      "DARK",
      "DARK",
      "ENDED",
    ]);
  });

  it("an explicit trip end is final; only the sweeper's own timeout is undone by a fresh fix", () => {
    expect(judgePresence(entry(5, { state: "ENDED", flag: "trip_end" }), T0)).toBe("ENDED");
    expect(judgePresence(entry(5, { state: "ENDED", flag: "dark_timeout" }), T0 + 1000)).toBe(
      "LIVE",
    );
  });

  it("treats a missing cadence as 5 s, and a fix from a phone clock ahead of ours as fresh", () => {
    expect(judgePresence(entry(0), T0 + 16_000)).toBe("DEGRADED");
    expect(judgePresence(entry(5), T0 - 30_000)).toBe("LIVE");
  });
});

describe("presenceAtIngest (the geo worker never writes an old fix as LIVE)", () => {
  it("judges a fix by its age when it arrived, in cadence multiples", () => {
    expect(presenceAtIngest(T0, T0 + 3_000, 5)).toBe("LIVE");
    // the first slice of a reconnect flush: the newest fix so far, but two minutes old
    expect(presenceAtIngest(T0, T0 + 120_000, 5)).toBe("DARK");
    expect(presenceAtIngest(T0, T0 + 20_000, 5)).toBe("DEGRADED");
    // at the parked cadence the same 20 s is on time
    expect(presenceAtIngest(T0, T0 + 20_000, 15)).toBe("LIVE");
  });
});

const live = await redisAvailable();
const line: LatLng[] = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5623 },
];
const route = buildRoute(line);

describe.skipIf(!live)("presence sweeper, stop events and rehydration (Stage 3)", () => {
  let db: TestDb;
  let t: TestRedis;
  let routes: RouteCache;
  let ids: { routeId: string; busId: string; tripId: string; stopIds: string[] };
  let clock = T0;
  let seq = 0;

  const ping = (s: number, when: number, extra: Partial<StreamPing> = {}): StreamPing => ({
    kind: "ping",
    trip_id: ids.tripId,
    bus_id: ids.busId,
    route_id: ids.routeId,
    device_uid: "phone-41",
    cadence_s: 5,
    recorded_at: new Date(when).toISOString(),
    ingested_at: new Date(when + 500).toISOString(),
    ...pointAtOffset(route, s),
    speed_kmh: 30,
    heading_deg: 90,
    accuracy_m: 5,
    is_backfill: false,
    ...extra,
  });
  const feed = (...pings: StreamPing[]) =>
    processEntries(
      { redis: t.redis, keys: t.keys, routes },
      pings.map((p) => ({ id: `0-${++seq}`, data: p })),
    );
  const sweep = () => sweepOnce({ redis: t.redis, keys: t.keys, db, routes, now: () => clock });
  const events = async () => {
    const raw = await t.redis.xrange(t.keys.streamEvents, "-", "+");
    return raw.map(([id, f]) => ({ id, ...SseEvent.parse(JSON.parse(f[1]!)) }));
  };

  beforeAll(async () => {
    db = await createTestDb();
    t = await createTestRedis();
    routes = new RouteCache(db, t.redis, t.keys);
    const r = await seedRoute(db, {
      coords: line,
      name: "Presence test",
      published: true,
      stops: [0, 1000, 2000, route.total - 5].map((offset, i) => ({
        name: `P${i + 1}`,
        offset,
        ...pointAtOffset(route, offset),
      })),
    });
    const tr = await seedTracker(db, {
      busNumber: "41",
      deviceUid: "phone-41",
      secret: "s",
      key: "k".repeat(32),
    });
    ids = {
      routeId: r.routeId,
      busId: tr.busId,
      stopIds: r.stopIds,
      tripId: await seedTrip(db, { busId: tr.busId, routeId: r.routeId }),
    };
  });
  afterAll(async () => {
    await t.close();
    await db.close();
  });
  beforeEach(async () => {
    await t.redis.del(t.keys.streamEvents);
  });

  it("publishes positions as bus.position frames, coalesced to the newest per bus", async () => {
    clock = T0 + 20_000;
    const r = await feed(ping(900, T0), ping(950, T0 + 5000), ping(1050, T0 + 10_000));
    expect(r.written).toBe(3);
    const ev = await events();
    const positions = ev.filter((e) => e.type === "bus.position");
    expect(positions).toHaveLength(1);
    expect(positions[0]!.data).toMatchObject({
      id: ids.busId,
      ts: new Date(T0 + 10_000).toISOString(),
      routeId: ids.routeId,
      tripId: ids.tripId,
      cadence: 5,
    });
    // the trip's first fix is 900 m past stop 1: written off as skipped (ARCH §5.4), broadcast
    const reached = ev.filter((e) => e.type === "stop.reached");
    expect(reached.map((e) => e.data)).toEqual([
      expect.objectContaining({ seq: 1, event: "skipped", busId: ids.busId, backfill: false }),
    ]);
  });

  it("writes stop events to trip_stop_events exactly once, however often they are replayed", async () => {
    // ~50 km/h from 1,200 m to past stop 3 at 2,000 m
    const pings = Array.from({ length: 15 }, (_, i) => ping(1200 + i * 70, T0 + 15_000 + i * 5000));
    await feed(...pings);
    const ev = (await t.redis.xrange(t.keys.streamEvents, "-", "+")).map(([id, f]) => ({
      id,
      data: JSON.parse(f[1]!) as unknown,
    }));
    const deps = { db, redis: t.redis, keys: t.keys };
    const first = await writeStopEvents(deps, ev);
    expect(first.written).toBeGreaterThan(0);
    const again = await writeStopEvents(deps, ev);
    expect(again.written).toBe(0);
    expect(again.duplicate).toBe(first.written + first.duplicate);
    const { rows } = await db.query<{ seq: number; event: string; source: string }>(
      `SELECT seq, event, source FROM trip_stop_events WHERE trip_id = $1 ORDER BY seq, event`,
      [ids.tripId],
    );
    expect(rows).toContainEqual({ seq: 2, event: "arrived", source: "crossing" });
    expect(rows).toContainEqual({ seq: 3, event: "arrived", source: "crossing" });
    // a skip, and anything derived from late-flushed pings, is inferred (ARCH §5.7)
    const crafted = (seq: number, event: "skipped" | "departed", backfill: boolean) => ({
      id: `0-${seq}`,
      data: {
        type: "stop.reached",
        data: {
          tripId: ids.tripId,
          busId: ids.busId,
          stopId: ids.stopIds[seq - 1],
          seq,
          event,
          at: new Date(T0).toISOString(),
          backfill,
        },
      },
    });
    await writeStopEvents(deps, [crafted(1, "skipped", false), crafted(4, "departed", true)]);
    const inferred = await db.query<{ seq: number; event: string; source: string }>(
      `SELECT seq, event, source FROM trip_stop_events WHERE trip_id = $1 AND source = 'inferred' ORDER BY seq`,
      [ids.tripId],
    );
    expect(inferred.rows).toEqual([
      { seq: 1, event: "skipped", source: "inferred" },
      { seq: 4, event: "departed", source: "inferred" },
    ]);
  });

  it("a moving bus goes amber at 3× cadence and red at 9×, once each, with an outage row", async () => {
    const last = Date.parse((await readFleetEntry(t.redis, t.keys, ids.busId))!.ts);
    clock = last + 14_000;
    expect((await sweep()).transitions).toEqual([]);
    clock = last + 15_000;
    expect((await sweep()).transitions).toMatchObject([{ to: "DEGRADED", reason: "late" }]);
    expect((await sweep()).transitions).toEqual([]); // no second announcement
    clock = last + 45_000;
    expect((await sweep()).transitions).toMatchObject([{ to: "DARK", reason: "signal_lost" }]);
    const e = (await readFleetEntry(t.redis, t.keys, ids.busId))!;
    expect(e.state).toBe("DARK");
    expect(e.ts).toBe(new Date(last).toISOString()); // frozen at the last known fix, not moved
    const statuses = (await events()).filter((x) => x.type === "bus.status");
    expect(statuses.map((x) => x.data)).toEqual([
      expect.objectContaining({ state: "DEGRADED", lastSeenAt: new Date(last).toISOString() }),
      expect.objectContaining({ state: "DARK", reason: "signal_lost" }),
    ]);
    const outage = await db.query<{ started_at: Date; recovered_at: Date | null }>(
      `SELECT started_at, recovered_at FROM signal_outages WHERE trip_id = $1`,
      [ids.tripId],
    );
    expect(outage.rows).toHaveLength(1);
    expect(new Date(outage.rows[0]!.started_at).getTime()).toBe(last);
    const trip = await db.query<{ status: string }>(`SELECT status FROM trips WHERE id = $1`, [
      ids.tripId,
    ]);
    expect(trip.rows[0]!.status).toBe("dark");
  });

  it("recovers on the next fix: outage closed with an exit point, trip running, LIVE announced", async () => {
    const back = T0 + 250_000;
    await feed(ping(2600, back));
    clock = back + 2000;
    const r = await sweep();
    expect(r.recovered).toEqual([ids.busId]);
    const statuses = (await events()).filter((x) => x.type === "bus.status");
    expect(statuses.map((x) => x.data)).toEqual([
      expect.objectContaining({ state: "LIVE", reason: "recovered" }),
    ]);
    const o = await db.query<{ duration_s: number; exit: boolean }>(
      `SELECT duration_s, exit_point IS NOT NULL AS exit FROM signal_outages WHERE trip_id = $1`,
      [ids.tripId],
    );
    expect(o.rows).toEqual([{ duration_s: 165, exit: true }]); // last fix at 85 s → back at 250 s
    const trip = await db.query<{ status: string }>(`SELECT status FROM trips WHERE id = $1`, [
      ids.tripId,
    ]);
    expect(trip.rows[0]!.status).toBe("running");
    expect(await t.redis.get(t.keys.busOutage(ids.busId))).toBeNull();
  });

  it("a parked bus reporting every 15 s stays green through a long stop", async () => {
    const parkedAt = T0 + 300_000;
    for (let i = 0; i < 8; i++) {
      await feed(ping(2700, parkedAt + i * 15_000, { speed_kmh: 0, cadence_s: 15 }));
      // sweep at the worst moment: just before the next ping (plus a 5 s batch hold) lands
      clock = parkedAt + i * 15_000 + 19_900;
      expect((await sweep()).transitions).toEqual([]);
    }
    expect((await readFleetEntry(t.redis, t.keys, ids.busId))!.state).toBe("LIVE");
  });

  it("a ping landing mid-sweep wins: the sweeper's write is a compare-and-set on the fix", async () => {
    const e = (await readFleetEntry(t.redis, t.keys, ids.busId))!;
    // a newer fix lands after the sweeper read the old one, before it writes
    const newer = {
      ...e,
      ts: new Date(Date.parse(e.ts) + 15_000).toISOString(),
      state: "LIVE" as const,
    };
    await writeFleetIfNewer(t.redis, t.keys, ids.busId, newer);
    const { setFleetState } = await import("@busmitra/redis");
    expect(
      await setFleetState(t.redis, t.keys, ids.busId, ids.tripId, "DEGRADED", { expectTs: e.ts }),
    ).toBe(false);
    expect((await readFleetEntry(t.redis, t.keys, ids.busId))!.state).toBe("LIVE");
  });

  it("classifies DARK inside a known dead zone, and says how long it usually lasts", async () => {
    const e = (await readFleetEntry(t.redis, t.keys, ids.busId))!;
    await db.query(
      `INSERT INTO dead_zones (polygon, label, sample_count, avg_outage_s, p90_outage_s, confidence, last_observed_at)
       VALUES (ST_Buffer(ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, 200)::geography,
               'Test underpass', 8, 90, 130, 0.9, now())`,
      [e.lng, e.lat],
    );
    clock = Date.parse(e.ts) + 15 * 9 * 1000;
    const r = await sweep();
    expect(r.transitions).toMatchObject([{ to: "DARK", reason: "known_dead_zone" }]);
    const status = (await events()).find((x) => x.type === "bus.status")!;
    expect(status.data).toMatchObject({ deadZone: { label: "Test underpass", avgOutageS: 90 } });
  });

  it("removes the bus 10 minutes after DARK, and puts it back if the tracker returns", async () => {
    const e = (await readFleetEntry(t.redis, t.keys, ids.busId))!;
    clock = Date.parse(e.ts) + (15 * 9 + 600) * 1000;
    expect((await sweep()).transitions).toMatchObject([{ to: "ENDED", reason: "dark_timeout" }]);
    expect((await readFleetEntry(t.redis, t.keys, ids.busId))!.flag).toBe("dark_timeout");
    const back = clock + 1000;
    await feed(ping(2900, back));
    const after = (await readFleetEntry(t.redis, t.keys, ids.busId))!;
    expect(after.state).toBe("LIVE");
    expect(after.deadZone ?? null).toBeNull();
  });

  it("an explicit trip end is announced once and keeps the bus off the map", async () => {
    await feed({
      kind: "trip_end",
      trip_id: ids.tripId,
      bus_id: ids.busId,
      route_id: ids.routeId,
      at: new Date(clock + 5000).toISOString(),
    } as unknown as StreamPing);
    const ended = (await events()).filter((x) => x.type === "bus.status");
    expect(ended.map((x) => x.data)).toEqual([
      expect.objectContaining({ state: "ENDED", reason: "trip_end" }),
    ]);
    clock += 3_600_000;
    expect((await sweep()).transitions).toEqual([]);
  });

  it("rehydrates fleet:live from recent positions with the presence their age implies", async () => {
    const other = await seedTracker(db, {
      busNumber: "42",
      deviceUid: "phone-42",
      secret: "s",
      key: "k".repeat(32),
    });
    const trip = await seedTrip(db, { busId: other.busId, routeId: ids.routeId });
    const fixAt = Date.now() - 60_000; // a minute old: DARK at a 5 s cadence
    await db.query(
      `INSERT INTO positions (trip_id, bus_id, recorded_at, location, speed_kmh, route_offset_m)
       VALUES ($1, $2, $3, ST_SetSRID(ST_MakePoint(78.54, 17.3688), 4326)::geography, 20, 1500)`,
      [trip, other.busId, new Date(fixAt).toISOString()],
    );
    expect(await rehydrateFleet(db, t.redis, t.keys, routes)).toBeGreaterThanOrEqual(1);
    const e = (await readFleetEntry(t.redis, t.keys, other.busId))!;
    expect(e).toMatchObject({ tripId: trip, state: "DARK", s: 1500, seq: 1, routeId: ids.routeId });
    // a second run changes nothing: nothing newer is overwritten
    expect(await rehydrateFleet(db, t.redis, t.keys, routes)).toBe(0);
    // rehydrated as DARK, there was no transition to open its outage on: the sweeper logs it anyway
    const r = await sweepOnce({ redis: t.redis, keys: t.keys, db, routes, now: () => Date.now() });
    expect(r.transitions.filter((x) => x.busId === other.busId)).toEqual([]);
    const o = await db.query(
      `SELECT 1 FROM signal_outages WHERE trip_id = $1 AND recovered_at IS NULL`,
      [trip],
    );
    expect(o.rows).toHaveLength(1);
  });
});
