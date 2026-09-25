import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withContext } from "@busmitra/db";
import { seedRoute } from "@busmitra/db/testing";
import { provisionTracker } from "@busmitra/gateway/trackers";
import { createTestGateway, TRACKER_KEY } from "@busmitra/gateway/testing";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { FakeGt06 } from "./fake-device.ts";
import { startAdapter } from "./server.ts";

/**
 * BUILD_PLAN Stage 9 — "hardware tracker adapter emitting identical PingBatch". A GT06 device
 * (in software, byte-exact) → the adapter → the real gateway over HTTP → `stream:pings`. What
 * lands on the stream must be indistinguishable from a phone's pings, apart from the device id.
 */

const live = await redisAvailable();
const IMEI = "868120301234567";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)("GT06 tracker → adapter → gateway", () => {
  let r: TestRedis;
  let gw: Awaited<ReturnType<typeof createTestGateway>>;
  let adapter: ReturnType<typeof startAdapter>;
  let port: number;
  let routeId: string;
  let busId: string;

  const pings = async () =>
    (await r.redis.xrange(r.keys.streamPings, "-", "+")).map(
      ([, f]) => JSON.parse(f[f.indexOf("d") + 1]!) as Record<string, unknown>,
    );
  const until = async (what: string, test: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      if (await test()) return;
      await sleep(100);
    }
    throw new Error(`timed out waiting for ${what}`);
  };

  beforeAll(async () => {
    r = await createTestRedis();
    gw = await createTestGateway({ redis: r });
    await gw.app.listen({ port: 0, host: "127.0.0.1" });
    const gwPort = (gw.app.server.address() as AddressInfo).port;
    routeId = (
      await seedRoute(gw.db, {
        coords: [
          { lat: 17.3688, lng: 78.5247 },
          { lat: 17.3688, lng: 78.5812 },
        ],
        name: "Uppal",
        published: true,
      })
    ).routeId;
    const t = await withContext(gw.db, { actorId: null, ip: null, userAgent: "test" }, (q) =>
      provisionTracker(q, TRACKER_KEY, { busNumber: "HW-1", deviceUid: IMEI, kind: "hardware" }),
    );
    busId = t.busId;
    await gw.db.query(`UPDATE buses SET default_route_id = $1 WHERE id = $2`, [routeId, busId]);
    adapter = startAdapter(0, {
      gateway: `http://127.0.0.1:${gwPort}`,
      devices: { [IMEI]: { secret: t.secret, movingIntervalS: 10, idleIntervalS: 60 } },
      tripEndAfterAccOffS: 1,
    });
    await new Promise((ok) => adapter.server.once("listening", ok));
    port = (adapter.server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await adapter?.close();
    await gw?.app.close();
    await r?.close();
  });

  it("refuses a device it has no secret for: no login ack, connection closed", async () => {
    const d = new FakeGt06();
    await d.connect(port);
    d.login("000000000000001");
    await until("disconnect", async () => d.closed);
    expect(d.acks).toEqual([]);
  });

  it("ignition on: acknowledges, starts the bus's trip on its default route, ingests every fix", async () => {
    const d = new FakeGt06();
    await d.connect(port);
    d.login(IMEI);
    d.status(true);
    await d.waitForAcks(2);
    expect(d.acks).toEqual([0x01, 0x13]);

    const now = Date.now();
    for (let i = 4; i >= 0; i--) {
      d.fix({
        recordedAt: new Date(Math.floor((now - i * 1000) / 1000) * 1000).toISOString(),
        lat: 17.3688,
        lng: 78.53 + (4 - i) * 0.0005,
        speedKmh: 30,
        headingDeg: 90,
        acc: true,
      });
    }
    await until("5 pings", async () => (await pings()).length >= 5);
    const got = await pings();
    expect(got).toHaveLength(5);
    const trip = await gw.db.query<{ id: string; route_id: string; status: string }>(
      `SELECT id, route_id, status FROM trips WHERE bus_id = $1`,
      [busId],
    );
    expect(trip.rows).toEqual([{ id: expect.any(String), route_id: routeId, status: "running" }]);
    for (const p of got) {
      // the same StreamPing a phone produces; only the device id says "hardware"
      expect(p).toMatchObject({
        kind: "ping",
        device_uid: IMEI,
        bus_id: busId,
        route_id: routeId,
        trip_id: trip.rows[0]!.id,
        cadence_s: 10,
        speed_kmh: 30,
        heading_deg: 90,
        is_backfill: false,
      });
    }
    d.close();
  });

  it("keeps a re-uploaded fix's own time, so the gateway flags it backfill", async () => {
    const d = new FakeGt06();
    await d.connect(port); // a reconnect: same uplink, same trip
    d.login(IMEI);
    await d.waitForAcks(1);
    const old = new Date(Math.floor((Date.now() - 120_000) / 1000) * 1000).toISOString();
    d.fix({
      recordedAt: old,
      lat: 17.3688,
      lng: 78.54,
      speedKmh: 25,
      headingDeg: 90,
      acc: true,
      reupload: true,
    });
    await until("backfill ping", async () => (await pings()).some((p) => p.recorded_at === old));
    expect((await pings()).find((p) => p.recorded_at === old)).toMatchObject({ is_backfill: true });
    d.close();
  });

  it("ignition off: reports the idle cadence, then ends the trip", async () => {
    const d = new FakeGt06();
    await d.connect(port);
    d.login(IMEI);
    d.status(false);
    await d.waitForAcks(2);
    await until("trip end", async () => (await pings()).some((p) => p.kind === "trip_end"));
    const trip = await gw.db.query<{ status: string }>(
      `SELECT status FROM trips WHERE bus_id = $1`,
      [busId],
    );
    expect(trip.rows.map((t) => t.status)).toEqual(["completed"]);
    expect(adapter.uplinks.get(IMEI)!.cadenceS).toBe(60);
    // parked, ignition off, no trip: a fix is not attached to anything, and no trip starts
    d.fix({
      recordedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString(),
      lat: 17.3688,
      lng: 78.55,
      speedKmh: 0,
      headingDeg: 0,
      acc: false,
    });
    await sleep(1500);
    expect(adapter.uplinks.get(IMEI)!.pending).toBe(0);
    const after = await gw.db.query(`SELECT 1 FROM trips WHERE bus_id = $1`, [busId]);
    expect(after.rows).toHaveLength(1);
    d.close();
    expect(adapter.stats.badFrames).toBe(0);
  });
});
