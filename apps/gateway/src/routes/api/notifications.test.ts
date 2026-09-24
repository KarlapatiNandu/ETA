import { seedRoute, seedStudent, seedTrip } from "@busmitra/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestGateway, SMS_RECEIPT_TOKEN } from "../../testing.ts";

/**
 * BUILD_PLAN Stage 6 — the student's API over HTTP. These run as the service role, so the
 * per-caller scoping in each query is the authorisation; student B must never see or change A's.
 */

type Gw = Awaited<ReturnType<typeof createTestGateway>>;
let gw: Gw;
let a: string, b: string, tokA: string, tokB: string;
let busId: string, bus2: string, tripId: string, nid: string, stopIds: string[];

const call = (token: string, method: string, url: string, payload?: unknown) =>
  gw.app.inject({
    method: method as "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });

beforeAll(async () => {
  gw = await createTestGateway({ now: () => Date.parse("2026-09-24T02:10:00Z") });
  a = (await seedStudent(gw.db, { rollNo: "160125739001" })).userId!;
  b = (await seedStudent(gw.db, { rollNo: "160125739002", phone: "+919999900902" })).userId!;
  tokA = await gw.tokenFor(a);
  tokB = await gw.tokenFor(b);
  const route = await seedRoute(gw.db, {
    coords: [
      { lat: 17.3688, lng: 78.5247 },
      { lat: 17.3688, lng: 78.5812 },
    ],
    published: true,
    stops: [
      { name: "Gate", offset: 0, lat: 17.3688, lng: 78.5247 },
      { name: "Market", offset: 3000, lat: 17.3688, lng: 78.553 },
    ],
  });
  stopIds = route.stopIds;
  busId = (
    await gw.db.query<{ id: string }>(`INSERT INTO buses (bus_number) VALUES ('14') RETURNING id`)
  ).rows[0]!.id;
  bus2 = (
    await gw.db.query<{ id: string }>(`INSERT INTO buses (bus_number) VALUES ('22') RETURNING id`)
  ).rows[0]!.id;
  tripId = await seedTrip(gw.db, { busId, routeId: route.routeId });
  nid = (
    await gw.db.query<{ id: string }>(
      `INSERT INTO notifications (source_key, tier, category, title, body, bus_id, trip_id, payload)
       VALUES ('trip_start:x:starred', 3, 'bus_activated', 'Bus 14 has started', 'Taking it today?', $1, $2,
               '{"actions":[{"action":"follow","title":"Follow"}]}') RETURNING id`,
      [busId, tripId],
    )
  ).rows[0]!.id;
  await gw.db.query(
    `INSERT INTO notification_recipients (notification_id, user_id, dedupe_key, channel) VALUES ($1, $2, 'da', 'push')`,
    [nid, a],
  );
});
afterAll(() => gw.db.close());

describe("notification center", () => {
  it("lists only the caller's own entries, with a badge", async () => {
    const mine = (await call(tokA, "GET", "/v1/notifications")).json();
    expect(mine.items.map((n: { title: string }) => n.title)).toEqual(["Bus 14 has started"]);
    expect((await call(tokB, "GET", "/v1/notifications")).json().items).toEqual([]);
    expect((await call(tokA, "GET", "/v1/notifications/summary")).json()).toEqual({
      unread: 1,
      unacked_critical: 0,
    });
    expect((await gw.app.inject({ method: "GET", url: "/v1/notifications" })).statusCode).toBe(401);
  });

  it("marks read and acknowledges only the caller's row", async () => {
    expect((await call(tokB, "POST", `/v1/notifications/${nid}/ack`)).statusCode).toBe(404);
    expect((await call(tokA, "POST", `/v1/notifications/${nid}/ack`)).statusCode).toBe(204);
    const row = await gw.db.query<{ read: boolean; acked: boolean }>(
      `SELECT read_at IS NOT NULL AS read, acknowledged_at IS NOT NULL AS acked FROM notification_recipients WHERE user_id = $1`,
      [a],
    );
    expect(row.rows[0]).toEqual({ read: true, acked: true });
  });
});

describe("inline actions (ARCH §6.4)", () => {
  it("Not today mutes the bus until the end of the IST day without unstarring it", async () => {
    await call(tokA, "PUT", `/v1/me/favourites/${busId}`, { kind: "starred" });
    const res = await call(tokA, "POST", `/v1/notifications/${nid}/actions`, {
      action: "not_today",
    });
    expect(res.json()).toEqual({ action: "not_today", muted_until: "2026-09-24T18:29:59.000Z" });
    const fav = (await call(tokA, "GET", "/v1/me/favourites")).json().favourites;
    expect(fav).toEqual([
      expect.objectContaining({
        bus_number: "14",
        kind: "starred",
        muted_until: expect.any(String),
      }),
    ]);
    // someone else's notification id is simply not found
    expect(
      (await call(tokB, "POST", `/v1/notifications/${nid}/actions`, { action: "not_today" }))
        .statusCode,
    ).toBe(404);
  });

  it("Follow needs a home pin, then subscribes to the route stop nearest it", async () => {
    const noPin = await call(tokA, "POST", `/v1/notifications/${nid}/actions`, {
      action: "follow",
    });
    expect(noPin.statusCode).toBe(409);
    expect(noPin.json().error).toBe("no_home_pin");
    await gw.db.query(
      `UPDATE profiles SET home_location = ST_MakePoint(78.552, 17.369)::geography WHERE id = $1`,
      [a],
    );
    const ok = await call(tokA, "POST", `/v1/notifications/${nid}/actions`, { action: "follow" });
    expect(ok.json()).toMatchObject({ action: "follow", stop_id: stopIds[1] });
    const sub = await gw.db.query(
      `SELECT state FROM trip_subscriptions WHERE user_id = $1 AND trip_id = $2`,
      [a, tripId],
    );
    expect(sub.rows).toEqual([{ state: "active" }]);
  });
});

describe("favourites, kill switch and preferences", () => {
  it("keeps one main bus: making another main demotes the old one to starred", async () => {
    await call(tokA, "PUT", `/v1/me/favourites/${busId}`, { kind: "main" });
    await call(tokA, "PUT", `/v1/me/favourites/${bus2}`, { kind: "main" });
    const fav = (await call(tokA, "GET", "/v1/me/favourites")).json().favourites;
    expect(
      fav.map((f: { bus_number: string; kind: string }) => `${f.bus_number}:${f.kind}`),
    ).toEqual(["22:main", "14:starred"]);
    // B's list is untouched by A
    expect((await call(tokB, "GET", "/v1/me/favourites")).json().favourites).toEqual([]);
  });

  it("I'm on the bus: pauses three hours (capped at midnight IST) and boards today's trip", async () => {
    const res = (await call(tokA, "POST", "/v1/me/pause")).json();
    expect(res.alerts_paused_until).toBe("2026-09-24T05:10:00.000Z");
    const sub = await gw.db.query(`SELECT state FROM trip_subscriptions WHERE user_id = $1`, [a]);
    expect(sub.rows).toEqual([{ state: "boarded" }]);
    expect((await call(tokA, "DELETE", "/v1/me/pause")).statusCode).toBe(204);
    expect((await call(tokA, "GET", "/v1/me/alerts")).json().alerts_paused_until).toBeNull();
  });

  it("sets quiet hours and the maximum tier, validating both", async () => {
    const ok = await call(tokA, "PATCH", "/v1/me/alerts", {
      max_tier: 2,
      quiet_start_min: 1320,
      quiet_duration_min: 480,
    });
    expect(ok.json()).toEqual({
      max_tier: 2,
      critical_breakthrough: true,
      quiet_start_min: 1320,
      quiet_duration_min: 480,
    });
    expect((await call(tokA, "PATCH", "/v1/me/alerts", { quiet_start_min: 60 })).statusCode).toBe(
      400,
    );
    expect((await call(tokA, "PATCH", "/v1/me/alerts", { max_tier: 7 })).statusCode).toBe(400);
    const clear = await call(tokA, "PATCH", "/v1/me/alerts", {
      quiet_start_min: null,
      quiet_duration_min: null,
    });
    expect(clear.json()).toMatchObject({ quiet_start_min: null, quiet_duration_min: null });
    // a student's own preferences are not an admin action: not audited
    const audit = await gw.db.query(
      `SELECT 1 FROM audit_log WHERE entity = 'profiles' AND entity_id = $1 AND actor_id = $1`,
      [a],
    );
    expect(audit.rows).toEqual([]);
  });
});

describe("push subscriptions", () => {
  const sub = (endpoint: string) => ({
    endpoint,
    keys: { p256dh: "BPk", auth: "au" },
    standalone: true,
  });
  it("registers a browser, and moves an endpoint to whoever signs in on it", async () => {
    expect(
      (await call(tokA, "POST", "/v1/push/subscriptions", sub("https://fcm.test/1"))).statusCode,
    ).toBe(201);
    expect(
      (await call(tokB, "POST", "/v1/push/subscriptions", sub("https://fcm.test/1"))).statusCode,
    ).toBe(201);
    const rows = await gw.db.query(`SELECT user_id, is_standalone FROM push_subscriptions`);
    expect(rows.rows).toEqual([{ user_id: b, is_standalone: true }]);
    // A cannot remove B's
    await call(tokA, "DELETE", "/v1/push/subscriptions", { endpoint: "https://fcm.test/1" });
    expect((await gw.db.query(`SELECT 1 FROM push_subscriptions`)).rows).toHaveLength(1);
    expect(
      (await call(tokA, "POST", "/v1/push/subscriptions", { endpoint: "not a url", keys: {} }))
        .statusCode,
    ).toBe(400);
  });
});

describe("SMS delivery receipts", () => {
  it("is a 404 without the token, and marks the SMS delivered with it", async () => {
    await gw.db.query(
      `UPDATE notification_recipients SET provider_ref = 'req-77', channel = 'sms' WHERE user_id = $1`,
      [a],
    );
    const noTok = await gw.app.inject({
      method: "POST",
      url: "/v1/notify/sms-receipt",
      payload: {},
    });
    expect(noTok.statusCode).toBe(404);
    const res = await gw.app.inject({
      method: "POST",
      url: `/v1/notify/sms-receipt?token=${SMS_RECEIPT_TOKEN}`,
      payload: {
        data: [{ requestId: "req-77", report: [{ status: "1", number: "919999900001" }] }],
      },
    });
    expect(res.json()).toEqual({ received: 1 });
    const row = await gw.db.query<{ delivered: boolean }>(
      `SELECT delivered_at IS NOT NULL AS delivered FROM notification_recipients WHERE provider_ref = 'req-77'`,
    );
    expect(row.rows).toEqual([{ delivered: true }]);
  });
});
