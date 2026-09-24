import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseEventDayCsv } from "@busmitra/contracts";
import { withContext } from "@busmitra/db";
import { createTestDb, seedRoute, seedStudent, seedTrip, type TestDb } from "@busmitra/db/testing";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { audienceUserIds, countAudience, resolveRollNos } from "../lib/audience.ts";
import { dispatchDueAnnouncements } from "./announcements.ts";
import { applyEventDay, diffEventDay, loadEventDay, resolveEventDay } from "./event-day.ts";
import { materialiseEventDayTrips } from "./schedule.ts";
import { syncSignalTickets } from "./tickets.ts";

/** BUILD_PLAN Stage 7 — the admin console's engine half. */

let db: TestDb;
let admin: string, j1: string, j2: string, s1: string;
let bus14: string, bus22: string;
let route: { routeId: string; lineageId: string };
const LINE = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5812 },
];

beforeAll(async () => {
  db = await createTestDb();
  admin = (await seedStudent(db, { rollNo: "TDADMIN70", role: "td_admin" })).userId!;
  // admission year decides the cohort: this year's intake are juniors
  const thisYear = new Date().getFullYear() - (new Date().getMonth() < 7 ? 1 : 0);
  j1 = (await seedStudent(db, { rollNo: "J0000001", admissionYear: thisYear })).userId!;
  j2 = (await seedStudent(db, { rollNo: "J0000002", admissionYear: thisYear })).userId!;
  s1 = (await seedStudent(db, { rollNo: "S0000001", admissionYear: thisYear - 2 })).userId!;
  route = await seedRoute(db, { coords: LINE, name: "Dilsukhnagar", published: true });
  const mk = async (n: string, status = "active") =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO buses (bus_number, status, default_route_id) VALUES ($1, $2, $3) RETURNING id`,
        [n, status, route.routeId],
      )
    ).rows[0]!.id;
  bus14 = await mk("14");
  bus22 = await mk("22", "maintenance");
  await mk("9", "retired"); // a retired bus the event-day check must refuse
});
afterAll(() => db.close());

describe("audience resolution (one definition for the preview and the fan-out)", () => {
  it("resolves cohorts, a bus, a route lineage and roll numbers", async () => {
    expect(await countAudience(db, { kind: "all" })).toBe(3); // students only, not the admin
    expect(await audienceUserIds(db, { kind: "juniors" })).toEqual([j1, j2].sort());
    expect(await audienceUserIds(db, { kind: "seniors" })).toEqual([s1]);

    await db.query(`INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, 'main')`, [
      j1,
      bus14,
    ]);
    // j2 follows bus 14's trip today without having starred it
    const trip = await seedTrip(db, { busId: bus14, routeId: route.routeId });
    const stop = await db.query<{ id: string }>(
      `INSERT INTO stops (name, location) VALUES ('Gate', ST_MakePoint(78.53, 17.3688)::geography) RETURNING id`,
    );
    await db.query(
      `INSERT INTO trip_subscriptions (user_id, trip_id, target_stop_id) VALUES ($1, $2, $3)`,
      [j2, trip, stop.rows[0]!.id],
    );
    expect(await audienceUserIds(db, { kind: "bus", busId: bus14 })).toEqual([j1, j2].sort());
    expect(await countAudience(db, { kind: "bus", busId: bus22 })).toBe(0);
    // any version of the route reaches the same riders
    expect(await countAudience(db, { kind: "route", routeId: route.routeId })).toBe(2);

    const r = await resolveRollNos(db, ["j0000001", "S0000001", "NOPE123"]);
    expect(r.userIds.sort()).toEqual([j1, s1].sort());
    expect(r.unmatched).toEqual(["NOPE123"]);
    await db.query(`UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1`, [trip]);
  });
});

describe("event-day lists", () => {
  const DATE = "2026-10-02";
  const upload = async () =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO roster_uploads (kind, service_date, file_path, original_name, content_hash, uploaded_by, status)
         VALUES ('event_day_buses', $1, 'x', 'x.csv', 'h', $2, 'preview_ready') RETURNING id`,
        [DATE, admin],
      )
    ).rows[0]!.id;

  it("checks buses and routes against the fleet: errors reject, warnings inform", async () => {
    const parsed = parseEventDayCsv(
      [
        "bus,route,time,cohort",
        "14,Dilsukhnagar,7:10,senior",
        "99,,7:20,senior",
        "9,,7:30,junior",
        "5,Nowhere,8:00,junior",
      ].join("\n"),
    );
    const r = await resolveEventDay(db, parsed.rows);
    expect(r.rows).toEqual([]);
    expect(r.errors).toEqual([
      { row: 3, column: "bus_number", message: "no bus 99 in the fleet" },
      { row: 4, column: "bus_number", message: "bus 9 is retired" },
      { row: 5, column: "bus_number", message: "no bus 5 in the fleet" },
    ]);
    const ok = await resolveEventDay(db, parseEventDayCsv("bus,time,cohort\n22,,junior").rows);
    expect(ok.errors).toEqual([]);
    expect(ok.rows[0]!.route_id).toBe(route.routeId); // the bus's default route
    expect(ok.warnings.map((w) => w.message)).toEqual([
      "bus 22 is marked maintenance",
      "no departure time — students will not see when it leaves",
    ]);
  });

  it("diffs against the published list, applies it, and an identical re-apply changes nothing", async () => {
    const csv = "bus,route,time,cohort\n14,Dilsukhnagar,7:10,senior\n22,,8:00,both";
    const rows = (await resolveEventDay(db, parseEventDayCsv(csv).rows)).rows;
    const first = diffEventDay(await loadEventDay(db, DATE), rows);
    expect([first.added.length, first.changed.length, first.removed.length]).toEqual([3, 0, 0]);
    expect(first.notify_cohorts).toEqual(["junior", "senior"]);
    const up = await upload();
    await withContext(db, { actorId: admin, ip: null, userAgent: "vitest" }, (q) =>
      applyEventDay(q, up, DATE, rows),
    );
    expect(
      (await loadEventDay(db, DATE)).map(
        (r) => `${r.cohort} ${r.bus_number_raw} ${r.departure_time}`,
      ),
    ).toEqual(["junior 22 08:00", "senior 14 07:10", "senior 22 08:00"]);
    const audited = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_log WHERE entity = 'event_day_buses' AND actor_id = $1`,
      [admin],
    );
    expect(audited.rows[0]!.n).toBe(3);

    const again = diffEventDay(await loadEventDay(db, DATE), rows);
    expect(again).toMatchObject({
      added: [],
      changed: [],
      removed: [],
      unchanged: 3,
      notify_cohorts: [],
    });
    await withContext(db, { actorId: admin, ip: null, userAgent: "vitest" }, (q) =>
      applyEventDay(q, up, DATE, rows),
    );
    const still = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_log WHERE entity = 'event_day_buses'`,
    );
    expect(still.rows[0]!.n).toBe(3); // unchanged rows are not rewritten
  });

  it("a seniors-only file changes only the seniors' list, and reports moved times and removals", async () => {
    const rows = (
      await resolveEventDay(db, parseEventDayCsv("bus,time,cohort\n14,7:25,senior").rows)
    ).rows;
    const d = diffEventDay(await loadEventDay(db, DATE), rows);
    expect(d.cohorts).toEqual(["senior"]);
    expect(d.changed).toEqual([
      {
        cohort: "senior",
        bus_number: "14",
        fields: { departure_time: { from: "07:10", to: "07:25" } },
      },
    ]);
    expect(d.removed.map((r) => `${r.cohort} ${r.bus_number}`)).toEqual(["senior 22"]);
    expect(d.notify_cohorts).toEqual(["senior"]);
    await applyEventDay(db, await upload(), DATE, rows);
    expect((await loadEventDay(db, DATE)).map((r) => `${r.cohort} ${r.bus_number_raw}`)).toEqual([
      "junior 22",
      "senior 14",
    ]);
  });
});

