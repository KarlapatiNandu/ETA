import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamMessage, StreamPing } from "@busmitra/contracts";
import { createTestDb, seedRoute, seedTracker, seedTrip, type TestDb } from "@busmitra/db/testing";
import { buildRoute, offsetPoint, pointAtOffset, type LatLng } from "@busmitra/geo";
import { appendEntries, readFleetEntry, STREAMS, type StreamEntry } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { RouteCache } from "../lib/route-cache.ts";
import { processEntries, runGeoWorker } from "./geo.ts";
import { flushBatch, isOutage, runPersister } from "./persister.ts";

const live = await redisAvailable();

// 4 km east from Dilsukhnagar, stops every kilometre
const line: LatLng[] = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5623 },
];
const route = buildRoute(line);
const T0 = Date.parse("2026-09-22T02:00:00.000Z");

describe.skipIf(!live)("geo worker + persister (Stage 2)", () => {
  let db: TestDb;
  let t: TestRedis;
  let routes: RouteCache;
  let ids: { routeId: string; busId: string; tripId: string };
  let seq = 0;
  const entry = (data: StreamMessage): StreamEntry<unknown> => ({ id: `0-${++seq}`, data });

  const ping = (at: number, s: number, extra: Partial<StreamPing> = {}): StreamPing => ({
    kind: "ping",
    trip_id: ids.tripId,
    bus_id: ids.busId,
    route_id: ids.routeId,
    device_uid: "phone-7",
    cadence_s: 5,
    recorded_at: new Date(at).toISOString(),
    ingested_at: new Date(at + 800).toISOString(),
    ...pointAtOffset(route, s),
    speed_kmh: 36,
    heading_deg: 90,
    accuracy_m: 6,
    is_backfill: false,
    ...extra,
  });

  beforeAll(async () => {
    db = await createTestDb();
    t = await createTestRedis();
    routes = new RouteCache(db, t.redis, t.keys);
    const r = await seedRoute(db, {
      coords: line,
      name: "Ingest test",
      published: true,
      stops: [0, 1000, 2000, 3000, route.total - 5].map((offset, i) => ({
        name: `Stop ${i + 1}`,
        offset,
        ...pointAtOffset(route, offset),
      })),
    });
    const tr = await seedTracker(db, {
      busNumber: "7",
      deviceUid: "phone-7",
      secret: "s",
      key: "k".repeat(32),
    });
    ids = {
      routeId: r.routeId,
      busId: tr.busId,
      tripId: await seedTrip(db, { busId: tr.busId, routeId: r.routeId }),
    };
    // positions partitions are relative to now(); keep test pings inside them
  });
  afterAll(async () => {
    await t.close();
    await db.close();
  });

  const deps = () => ({ redis: t.redis, keys: t.keys, routes });

  describe("geo worker", () => {
    it("advances fleet:live along the route and tracks the stop sequence", async () => {
      const r = await processEntries(
        deps(),
        [0, 1, 2, 3, 4, 5].map((i) => entry(ping(T0 + i * 5000, 950 + i * 50))),
      );
      expect(r).toMatchObject({ written: 6, stale: 0, invalid: 0 });
      const e = (await readFleetEntry(t.redis, t.keys, ids.busId))!;
      expect(e.s).toBeCloseTo(1200, -1);
      expect(e.tripId).toBe(ids.tripId);
      expect(e.cadence).toBe(5);
      expect(e.state).toBe("LIVE");
      expect(e.seq).toBe(1); // stop 2 (index 1) passed
      expect(await t.redis.get(t.keys.tripSeq(ids.tripId))).toBe("1");
      expect(Number(await t.redis.get(t.keys.busEwma(ids.busId)))).toBeCloseTo(36, 0);
      expect(await t.redis.ttl(t.keys.busHeartbeat(ids.busId))).toBeGreaterThan(50);
    });

    it("a backfilled older ping never overwrites the newer live entry (invariant 4)", async () => {
      const before = await readFleetEntry(t.redis, t.keys, ids.busId);
      const r = await processEntries(deps(), [
        entry(ping(T0 - 60_000, 500, { is_backfill: true })),
      ]);
      expect(r.stale).toBe(1);
      expect(await readFleetEntry(t.redis, t.keys, ids.busId)).toEqual(before);
    });

    it("re-processing an already-seen batch (a crash before ack) changes nothing", async () => {
      const before = await readFleetEntry(t.redis, t.keys, ids.busId);
      const r = await processEntries(deps(), [entry(ping(T0 + 25_000, 1200))]);
      expect(r).toMatchObject({ written: 0, stale: 1, invalid: 0, published: 0 });
      expect(await readFleetEntry(t.redis, t.keys, ids.busId)).toEqual(before);
    });

    it("publishes no offset while the bus is off-route — never a fabricated one", async () => {
      const far = (i: number) =>
        entry(ping(T0 + (6 + i) * 5000, 0, { ...offsetPoint(pointAtOffset(route, 1250), 400, 0) }));
      await processEntries(deps(), [far(0), far(1), far(2)]);
      const e = (await readFleetEntry(t.redis, t.keys, ids.busId))!;
      expect(e.s).toBeNull();
      expect(e.flag).toBe("off_route");
      await processEntries(deps(), [entry(ping(T0 + 9 * 5000, 1300))]);
      expect((await readFleetEntry(t.redis, t.keys, ids.busId))!.s).toBeCloseTo(1300, -1);
    });

    it("counts entries that are not valid stream messages", async () => {
      expect((await processEntries(deps(), [{ id: "0-x", data: { kind: "ping" } }])).invalid).toBe(
        1,
      );
    });

    it("trip end marks the bus ENDED where it last was", async () => {
      await processEntries(deps(), [
        entry({
          kind: "trip_end",
          trip_id: ids.tripId,
          bus_id: ids.busId,
          route_id: ids.routeId,
          at: new Date(T0 + 60_000).toISOString(),
        }),
      ]);
      const e = (await readFleetEntry(t.redis, t.keys, ids.busId))!;
      expect(e.state).toBe("ENDED");
      expect(e.s).toBeCloseTo(1300, -1);
    });

    it("skips (and logs) a ping for a route it cannot load", async () => {
      const logs: string[] = [];
      const r = await processEntries({ ...deps(), log: (m) => void logs.push(m) }, [
        entry(ping(T0 + 99_000, 10, { route_id: "00000000-0000-4000-8000-000000000000" })),
      ]);
      expect(r.stale).toBe(1);
      expect(logs[0]).toMatch(/unknown route/);
    });
  });

  describe("persister", () => {
    // fixed instants a few minutes ago: inside the current positions partition, and identical
    // every time batch() is called, which is what makes the replay test a replay
    const base = Math.floor((Date.now() - 5 * 60_000) / 5000) * 5000;
    const batch = () =>
      Array.from({ length: 20 }, (_, i) => entry(ping(base + i * 5000, 100 + i * 40)));

    it("writes a batch with snapped offsets", async () => {
      const entries = batch();
      const r = await flushBatch({ db, ...deps() }, entries);
      expect(r).toEqual({ inserted: 20, duplicates: 0, dead: 0 });
      const { rows } = await db.query<{ n: number; off: number }>(
        `SELECT count(*)::int AS n, max(route_offset_m) AS off FROM positions WHERE trip_id = $1`,
        [ids.tripId],
      );
      expect(rows[0]!.n).toBe(20);
      expect(rows[0]!.off).toBeCloseTo(100 + 19 * 40, -1);
    });

    it("a replayed batch produces no duplicate rows (the unique index holds)", async () => {
      const again = batch();
      const r = await flushBatch({ db, ...deps() }, [...again, ...again]);
      expect(r.inserted).toBe(0);
      expect(r.duplicates).toBe(40);
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM positions WHERE trip_id = $1`,
        [ids.tripId],
      );
      expect(rows[0]!.n).toBe(20);
    });

    it("isolates a poison row: the rest of the batch lands, the bad row is dead-lettered", async () => {
      const good = entry(ping(base + 777_000, 900));
      const bad = entry(ping(base + 400 * 86_400_000, 900)); // no partition that far ahead
      const r = await flushBatch({ db, ...deps() }, [good, bad]);
      expect(r).toEqual({ inserted: 1, duplicates: 0, dead: 1 });
      const dead = await t.redis.xrange(t.keys.streamPingsDead, "-", "+");
      expect(dead).toHaveLength(1);
      expect(dead[0]![1][1]).toMatch(/partition/);
    });

    it("dead-letters stream entries that are not messages at all", async () => {
      const r = await flushBatch({ db, ...deps() }, [{ id: "0-junk", data: { nope: true } }]);
      expect(r.dead).toBe(1);
    });

    it("tells a Postgres outage (retry) from a bad row (dead-letter)", () => {
      expect(
        isOutage(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
      ).toBe(true);
      expect(isOutage(new Error("Connection terminated unexpectedly"))).toBe(true);
      expect(isOutage({ code: "08006" })).toBe(true);
      expect(isOutage({ code: "57P01" })).toBe(true);
      expect(isOutage({ code: "23503" })).toBe(false); // FK violation: the row is bad
      expect(isOutage({ code: "23514" })).toBe(false); // no partition: the row is bad
    });
  });

  describe("the consumer loops, end to end through Redis Streams", () => {
    it("both groups consume the same pings independently and acknowledge them", async () => {
      const t2 = await createTestRedis();
      const trip2 = await (async () => {
        const tr = await seedTracker(db, {
          busNumber: "8",
          deviceUid: "phone-8",
          secret: "s",
          key: "k".repeat(32),
        });
        return {
          busId: tr.busId,
          tripId: await seedTrip(db, { busId: tr.busId, routeId: ids.routeId }),
        };
      })();
      const base = Date.now() - 2 * 60_000;
      const pings = Array.from({ length: 30 }, (_, i) => ({
        ...ping(base + i * 1000, 100 + i * 20),
        trip_id: trip2.tripId,
        bus_id: trip2.busId,
      }));
      await appendEntries(t2.redis, t2.keys.streamPings, pings, 1000);
      const stop = new AbortController();
      const routes2 = new RouteCache(db, t2.redis, t2.keys);
      const loops = [
        runGeoWorker({
          redis: t2.redis,
          keys: t2.keys,
          routes: routes2,
          stream: t2.connect(),
          consumer: "g",
          signal: stop.signal,
        }),
        runPersister({
          db,
          redis: t2.redis,
          keys: t2.keys,
          routes: routes2,
          stream: t2.connect(),
          consumer: "p",
          signal: stop.signal,
        }),
      ];
      const deadline = Date.now() + 15_000;
      let rows = 0;
      while (Date.now() < deadline) {
        const r = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM positions WHERE trip_id = $1`,
          [trip2.tripId],
        );
        rows = r.rows[0]!.n;
        const fleet = await readFleetEntry(t2.redis, t2.keys, trip2.busId);
        if (rows === 30 && fleet?.s && fleet.s > 650) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      stop.abort();
      await Promise.all(loops);
      expect(rows).toBe(30);
      expect((await readFleetEntry(t2.redis, t2.keys, trip2.busId))!.s).toBeCloseTo(680, -1);
      for (const g of [STREAMS.GROUP_GEO, STREAMS.GROUP_PERSIST]) {
        const [pending] = (await t2.redis.xpending(t2.keys.streamPings, g)) as [number];
        expect(pending).toBe(0);
      }
      await t2.close();
    }, 30_000);
  });
});
