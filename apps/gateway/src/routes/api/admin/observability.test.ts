import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { seedStudent } from "@busmitra/db/testing";
import { appendEntries, publishEvents, STREAMS, writeFleetIfNewer } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { createTestGateway } from "../../../testing.ts";

/** BUILD_PLAN Stage 8 — the console's observability page and its alert rules. */

type Gw = Awaited<ReturnType<typeof createTestGateway>>;
const live = await redisAvailable();

describe.skipIf(!live)("GET /v1/admin/observability", () => {
  let gw: Gw;
  let r: TestRedis;
  let adminToken: string, studentToken: string;
  const get = (token: string) =>
    gw.app.inject({
      method: "GET",
      url: "/v1/admin/observability",
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    r = await createTestRedis();
    gw = await createTestGateway({ redis: r });
    const admin = (await seedStudent(gw.db, { rollNo: "TDADMIN80", role: "td_admin" })).userId!;
    adminToken = await gw.tokenFor(admin);
    studentToken = await gw.tokenFor((await seedStudent(gw.db, { rollNo: "J8000001" })).userId!);
  });
  afterAll(async () => {
    await gw.app.close();
    await r.close();
  });

  it("is invisible to students", async () => {
    expect((await get(studentToken)).statusCode).toBe(404);
  });

  it("reports a quiet system with nothing firing", async () => {
    const res = await get(adminToken);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.alerts.map((a: { id: string }) => a.id)).toEqual([
      "latency",
      "consumer_lag",
      "push_failures",
      "dark_bus",
      "dead_letters",
    ]);
    expect(body.alerts.filter((a: { firing: boolean }) => a.firing)).toEqual([]);
    expect(body.deadZones).toEqual({ zones: [], outages14d: [] });
  });

  it("fires on a bus silent 15 minutes, a dead letter and consumer lag; measures fan-out age", async () => {
    const now = Date.now();
    await writeFleetIfNewer(r.redis, r.keys, "bus-dark", {
      lat: 17.4,
      lng: 78.5,
      spd: 0,
      hdg: 0,
      s: 10,
      seq: 1,
      tripId: "t-dark",
      ts: new Date(now - 16 * 60_000).toISOString(),
      state: "DARK",
      cadence: 5,
    });
    await appendEntries(r.redis, r.keys.streamPingsDead, [{ reason: "test" }], 100);
    // a group that has been delivered nothing of 1,001 entries
    await r.redis.xgroup("CREATE", r.keys.streamNotify, STREAMS.GROUP_NOTIFY, "$", "MKSTREAM");
    await appendEntries(
      r.redis,
      r.keys.streamNotify,
      Array.from({ length: 1001 }, (_, i) => ({ i })),
      10_000,
    );
    // two frames through the hub: a live one 3 s old, and a backfill that must not count
    await publishEvents(r.redis, r.keys, [
      {
        type: "bus.position",
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          lat: 17.4,
          lng: 78.5,
          spd: 30,
          hdg: 90,
          s: 100,
          ts: new Date(now - 3000).toISOString(),
        },
      },
      {
        type: "bus.position",
        data: {
          id: "22222222-2222-4222-8222-222222222222",
          lat: 17.4,
          lng: 78.5,
          spd: 30,
          hdg: 90,
          s: 100,
          ts: new Date(now - 600_000).toISOString(),
        },
      },
    ]);
    let body;
    for (let i = 0; i < 50; i++) {
      body = (await get(adminToken)).json();
      if (body.live.pingToFrame.n > 0) break;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    expect(body.live.pingToFrame.n).toBe(1);
    expect(body.live.pingToFrame.p95).toBeGreaterThanOrEqual(3);
    expect(body.live.pingToFrame.p95).toBeLessThan(10);
    const firing = body.alerts
      .filter((a: { firing: boolean }) => a.firing)
      .map((a: { id: string }) => a.id);
    expect(firing).toEqual(["consumer_lag", "dark_bus", "dead_letters"]);
    expect(body.live.fleet.darkTooLong).toEqual([
      { busId: "bus-dark", darkForS: expect.any(Number) },
    ]);
    expect(body.live.groups).toContainEqual(
      expect.objectContaining({ stream: "stream:notify", group: "notify", lag: 1001 }),
    );
  });
});