describe("scheduled trips from today's event-day list", () => {
  const DAY = "2026-10-05";
  // 06:30 IST on DAY
  const NOW = Date.parse(`${DAY}T01:00:00Z`);

  beforeAll(async () => {
    const up = await db.query<{ id: string }>(
      `INSERT INTO roster_uploads (kind, service_date, file_path, original_name, content_hash, uploaded_by, status)
       VALUES ('event_day_buses', $1, 'x', 'x.csv', 'h2', $2, 'applied') RETURNING id`,
      [DAY, admin],
    );
    const bus5 = (
      await db.query<{ id: string }>(`INSERT INTO buses (bus_number) VALUES ('5') RETURNING id`)
    ).rows[0]!.id;
    for (const [bus, cohort, time] of [
      [bus5, "senior", "07:10"],
      [bus5, "junior", "08:00"],
    ] as const) {
      await db.query(
        `INSERT INTO event_day_buses (upload_id, service_date, cohort, bus_id, bus_number_raw, route_id, departure_time)
         VALUES ($1, $2, $3, $4, '5', $5, $6)`,
        [up.rows[0]!.id, DAY, cohort, bus, route.routeId, time],
      );
    }
  });

  const tripsOf5 = () =>
    db.query<{ status: string; start: string; shift: string; run_seq: number }>(
      `SELECT t.status, to_char(t.scheduled_start_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS start,
              t.shift, t.run_seq
         FROM trips t JOIN buses b ON b.id = t.bus_id WHERE b.bus_number = '5' ORDER BY t.scheduled_start_at`,
    );

  it("schedules only the bus's next departure, once, on the service day itself", async () => {
    // the day before: nothing (a trip scheduled for tomorrow would be resumed by today's START)
    expect((await materialiseEventDayTrips(db, NOW - 86_400_000)).scheduled).toBe(0);
    expect((await materialiseEventDayTrips(db, NOW)).scheduled).toBe(1);
    expect((await materialiseEventDayTrips(db, NOW)).scheduled).toBe(0); // idempotent
    expect((await tripsOf5()).rows).toEqual([
      { status: "scheduled", start: "07:10", shift: "morning", run_seq: 1 },
    ]);
  });

  it("schedules the next run once the first one has run", async () => {
    await db.query(
      `UPDATE trips SET status = 'completed', started_at = now(), ended_at = now()
        WHERE bus_id = (SELECT id FROM buses WHERE bus_number = '5')`,
    );
    await materialiseEventDayTrips(db, NOW + 3600_000);
    expect((await tripsOf5()).rows.map((r) => `${r.status} ${r.start} #${r.run_seq}`)).toEqual([
      "completed 07:10 #1",
      "scheduled 08:00 #2",
    ]);
  });

  it("cancels a scheduled trip nobody started, two hours after its time", async () => {
    const r = await materialiseEventDayTrips(db, NOW + 5 * 3600_000);
    expect(r.abandoned).toBe(1);
    expect((await tripsOf5()).rows.map((x) => x.status)).toEqual(["completed", "cancelled"]);
  });
});

