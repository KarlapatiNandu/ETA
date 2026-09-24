import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StreamMessage } from "@busmitra/contracts";
import { seedRoute, seedTracker } from "@busmitra/db/testing";
import { ensureGroup, readGroup, STREAMS } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { sign } from "../../plugins/device-auth.ts";
import { createTestGateway, TRACKER_KEY } from "../../testing.ts";

const live = await redisAvailable();
const line = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5623 },
];

describe.skipIf(!live)("tracker control plane", () => {
  let t: TestRedis;
  let gw: Awaited<ReturnType<typeof createTestGateway>>;
  let routeA: string;
  let routeB: string;
  let draft: string;
  let n = 0;

  beforeAll(async () => {
    t = await createTestRedis();
    gw = await createTestGateway({ redis: t });
    routeA = (await seedRoute(gw.db, { coords: line, name: "A", published: true })).routeId;
    routeB = (await seedRoute(gw.db, { coords: line, name: "B", published: true })).routeId;
    draft = (await seedRoute(gw.db, { coords: line, name: "Draft" })).routeId;
    await seedTracker(gw.db, {
      busNumber: "5",
      deviceUid: "phone-5",
      secret: "s5",
      key: TRACKER_KEY,
    });
    await gw.db.query(
      `INSERT INTO trackers (device_uid, kind, secret_enc) VALUES ('phone-unpaired', 'driver_phone', pgp_sym_encrypt('su', $1))`,
      [TRACKER_KEY],
    );
    await ensureGroup(t.redis, t.keys.streamPings, STREAMS.GROUP_GEO);
  });
  afterAll(async () => {
    await gw.app.close();
    await gw.db.close();
    await t.close();
  });

  const call = (
    method: "GET" | "POST",
    url: string,
    body?: unknown,
    device = "phone-5",
    secret = "s5",
  ) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    // a distinct timestamp per call keeps signatures (and so nonces) unique
    const ts = String(Math.floor(Date.now() / 1000) + ++n);
    return gw.app.inject({
      method,
      url,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "x-device-id": device,
        "x-timestamp": ts,
        "x-signature": sign(secret, device, ts, payload),
      },
      payload: payload || undefined,
    });
  };

  it("GET /v1/tracker/me: the bus, the published routes (never drafts), no live trip yet", async () => {
    const res = await call("GET", "/v1/tracker/me");
    expect(res.statusCode).toBe(200);
    const me = res.json();
    expect(me.device_uid).toBe("phone-5");
    expect(me.bus.bus_number).toBe("5");
    expect(me.routes.map((r: { id: string }) => r.id).sort()).toEqual([routeA, routeB].sort());
    expect(me.live_trip).toBeNull();
  });

  let tripId: string;

  it("starts a trip, and resumes the same one when the app restarts mid-trip", async () => {
    const first = await call("POST", "/v1/tracker/trips", { route_id: routeA });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ route_id: routeA, resumed: false });
    tripId = first.json().trip_id;
    const again = await call("POST", "/v1/tracker/trips", { route_id: routeA });
    expect(again.json()).toMatchObject({ trip_id: tripId, resumed: true });
    // favourites are told once (Stage 6): a new trip rings trip_start, a resume stays silent
    const bells = (await t.redis.xrange(t.keys.streamNotify, "-", "+")).map(([, f]) =>
      JSON.parse(f[1]!),
    );
    expect(bells.filter((b) => b.type === "trip_start" && b.tripId === tripId)).toHaveLength(1);
    expect((await call("GET", "/v1/tracker/me")).json().live_trip.id).toBe(tripId);
  });

  it("starting on a different route closes the open trip and emits its trip_end", async () => {
    const res = await call("POST", "/v1/tracker/trips", { route_id: routeB });
    expect(res.json().resumed).toBe(false);
    const { rows } = await gw.db.query<{ status: string; run_seq: number }>(
      `SELECT status, run_seq FROM trips WHERE id = $1`,
      [tripId],
    );
    expect(rows[0]!.status).toBe("completed");
    const queued = await readGroup<StreamMessage>(t.redis, {
      stream: t.keys.streamPings,
      group: STREAMS.GROUP_GEO,
      consumer: "t",
      count: 10,
      blockMs: 5,
    });
    expect(queued.map((q) => q.data)).toEqual([
      expect.objectContaining({ kind: "trip_end", trip_id: tripId }),
    ]);
    // the second run in the same shift is run_seq 2
    const second = await gw.db.query<{ run_seq: number }>(
      `SELECT run_seq FROM trips WHERE id = $1`,
      [res.json().trip_id],
    );
    expect(second.rows[0]!.run_seq).toBe(2);
    tripId = res.json().trip_id;
  });

  it("ends a trip idempotently", async () => {
    const end = await call("POST", `/v1/tracker/trips/${tripId}/end`, {});
    expect(end.statusCode).toBe(200);
    expect(end.json().status).toBe("completed");
    const again = await call("POST", `/v1/tracker/trips/${tripId}/end`, {});
    expect(again.statusCode).toBe(200);
  });

  it("refuses a draft route, another bus's trip, and an unpaired phone", async () => {
    expect((await call("POST", "/v1/tracker/trips", { route_id: draft })).statusCode).toBe(422);
    const other = await call(
      "POST",
      `/v1/tracker/trips/00000000-0000-4000-8000-000000000000/end`,
      {},
    );
    expect(other.statusCode).toBe(404);
    const unpaired = await call(
      "POST",
      "/v1/tracker/trips",
      { route_id: routeA },
      "phone-unpaired",
      "su",
    );
    expect(unpaired.statusCode).toBe(409);
    expect(
      (await call("GET", "/v1/tracker/me", undefined, "phone-unpaired", "su")).json().bus,
    ).toBeNull();
  });

  it("POST /v1/survey stores the raw trace untouched and records the survey", async () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      t: new Date(Date.UTC(2026, 8, 22, 2, 0, i)).toISOString(),
      lat: 17.3688,
      lng: 78.5247 + i * 0.0001,
      accuracy_m: 5,
    }));
    const res = await call("POST", "/v1/survey", { label: "Route 5 inbound", points });
    expect(res.statusCode).toBe(201);
    expect(res.json().point_count).toBe(30);
    const { rows } = await gw.db.query<{ file_path: string; label: string; point_count: number }>(
      `SELECT file_path, label, point_count FROM route_surveys WHERE id = $1`,
      [res.json().survey_id],
    );
    expect(rows[0]).toMatchObject({ label: "Route 5 inbound", point_count: 30 });
    expect(JSON.parse(gw.surveyFiles.files.get(rows[0]!.file_path)!).points).toHaveLength(30);
  });

  it("the survey endpoint is signed like everything else", async () => {
    const res = await gw.app.inject({ method: "POST", url: "/v1/survey", payload: { points: [] } });
    expect(res.statusCode).toBe(401);
  });
});
