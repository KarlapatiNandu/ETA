import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { StreamMessage } from "@busmitra/contracts";
import { seedRoute, seedTracker, seedTrip } from "@busmitra/db/testing";
import { STREAMS, readGroup, ensureGroup } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { sign } from "../../plugins/device-auth.ts";
import { rotateTrackerSecret } from "../../services/trackers.ts";
import { createTestGateway, TRACKER_KEY } from "../../testing.ts";
import { INGEST } from "./index.ts";

/**
 * POST /v1/ingest — BUILD_PLAN Stage 2 exit criteria "forged HMAC and stale-timestamp
 * requests are rejected", plus everything the tracker's retry logic depends on.
 */

const live = await redisAvailable();
const SECRET = "device-secret-for-bus-9";
const line = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5623 },
];

describe.skipIf(!live)("POST /v1/ingest", () => {
  let t: TestRedis;
  let gw: Awaited<ReturnType<typeof createTestGateway>>;
  let clock = Date.parse("2026-09-22T02:00:00.000Z");
  let tripId: string;
  let otherTrip: string;

  beforeAll(async () => {
    t = await createTestRedis();
    gw = await createTestGateway({ redis: t, now: () => clock });
    const { routeId } = await seedRoute(gw.db, { coords: line, name: "Ingest", published: true });
    const { busId } = await seedTracker(gw.db, {
      busNumber: "9",
      deviceUid: "phone-9",
      secret: SECRET,
      key: TRACKER_KEY,
    });
    tripId = await seedTrip(gw.db, { busId, routeId });
    const other = await seedTracker(gw.db, {
      busNumber: "10",
      deviceUid: "phone-10",
      secret: "x",
      key: TRACKER_KEY,
    });
    otherTrip = await seedTrip(gw.db, { busId: other.busId, routeId });
    await ensureGroup(t.redis, t.keys.streamPings, STREAMS.GROUP_GEO);
  });
  afterAll(async () => {
    await gw.app.close();
    await gw.db.close();
    await t.close();
  });
  beforeEach(() => {
    clock += 60_000; // fresh rate-limit window and nonces per test
  });

  const batch = (pings: { at: number; lat?: number }[], extra: Record<string, unknown> = {}) => ({
    device_uid: "phone-9",
    trip_id: tripId,
    cadence_s: 5,
    pings: pings.map((p) => ({
      recorded_at: new Date(p.at).toISOString(),
      lat: p.lat ?? 17.3688,
      lng: 78.53,
      speed_kmh: 30,
      accuracy_m: 5,
    })),
    ...extra,
  });

  const post = (
    body: unknown,
    o: { secret?: string; device?: string; ts?: number; raw?: string } = {},
  ) => {
    const payload = o.raw ?? JSON.stringify(body);
    const device = o.device ?? "phone-9";
    const ts = String(Math.floor((o.ts ?? clock) / 1000));
    return gw.app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers: {
        "content-type": "application/json",
        "x-device-id": device,
        "x-timestamp": ts,
        "x-signature": sign(o.secret ?? SECRET, device, ts, payload),
      },
      payload,
    });
  };

  const drain = async () =>
    (
      await readGroup<StreamMessage>(t.redis, {
        stream: t.keys.streamPings,
        group: STREAMS.GROUP_GEO,
        consumer: "test",
        count: 1000,
        blockMs: 5,
      })
    ).map((e) => e.data);

  it("accepts a signed batch and queues it on stream:pings — no database write", async () => {
    const before = await gw.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM positions`);
    const res = await post(batch([{ at: clock - 2000 }, { at: clock - 7000 }]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 2, rejected: [] });
    const queued = await drain();
    expect(queued).toHaveLength(2);
    // sorted by recorded_at, not arrival order
    expect(queued.map((q) => (q.kind === "ping" ? q.recorded_at : ""))).toEqual([
      new Date(clock - 7000).toISOString(),
      new Date(clock - 2000).toISOString(),
    ]);
    expect(queued[0]).toMatchObject({
      kind: "ping",
      trip_id: tripId,
      cadence_s: 5,
      is_backfill: false,
    });
    const after = await gw.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM positions`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it("marks pings more than 30 s old as backfill", async () => {
    await post(batch([{ at: clock - 31_000 }, { at: clock - 29_000 }]));
    const queued = await drain();
    expect(queued.map((q) => q.kind === "ping" && q.is_backfill)).toEqual([true, false]);
  });

  it("defaults a missing cadence to 5 s (ARCH §5.7)", async () => {
    const b = batch([{ at: clock - 1000 }]);
    delete (b as { cadence_s?: number }).cadence_s;
    await post(b);
    expect((await drain())[0]).toMatchObject({ cadence_s: 5 });
  });

  it("drops a duplicate inside one batch and rejects impossible timestamps individually", async () => {
    const res = await post(
      batch([
        { at: clock - 5000 },
        { at: clock - 5000 },
        { at: clock + INGEST.MAX_FUTURE_MS + 1000 },
        { at: clock - INGEST.MAX_AGE_MS - 1000 },
      ]),
    );
    expect(res.json()).toEqual({
      accepted: 1,
      rejected: [
        { index: 2, reason: "future_timestamp" },
        { index: 3, reason: "too_old" },
      ],
    });
    expect(await drain()).toHaveLength(1);
  });

  describe("forged and replayed requests are rejected", () => {
    it("a wrong secret: 401 bad_signature", async () => {
      const res = await post(batch([{ at: clock }]), { secret: "not-the-secret" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("bad_signature");
    });

    it("a body altered after signing: 401", async () => {
      const body = batch([{ at: clock }]);
      const ts = String(Math.floor(clock / 1000));
      const sig = sign(SECRET, "phone-9", ts, JSON.stringify(body));
      const res = await gw.app.inject({
        method: "POST",
        url: "/v1/ingest",
        headers: {
          "content-type": "application/json",
          "x-device-id": "phone-9",
          "x-timestamp": ts,
          "x-signature": sig,
        },
        payload: JSON.stringify(batch([{ at: clock, lat: 17.5 }])),
      });
      expect(res.statusCode).toBe(401);
    });

    it("an unknown device answers exactly like a bad signature (device ids are not enumerable)", async () => {
      const res = await post(batch([{ at: clock }]), { device: "phone-nobody" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("bad_signature");
    });

    it("a stale timestamp: 401 stale_timestamp, both too old and too far ahead", async () => {
      for (const skew of [-301_000, +301_000]) {
        const res = await post(batch([{ at: clock }]), { ts: clock + skew });
        expect(res.statusCode).toBe(401);
        expect(res.json().error).toBe("stale_timestamp");
      }
      // just inside the window is fine
      expect((await post(batch([{ at: clock }]), { ts: clock - 290_000 })).statusCode).toBe(200);
    });

    it("unsigned requests: 401", async () => {
      const res = await gw.app.inject({
        method: "POST",
        url: "/v1/ingest",
        payload: batch([{ at: clock }]),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("unsigned");
    });

    it("an exact replay of an accepted request: 409 replay, and nothing queued twice", async () => {
      const body = batch([{ at: clock - 1000 }]);
      const payload = JSON.stringify(body);
      const ts = String(Math.floor(clock / 1000));
      const headers = {
        "content-type": "application/json",
        "x-device-id": "phone-9",
        "x-timestamp": ts,
        "x-signature": sign(SECRET, "phone-9", ts, payload),
      };
      await drain();
      expect(
        (await gw.app.inject({ method: "POST", url: "/v1/ingest", headers, payload })).statusCode,
      ).toBe(200);
      const replay = await gw.app.inject({ method: "POST", url: "/v1/ingest", headers, payload });
      expect(replay.statusCode).toBe(409);
      expect(replay.json().error).toBe("replay");
      expect(await drain()).toHaveLength(1);
    });
  });

  describe("authorisation beyond the signature", () => {
    it("a device cannot post into another bus's trip", async () => {
      const res = await post(batch([{ at: clock }], { trip_id: otherTrip }));
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe("trip_not_live");
    });

    it("device_uid in the body must match the signer", async () => {
      const res = await post(batch([{ at: clock }], { device_uid: "phone-10" }));
      expect(res.statusCode).toBe(400);
    });

    it("a malformed batch is a 400 the tracker must not retry", async () => {
      expect((await post({ device_uid: "phone-9", trip_id: tripId, pings: [] })).statusCode).toBe(
        400,
      );
      expect((await post(null, { raw: "{not json" })).statusCode).toBe(400);
    });

    it("rate-limits one device to MAX_REQUESTS_PER_MIN per minute", async () => {
      let last = 0;
      for (let i = 0; i <= INGEST.MAX_REQUESTS_PER_MIN; i++) {
        last = (await post(batch([{ at: clock - i * 10 }]), { ts: clock + i })).statusCode;
      }
      expect(last).toBe(429);
      await drain();
    });
  });

  describe("secret rotation", () => {
    // expiry after the overlap is unit-tested in services/trackers.test.ts with a controlled clock
    it("the new secret works at once and the previous one keeps verifying during the overlap", async () => {
      const fresh = (await rotateTrackerSecret(gw.db, TRACKER_KEY, "phone-9"))!;
      // the directory caches for 60 s; move past it so the rotation is seen
      clock += 61_000;
      expect((await post(batch([{ at: clock }]), { secret: fresh })).statusCode).toBe(200);
      expect(
        (await post(batch([{ at: clock - 1 }]), { secret: SECRET, ts: clock + 1000 })).statusCode,
      ).toBe(200);
      await drain();
    });
  });
});
