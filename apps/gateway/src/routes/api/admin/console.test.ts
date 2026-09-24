import { seedRoute, seedStudent } from "@busmitra/db/testing";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestGateway } from "../../../testing.ts";

/**
 * BUILD_PLAN Stage 7 — the admin console over HTTP: fleet, status → ticket → T0, tickets,
 * announcements, event-day CSV, audit. The notification itself is Stage 6; here the proof is
 * the committed row, the doorbell on `stream:notify`, and that nothing rings without a
 * confirmed count (invariant 11).
 */

type Gw = Awaited<ReturnType<typeof createTestGateway>>;
const live = await redisAvailable();

describe.skipIf(!live)("admin console (Stage 7)", () => {
  let gw: Gw;
  let r: TestRedis;
  let admin: string, adminToken: string, studentToken: string;
  let fan1: string, fan2: string;
  let routeId: string;

  const call = (method: string, url: string, payload?: unknown, token = adminToken) =>
    gw.app.inject({
      method: method as "GET",
      url,
      ...(payload !== undefined ? { payload: payload as object } : {}),
      headers: { authorization: `Bearer ${token}` },
    });
  const doorbells = async () =>
    (await r.redis.xrange(r.keys.streamNotify, "-", "+")).map(([, f]) => JSON.parse(f[1]!));
  const auditFor = (entity: string, id: string) =>
    gw.db.query<{
      action: string;
      actor_id: string;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
    }>(
      `SELECT action, actor_id, before, after FROM audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY id`,
      [entity, id],
    );

  beforeAll(async () => {
    r = await createTestRedis();
    gw = await createTestGateway({ redis: r });
    admin = (await seedStudent(gw.db, { rollNo: "TDADMIN77", role: "td_admin" })).userId!;
    adminToken = await gw.tokenFor(admin);
    const thisYear = new Date().getFullYear() - (new Date().getMonth() < 7 ? 1 : 0);
    fan1 = (await seedStudent(gw.db, { rollNo: "J7000001", admissionYear: thisYear })).userId!;
    fan2 = (await seedStudent(gw.db, { rollNo: "S7000001", admissionYear: thisYear - 2 })).userId!;
    studentToken = await gw.tokenFor(fan1);
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
  });
  afterAll(async () => {
    await gw?.db.close();
    await r?.close();
  });

  it("answers 404 to students on every new admin surface", async () => {
    for (const url of [
      "/v1/admin/buses",
      "/v1/admin/tickets",
      "/v1/admin/announcements",
      "/v1/admin/audit",
      "/v1/admin/dashboard",
      "/v1/admin/drivers",
      "/v1/admin/event-day?date=2026-10-02",
    ]) {
      expect((await call("GET", url, undefined, studentToken)).statusCode, url).toBe(404);
    }
  });

  let busId: string;
  it("creates a bus with a driver and a route, and audits both", async () => {
    const d = await call("POST", "/v1/admin/drivers", {
      full_name: "Ramesh K",
      phone: "99999 00301",
    });
    expect(d.statusCode).toBe(201);
    const b = await call("POST", "/v1/admin/buses", {
      bus_number: "14",
      registration_no: "ts09 ub 1234",
      capacity: 50,
      default_route_id: routeId,
      driver_id: d.json().id,
    });
    expect(b.statusCode).toBe(201);
    busId = b.json().id;
    expect((await call("POST", "/v1/admin/buses", { bus_number: "14" })).statusCode).toBe(409);

    const list = (await call("GET", "/v1/admin/buses")).json().buses;
    expect(list[0]).toMatchObject({
      bus_number: "14",
      registration_no: "TS09UB1234",
      route_name: "Uppal (inbound)",
      driver_name: "Ramesh K",
      driver_phone: "+919999900301",
      status: "active",
    });
    const audit = await auditFor("buses", busId);
    expect(audit.rows[0]).toMatchObject({ action: "buses.insert", actor_id: admin });
  });

  it("pairs a phone with a one-time link, rotates it, and unpairs it", async () => {
    const pair = await call("POST", `/v1/admin/buses/${busId}/trackers`);
    expect(pair.statusCode).toBe(201);
    const { device_uid, link } = pair.json();
    expect(link).toMatch(
      new RegExp(`^http://localhost:5173/#pair=${device_uid}\\.[A-Za-z0-9_-]{43}$`),
    );
    const rot = await call("POST", `/v1/admin/trackers/${device_uid}/rotate`);
    expect(rot.json().link).not.toBe(link);
    const list = (await call("GET", "/v1/admin/buses")).json().buses;
    expect(list[0].trackers.map((t: { device_uid: string }) => t.device_uid)).toEqual([device_uid]);
    // no secret ever comes back in a listing
    expect(JSON.stringify(list)).not.toMatch(/secret_enc|#pair=/);
    await call("POST", `/v1/admin/trackers/${device_uid}/unpair`);
    expect((await call("GET", "/v1/admin/buses")).json().buses[0].trackers).toEqual([]);
  });

  let ticketId: string;
  describe("out of commission → ticket → T0; resolve → T2 on the same ticket", () => {
    beforeAll(async () => {
      for (const u of [fan1, fan2])
        await gw.db.query(
          `INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, 'starred')`,
          [u, busId],
        );
      await r.redis.del(r.keys.streamNotify);
    });

    it("refuses without a count, with a stale count, and without the typed T0 confirmation", async () => {
      const url = `/v1/admin/buses/${busId}/status`;
      const base = { status: "out_of_commission", note: "Clutch failure at depot" };
      expect((await call("GET", `/v1/admin/buses/${busId}/audience`)).json()).toEqual({ count: 2 });
      const none = await call("PUT", url, base);
      expect(none.statusCode).toBe(428);
      expect(none.json()).toMatchObject({ error: "confirmation_required", count: 2 });
      const stale = await call("PUT", url, { ...base, confirm_count: 1, confirm_text: "1" });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error: "count_changed", count: 2 });
      const untyped = await call("PUT", url, { ...base, confirm_count: 2, confirm_text: "yes" });
      expect(untyped.json().error).toBe("typed_confirmation_required");
      // nothing happened: no ticket, bus still active, no doorbell
      expect(await doorbells()).toEqual([]);
      const t = await gw.db.query(`SELECT 1 FROM tickets WHERE bus_id = $1`, [busId]);
      expect(t.rows).toEqual([]);
    });

    it("opens one T0 ticket and rings once; a second click finds it", async () => {
      const url = `/v1/admin/buses/${busId}/status`;
      const body = {
        status: "out_of_commission",
        note: "Clutch failure at depot",
        confirm_count: 2,
        confirm_text: "2",
      };
      const res = await call("PUT", url, body);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "out_of_commission", notified: 2 });
      ticketId = res.json().ticket_id;
      const again = await call("PUT", url, body);
      expect(again.json().changed).toBe(false); // already out: no second ticket, no second T0
      const bells = await doorbells();
      expect(bells).toEqual([
        expect.objectContaining({ type: "ticket", ticketId, transition: "opened" }),
      ]);
      const t = await gw.db.query<{ severity: number; kind: string }>(
        `SELECT severity, kind FROM tickets WHERE id = $1`,
        [ticketId],
      );
      expect(t.rows[0]).toEqual({ severity: 0, kind: "out_of_commission" });
      // back in service only through the ticket
      const back = await call("PUT", url, { status: "active" });
      expect(back.statusCode).toBe(409);
      expect(back.json()).toMatchObject({ error: "resolve_ticket", ticket_id: ticketId });
    });

    it("moves through the queue with a timeline, and resolving returns the bus with a T2 doorbell", async () => {
      const act = (b: unknown) => call("POST", `/v1/admin/tickets/${ticketId}/actions`, b);
      expect((await act({ action: "acknowledge" })).json().status).toBe("acknowledged");
      expect((await act({ action: "acknowledge" })).statusCode).toBe(409); // already done
      expect((await act({ action: "assign", assigned_to: admin })).statusCode).toBe(200);
      expect((await act({ action: "cancel", note: "oops" })).statusCode).toBe(409); // only resolve
      expect((await act({ action: "resolve", note: "Clutch replaced" })).statusCode).toBe(428);
      const res = await act({ action: "resolve", note: "Clutch replaced", confirm_count: 2 });
      expect(res.json()).toMatchObject({ status: "resolved", notified: 2 });

      const bus = await gw.db.query<{ status: string }>(`SELECT status FROM buses WHERE id = $1`, [
        busId,
      ]);
      expect(bus.rows[0]!.status).toBe("active");
      const bells = await doorbells();
      expect(bells.map((b) => `${b.type}:${b.transition}:${b.ticketId === ticketId}`)).toEqual([
        "ticket:opened:true",
        "ticket:resolved:true",
      ]);
      const detail = (await call("GET", `/v1/admin/tickets/${ticketId}`)).json();
      expect(detail.events.map((e: { to_status: string }) => e.to_status)).toEqual([
        "open",
        "acknowledged",
        "acknowledged",
        "resolved",
      ]);
      expect(detail.events[2].note).toBe("assigned to Test TDADMIN77");
      expect(detail.ticket).toMatchObject({
        status: "resolved",
        resolution_note: "Clutch replaced",
      });
    });
  });

  describe("announcements", () => {
    beforeAll(() => r.redis.del(r.keys.streamNotify));

    it("previews the audience count live, including unmatched roll numbers", async () => {
      const p = (b: unknown) => call("POST", "/v1/admin/audience", b);
      expect((await p({ audience: "all" })).json()).toEqual({ count: 2, unmatched: [] });
      expect((await p({ audience: "juniors" })).json().count).toBe(1);
      expect((await p({ audience: "bus", audience_ref: busId })).json().count).toBe(2);
      expect((await p({ audience: "route", audience_ref: routeId })).json().count).toBe(2);
      expect((await p({ audience: "custom", roll_nos: ["j7000001", "NOPE999"] })).json()).toEqual({
        count: 1,
        unmatched: ["NOPE999"],
      });
    });

    it("sends only a confirmed count, stores a custom list, and rings once", async () => {
      const base = {
        tier: 2,
        title: "Exam day buses",
        body_md: "Buses leave **30 minutes** early.",
      };
      const noCount = await call("POST", "/v1/admin/announcements", {
        ...base,
        audience: "juniors",
      });
      expect(noCount.statusCode).toBe(400); // confirm_count is part of the request contract
      const wrong = await call("POST", "/v1/admin/announcements", {
        ...base,
        audience: "juniors",
        confirm_count: 5,
      });
      expect(wrong.json()).toMatchObject({ error: "count_changed", count: 1 });
      const ok = await call("POST", "/v1/admin/announcements", {
        ...base,
        audience: "custom",
        roll_nos: ["J7000001", "S7000001"],
        confirm_count: 2,
      });
      expect(ok.statusCode).toBe(201);
      expect(ok.json()).toMatchObject({ state: "sent", recipients: 2 });
      const rec = await gw.db.query(
        `SELECT user_id FROM announcement_recipients WHERE announcement_id = $1`,
        [ok.json().id],
      );
      expect(rec.rows).toHaveLength(2);
      expect(await doorbells()).toEqual([
        expect.objectContaining({ type: "announcement", announcementId: ok.json().id }),
      ]);
    });

    it("schedules for later without ringing, and can be cancelled until it is sent", async () => {
      await r.redis.del(r.keys.streamNotify);
      const when = new Date(Date.now() + 3600_000).toISOString();
      const res = await call("POST", "/v1/admin/announcements", {
        tier: 3,
        title: "Tomorrow",
        body_md: "Normal timings.",
        audience: "all",
        confirm_count: 2,
        scheduled_for: when,
      });
      expect(res.json()).toMatchObject({ state: "scheduled" });
      expect(await doorbells()).toEqual([]);
      const past = await call("POST", "/v1/admin/announcements", {
        tier: 3,
        title: "x",
        body_md: "y",
        audience: "all",
        confirm_count: 2,
        scheduled_for: new Date(Date.now() - 1000).toISOString(),
      });
      expect(past.statusCode).toBe(400);
      expect(
        (await call("POST", `/v1/admin/announcements/${res.json().id}/cancel`)).json().state,
      ).toBe("cancelled");
      expect(
        (await call("POST", `/v1/admin/announcements/${res.json().id}/cancel`)).statusCode,
      ).toBe(409);
      const list = (await call("GET", "/v1/admin/announcements")).json().announcements;
      expect(list.map((a: { state: string }) => a.state).sort()).toEqual(["cancelled", "sent"]);
    });

    it("needs the typed count for a critical announcement", async () => {
      const b = {
        tier: 0,
        title: "Buses cancelled",
        body_md: "No buses today.",
        audience: "all",
        confirm_count: 2,
      };
      expect((await call("POST", "/v1/admin/announcements", b)).json().error).toBe(
        "typed_confirmation_required",
      );
      expect(
        (await call("POST", "/v1/admin/announcements", { ...b, confirm_text: "2" })).statusCode,
      ).toBe(201);
    });
  });

  describe("event-day CSV", () => {
    const DATE = "2026-10-09";
    const upload = (csv: string, cohort = "both") =>
      gw.app.inject({
        method: "POST",
        url: `/v1/admin/event-day/uploads?service_date=${DATE}&cohort=${cohort}`,
        payload: csv,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "text/csv",
          "x-filename": "exam.csv",
        },
      });
    const apply = (id: string, body: unknown = {}) =>
      call("POST", `/v1/admin/event-day/uploads/${id}/apply`, body);
    beforeAll(() => r.redis.del(r.keys.streamNotify));

    it("rejects a malformed file at preview with per-row, per-column errors, and it cannot be applied", async () => {
      const res = await upload(
        "bus,route,time,cohort\n14,Uppal,7:40,seniors\n99,Uppal,26:00,freshers\n",
      );
      const body = res.json();
      expect(body.status).toBe("rejected");
      expect(body.errors).toEqual([
        { row: 3, column: "departure_time", message: '"26:00" is not a time like 7:40 AM' },
        { row: 3, column: "cohort", message: "must be junior, senior or both" },
      ]);
      expect((await apply(body.id, { confirm_count: 0 })).statusCode).toBe(409);
      const unknown = (await upload("bus,time\n99,7:40\n")).json();
      expect(unknown.errors).toEqual([
        { row: 2, column: "bus_number", message: "no bus 99 in the fleet" },
      ]);
      const rows = await gw.db.query(`SELECT 1 FROM event_day_buses WHERE service_date = $1`, [
        DATE,
      ]);
      expect(rows.rows).toEqual([]);
      expect(await doorbells()).toEqual([]); // sends nothing
    });

    it("previews a rendered diff and the count, applies on confirm, and notifies the changed cohorts", async () => {
      const csv = "bus,route,time,cohort\n14,Uppal,7:40,both\n";
      const p = (await upload(csv)).json();
      expect(p).toMatchObject({ status: "preview_ready", notify_count: 2, identical_to: null });
      expect(p.summary).toMatchObject({
        added: 2,
        changed: 0,
        removed: 0,
        notify_cohorts: ["junior", "senior"],
      });
      expect((await apply(p.id)).statusCode).toBe(428);
      const ok = await apply(p.id, { confirm_count: 2 });
      expect(ok.json()).toMatchObject({ status: "applied" });
      expect((await apply(p.id, { confirm_count: 2 })).statusCode).toBe(409); // twice is refused
      expect(await doorbells()).toEqual([
        expect.objectContaining({ type: "event_day", uploadId: p.id }),
      ]);
      const now = (await call("GET", `/v1/admin/event-day?date=${DATE}`)).json();
      expect(
        now.buses.map(
          (b: { cohort: string; departure_time: string }) => `${b.cohort} ${b.departure_time}`,
        ),
      ).toEqual(["junior 07:40", "senior 07:40"]);
    });

    it("re-uploading the identical file says so, and applying it notifies nobody", async () => {
      await r.redis.del(r.keys.streamNotify);
      const p = (await upload("bus,route,time,cohort\n14,Uppal,7:40,both\n")).json();
      expect(p.identical_to).not.toBeNull();
      expect(p).toMatchObject({ notify_count: 0, summary: { unchanged: 2, notify_cohorts: [] } });
      const ok = await apply(p.id); // no count needed: nobody is notified
      expect(ok.json().status).toBe("applied");
      expect(await doorbells()).toEqual([]);
    });
  });

  it("records every admin mutation in the audit log with before/after, and shows it", async () => {
    const res = (await call("GET", "/v1/admin/audit?people_only=1&limit=200")).json();
    const entities = new Set(res.entries.map((e: { entity: string }) => e.entity));
    for (const e of [
      "buses",
      "drivers",
      "trackers",
      "tickets",
      "ticket_events",
      "announcements",
      "announcement_recipients",
      "roster_uploads",
      "event_day_buses",
    ]) {
      expect(entities, e).toContain(e);
    }
    for (const e of res.entries) expect(e.actor_id).toBe(admin);
    const statusChange = res.entries.find(
      (e: { action: string; after: { status?: string } }) =>
        e.action === "buses.update" && e.after.status === "out_of_commission",
    );
    expect(statusChange.before.status).toBe("active");
    expect(statusChange.after.status).toBe("out_of_commission");
    // secrets never reach the log
    expect(JSON.stringify(res)).not.toMatch(/secret_enc|secret_prev_enc/);
  });

  it("serves the live fleet dashboard from fleet:live", async () => {
    const trip = await gw.db.query<{ id: string }>(
      `INSERT INTO trips (bus_id, route_id, service_date, shift, status, started_at)
       VALUES ($1, $2, operating_date(), 'evening', 'running', now()) RETURNING id`,
      [busId, routeId],
    );
    const ts = new Date(Date.now() - 20_000).toISOString();
    await r.redis.hset(
      r.keys.fleetLive,
      busId,
      JSON.stringify({
        lat: 17.37,
        lng: 78.53,
        spd: 30,
        hdg: 90,
        s: 100,
        seq: 0,
        tripId: trip.rows[0]!.id,
        ts,
        state: "DEGRADED",
        cadence: 5,
      }),
    );
    const d = (await call("GET", "/v1/admin/dashboard")).json();
    expect(d.live).toBe(true);
    expect(d.buses[0]).toMatchObject({
      bus_number: "14",
      presence: "DEGRADED",
      trip_status: "running",
      cadence_s: 5,
    });
    expect(d.buses[0].last_fix_age_s).toBeGreaterThanOrEqual(19);
  });
});
