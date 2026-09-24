import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Me, SubscriptionView } from "@busmitra/contracts";
import { seedRoute, seedStudent, seedTracker, seedTrip } from "@busmitra/db/testing";
import type { Osrm } from "@busmitra/engine/osrm";
import { writeFleetIfNewer } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { createTestGateway, TRACKER_KEY } from "../../testing.ts";

/**
 * /v1/me — the home pin and the trip subscription (BUILD_PLAN Stage 5). These endpoints use the
 * service role, which bypasses RLS, so their authorisation is tested here by attacking each one
 * as another student (invariant 12).
 */

const live = await redisAvailable();

describe.skipIf(!live)("/v1/me (Stage 5)", () => {
  let t: TestRedis;
  let gw: Awaited<ReturnType<typeof createTestGateway>>;
  let a: { id: string; token: string };
  let b: { id: string; token: string };
  let trip: string;
  let otherTrip: string;
  let stops: string[];
  let busId: string;
  const walks: number[] = [];
  const foot: Osrm = {
    async match() {
      throw new Error("unused");
    },
    async route() {
      walks.push(1);
      return { line: [], distanceM: 640, durationS: 480, waypoints: [], legs: [] };
    },
  };

  const call = (
    who: { token: string },
    method: "GET" | "PUT" | "POST" | "DELETE",
    url: string,
    body?: unknown,
  ) =>
    gw.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${who.token}` },
      ...(body ? { payload: body } : {}),
    });

  beforeAll(async () => {
    t = await createTestRedis();
    gw = await createTestGateway({ redis: t, osrmFoot: foot });
    const mk = async (roll: string, phone: string) => {
      const id = (await seedStudent(gw.db, { rollNo: roll, phone })).userId!;
      return { id, token: await gw.tokenFor(id) };
    };
    a = await mk("160125737501", "+919999900501");
    b = await mk("160125737502", "+919999900502");
    const r = await seedRoute(gw.db, {
      coords: [
        { lat: 17.3688, lng: 78.5247 },
        { lat: 17.3688, lng: 78.5647 },
      ],
      published: true,
      stops: [
        { name: "M1", offset: 0, lat: 17.3688, lng: 78.5247 },
        { name: "M2", offset: 2000, lat: 17.3688, lng: 78.5436 },
        { name: "M3", offset: 4000, lat: 17.3688, lng: 78.5626 },
      ],
    });
    stops = r.stopIds;
    busId = (
      await seedTracker(gw.db, {
        busNumber: "71",
        deviceUid: "d-71",
        secret: "s",
        key: TRACKER_KEY,
      })
    ).busId;
    trip = await seedTrip(gw.db, { busId, routeId: r.routeId });
    const other = await seedTracker(gw.db, {
      busNumber: "72",
      deviceUid: "d-72",
      secret: "s",
      key: TRACKER_KEY,
    });
    otherTrip = await seedTrip(gw.db, { busId: other.busId, routeId: r.routeId });
    await writeFleetIfNewer(t.redis, t.keys, busId, {
      lat: 17.3688,
      lng: 78.53,
      spd: 20,
      hdg: 90,
      s: 600,
      seq: 0,
      tripId: trip,
      routeId: r.routeId,
      ts: new Date().toISOString(),
      state: "LIVE",
      cadence: 5,
    });
  });
  afterAll(async () => {
    await gw.app.close();
    await gw.db.close();
    await t.close();
  });

  it("stores the home pin coarsened to ~100 m, and only on the caller's own profile", async () => {
    const res = await call(a, "PUT", "/v1/me/home", {
      lat: 17.371234,
      lng: 78.521987,
      label: "Home",
      travelMode: "foot",
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as Me).home).toEqual({ lat: 17.371, lng: 78.522, label: "Home" });
    // B's view of themselves is untouched
    expect(((await call(b, "GET", "/v1/me")).json() as Me).home).toBeNull();
  });

  it("follows a bus from a stop, with the walking time from the pin", async () => {
    const res = await call(a, "POST", "/v1/me/subscription", { tripId: trip, stopId: stops[1] });
    expect(res.statusCode).toBe(201);
    const s = (res.json() as { subscription: SubscriptionView }).subscription;
    expect(s).toMatchObject({
      tripId: trip,
      busNumber: "71",
      state: "active",
      travelTimeS: 480,
      bufferS: 180,
    });
    expect(s.stop).toMatchObject({ id: stops[1], seq: 2 });
    const got = (await call(a, "GET", "/v1/me/subscription")).json() as {
      subscription: SubscriptionView;
    };
    expect(got.subscription.id).toBe(s.id);
  });

  it("refuses a stop the bus has already passed, a stop not on its route, a trip not running", async () => {
    const passed = await call(a, "POST", "/v1/me/subscription", { tripId: trip, stopId: stops[0] });
    expect(passed.statusCode).toBe(422);
    expect(passed.json().error).toBe("stop_passed");
    const nowhere = await gw.db.query<{ id: string }>(
      `INSERT INTO stops (name, location) VALUES ('Nowhere', ST_MakePoint(78.4, 17.4)::geography) RETURNING id`,
    );
    const off = await call(a, "POST", "/v1/me/subscription", {
      tripId: trip,
      stopId: nowhere.rows[0]!.id,
    });
    expect(off.json().error).toBe("stop_not_on_route");
    const ghost = await call(a, "POST", "/v1/me/subscription", {
      tripId: "00000000-0000-4000-8000-000000000000",
      stopId: stops[2],
    });
    expect(ghost.json().error).toBe("trip_not_running");
  });

  it("one bus a day: following another retires the first; changing stop re-arms leave-now", async () => {
    await gw.db.query(
      `UPDATE trip_subscriptions SET notified_departure_at = now() WHERE user_id = $1`,
      [a.id],
    );
    await call(a, "POST", "/v1/me/subscription", { tripId: trip, stopId: stops[2] });
    const rearmed = await gw.db.query<{ notified: boolean }>(
      `SELECT notified_departure_at IS NOT NULL AS notified FROM trip_subscriptions WHERE user_id = $1 AND trip_id = $2`,
      [a.id, trip],
    );
    expect(rearmed.rows[0]!.notified).toBe(false);
    await call(a, "POST", "/v1/me/subscription", { tripId: otherTrip, stopId: stops[2] });
    const states = await gw.db.query<{ trip_id: string; state: string }>(
      `SELECT trip_id, state FROM trip_subscriptions WHERE user_id = $1 ORDER BY created_at`,
      [a.id],
    );
    expect(states.rows).toEqual([
      { trip_id: trip, state: "completed" },
      { trip_id: otherTrip, state: "active" },
    ]);
  });

  it("another student can neither see nor delete A's subscription", async () => {
    const mine = (await call(a, "GET", "/v1/me/subscription")).json() as {
      subscription: SubscriptionView;
    };
    expect(
      ((await call(b, "GET", "/v1/me/subscription")).json() as { subscription: unknown })
        .subscription,
    ).toBeNull();
    const del = await call(b, "DELETE", `/v1/me/subscription/${mine.subscription.id}`);
    expect(del.statusCode).toBe(204); // answers the same as a real delete: no existence leak
    const still = await gw.db.query(`SELECT 1 FROM trip_subscriptions WHERE id = $1`, [
      mine.subscription.id,
    ]);
    expect(still.rows).toHaveLength(1);
    expect(
      (await call(a, "DELETE", `/v1/me/subscription/${mine.subscription.id}`)).statusCode,
    ).toBe(204);
    expect(
      (await gw.db.query(`SELECT 1 FROM trip_subscriptions WHERE id = $1`, [mine.subscription.id]))
        .rows,
    ).toEqual([]);
  });

  it("a student's own pin change is not written to the admin audit log", async () => {
    const { rows } = await gw.db.query(
      `SELECT action FROM audit_log WHERE entity = 'profiles' AND entity_id = $1 AND action = 'profiles.update'`,
      [a.id],
    );
    expect(rows).toEqual([]);
  });

  it("requires a signed-in student", async () => {
    expect((await gw.app.inject({ url: "/v1/me" })).statusCode).toBe(401);
    expect(
      (await gw.app.inject({ method: "PUT", url: "/v1/me/home", payload: { lat: 1, lng: 1 } }))
        .statusCode,
    ).toBe(401);
  });
});