describe("automatic signal-loss tickets", () => {
  let trip: string;
  const T = Date.parse("2026-10-06T02:00:00Z");
  const outage = (startedAt: number, zone: string | null = null) =>
    db.query<{ id: string }>(
      `INSERT INTO signal_outages (trip_id, bus_id, entry_point, started_at, dead_zone_id)
       VALUES ($1, $2, ST_MakePoint(78.55, 17.3688)::geography, $3, $4) RETURNING id`,
      [trip, bus22, new Date(startedAt).toISOString(), zone],
    );

  beforeAll(async () => {
    trip = await seedTrip(db, { busId: bus22, routeId: route.routeId, status: "dark" });
  });

  it("opens one ticket after five minutes outside a known dead zone, and resolves it on recovery", async () => {
    const o = await outage(T);
    expect((await syncSignalTickets(db, T + 299_000)).opened).toEqual([]);
    const { opened } = await syncSignalTickets(db, T + 301_000);
    expect(opened).toHaveLength(1);
    expect((await syncSignalTickets(db, T + 400_000)).opened).toEqual([]); // one per outage
    const t = await db.query<{ title: string; status: string; opened_by: string | null }>(
      `SELECT title, status, opened_by FROM tickets WHERE id = $1`,
      opened,
    );
    expect(t.rows[0]).toEqual({ title: "No signal from bus 22", status: "open", opened_by: null });

    // a real recovery, as the presence sweeper writes it: with the fix it came back at
    await db.query(
      `UPDATE signal_outages SET recovered_at = $2,
              exit_point = ST_MakePoint(78.552, 17.3688)::geography WHERE id = $1`,
      [o.rows[0]!.id, new Date(T + 420_000).toISOString()],
    );
    const { resolved } = await syncSignalTickets(db, T + 430_000);
    expect(resolved).toEqual(opened);
    const ev = await db.query<{ from_status: string; to_status: string; note: string }>(
      `SELECT from_status, to_status, note FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at`,
      opened,
    );
    expect(ev.rows.map((e) => e.to_status)).toEqual(["open", "resolved"]);
    expect(ev.rows[1]!.note).toBe("Signal came back after 7 min.");
  });

  it("does not ticket an outage in a known dead zone", async () => {
    const zone = await db.query<{ id: string }>(
      `INSERT INTO dead_zones (polygon, sample_count, avg_outage_s, p90_outage_s, confidence, last_observed_at)
       VALUES (ST_Buffer(ST_MakePoint(78.55, 17.3688)::geography, 200)::geography, 5, 90, 150, 0.8, now()) RETURNING id`,
    );
    await outage(T + 600_000, zone.rows[0]!.id);
    expect((await syncSignalTickets(db, T + 2_000_000)).opened).toEqual([]);
  });
  it("never tickets an outage on a trip that has ended, and closes one whose trip ends", async () => {
    await db.query(
      `UPDATE signal_outages SET recovered_at = now() WHERE trip_id = $1 AND recovered_at IS NULL`,
      [trip],
    );
    await outage(T + 500_000);
    const { opened } = await syncSignalTickets(db, T + 900_000);
    expect(opened).toHaveLength(1);
    await db.query(`UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1`, [trip]);
    const { resolved } = await syncSignalTickets(db, T + 950_000);
    expect(resolved).toEqual(opened);
    const t = await db.query<{ resolution_note: string }>(
      `SELECT resolution_note FROM tickets WHERE id = $1`,
      opened,
    );
    expect(t.rows[0]!.resolution_note).toBe("The trip ended while the bus was still silent.");
    // the trip's end closed the outage (0009) without an exit point — the bus never came back,
    // so it is not a dead-zone observation — and no new ticket opens for it
    const closed = await db.query<{ open: boolean; exit: boolean }>(
      `SELECT recovered_at IS NULL AS open, exit_point IS NOT NULL AS exit
         FROM signal_outages WHERE trip_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [trip],
    );
    expect(closed.rows[0]).toEqual({ open: false, exit: false });
    expect((await syncSignalTickets(db, T + 2_000_000)).opened).toEqual([]);
  });
});

const live = await redisAvailable();
describe.skipIf(!live)("scheduled announcements", () => {
  let r: TestRedis;
  beforeAll(async () => {
    r = await createTestRedis();
  });
  afterAll(() => r?.close());

  it("publishes only what is due, once, and never a cancelled one", async () => {
    const ins = (when: string, cancelled = false) =>
      db.query<{ id: string }>(
        `INSERT INTO announcements (tier, audience, title, body_md, confirmed_count, scheduled_for, cancelled_at, created_by)
         VALUES (2, 'all', 't', 'b', 3, $1, $2, $3) RETURNING id`,
        [when, cancelled ? when : null, admin],
      );
    const due = (await ins("2026-10-07T02:00:00Z")).rows[0]!.id;
    await ins("2026-10-07T02:00:00Z", true);
    await ins("2026-10-07T09:00:00Z");
    const now = () => Date.parse("2026-10-07T02:00:30Z");
    expect(await dispatchDueAnnouncements({ db, redis: r.redis, keys: r.keys, now })).toEqual([
      due,
    ]);
    expect(await dispatchDueAnnouncements({ db, redis: r.redis, keys: r.keys, now })).toEqual([]);
    const entries = await r.redis.xrange(r.keys.streamNotify, "-", "+");
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]![1][1]!)).toMatchObject({
      type: "announcement",
      announcementId: due,
    });
  });
});
