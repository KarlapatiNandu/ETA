import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NotifyEvent, SseEvent } from "@busmitra/contracts";
import { createTestDb, seedRoute, seedTrip, type TestDb } from "@busmitra/db/testing";
import type { PushMessage, PushSender, SmsMessage, SmsSender } from "@busmitra/notify";
import type { StreamEntry } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import {
  deliverDue,
  processBroadcastEntries,
  processNotifyEntries,
  recoverLost,
  type NotifyDeps,
} from "./notify.ts";

/**
 * BUILD_PLAN Stage 6 — "Test hardest here". Real Postgres semantics (PGlite), real Redis, fake
 * transports that record every call and can be told to fail.
 */

const live = await redisAvailable();

function fakePush() {
  const sent: { endpoint: string; msg: PushMessage }[] = [];
  let status = (_endpoint: string) => 201;
  let crashAfter = Infinity;
  let latencyMs = 0;
  const sender: PushSender = {
    async send(target, msg) {
      if (sent.length >= crashAfter) throw new Error("worker killed mid fan-out");
      if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
      sent.push({ endpoint: target.endpoint, msg });
      return { status: status(target.endpoint) };
    },
  };
  return {
    sender,
    sent,
    setStatus: (f: (e: string) => number) => void (status = f),
    crashAfter: (n: number) => void (crashAfter = n),
    latency: (ms: number) => void (latencyMs = ms),
    reset() {
      sent.length = 0;
      status = () => 201;
      crashAfter = Infinity;
      latencyMs = 0;
    },
  };
}

function fakeSms() {
  const sent: SmsMessage[] = [];
  let fail = false;
  const sender: SmsSender = {
    async send(m) {
      if (fail) throw new Error("MSG91 rejected the message: HTTP 500");
      sent.push(m);
      return { ref: `req-${sent.length}` };
    },
  };
  return { sender, sent, fail: (f: boolean) => void (fail = f) };
}

describe.skipIf(!live)("notification spine (Stage 6)", () => {
  let db: TestDb;
  let r: TestRedis;
  const push = fakePush();
  const sms = fakeSms();
  let deps: NotifyDeps;
  let now = Date.parse("2026-09-24T02:10:00Z"); // 07:40 IST
  let busId: string, routeId: string, tripId: string;
  let stopIds: string[] = [];
  let admin: string;
  const users: Record<string, string> = {};
  let seq = 0;
  const entry = (data: unknown): StreamEntry<unknown> => ({ id: `${++seq}-0`, data });

  /** n synthetic students at once (generate_series), each with one push subscription. */
  async function students(
    prefix: string,
    n: number,
    opts: { push?: boolean; cohort?: string } = {},
  ) {
    const { rows } = await db.query<{ id: string; roll_no: string }>(
      `WITH s AS (SELECT i, $1 || lpad(i::text, 5, '0') AS roll FROM generate_series(1, $2) i),
            ro AS (INSERT INTO roster_students (roll_no, full_name, admission_year, cohort, phone_e164)
                   SELECT roll, 'Test ' || roll, 2023, $3::cohort_t, '+9199999' || lpad(i::text, 5, '0') FROM s
                   RETURNING roll_no, phone_e164),
            au AS (INSERT INTO auth.users (email) SELECT lower(roll_no) || '@students.busmitra.internal' FROM ro
                   RETURNING id, email)
       INSERT INTO profiles (id, roll_no, full_name, cohort, phone_e164, phone_verified_at)
       SELECT au.id, ro.roll_no, 'Test ' || ro.roll_no, $3::cohort_t, ro.phone_e164, now()
         FROM au JOIN ro ON lower(ro.roll_no) || '@students.busmitra.internal' = au.email
       RETURNING id, roll_no`,
      [prefix, n, opts.cohort ?? "senior"],
    );
    if (opts.push !== false) {
      await db.query(
        `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
         SELECT id, 'https://push.test/' || id, 'p', 'a' FROM profiles WHERE roll_no LIKE $1 || '%'`,
        [prefix],
      );
    }
    return rows.map((x) => x.id);
  }

  const pushesTo = (userId: string) => push.sent.filter((s) => s.endpoint.endsWith(userId)).length;
  const centre = (userId: string) =>
    db.query<{
      title: string;
      tier: number;
      channel: string | null;
      failure_reason: string | null;
      source_key: string;
    }>(
      `SELECT n.title, n.tier, r.channel, r.failure_reason, n.source_key
         FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
        WHERE r.user_id = $1 ORDER BY r.queued_at, n.created_at`,
      [userId],
    );
  const drain = async () => {
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const rep = await deliverDue(deps);
      total += rep.claimed;
      if (!rep.claimed) break;
    }
    return total;
  };
  const announce = async (tier: number, audience = "all", title = "Exam day") => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO announcements (tier, audience, title, body_md, confirmed_count, published_at, created_by)
       VALUES ($1, $2, $3, 'Buses leave **early**.', 0, $4, $5) RETURNING id`,
      [tier, audience, title, new Date(now).toISOString(), admin],
    );
    return rows[0]!.id;
  };

  beforeAll(async () => {
    db = await createTestDb();
    r = await createTestRedis();
    deps = { db, redis: r.redis, keys: r.keys, push: push.sender, sms: sms.sender, now: () => now };
    admin = (await students("ADM", 1, { push: false }))[0]!;
    await db.query(`UPDATE profiles SET role = 'td_admin' WHERE id = $1`, [admin]);
    for (const name of ["main", "star", "rider", "paused", "quiet", "nopush"]) {
      users[name] = (await students(name.toUpperCase(), 1, { push: name !== "nopush" }))[0]!;
    }
    const route = await seedRoute(db, {
      coords: [
        { lat: 17.3688, lng: 78.5247 },
        { lat: 17.3688, lng: 78.5812 },
      ],
      name: "Dilsukhnagar",
      published: true,
      stops: [0, 1500, 3000, 4500, 6000].map((offset, i) => ({
        name: `Stop ${i + 1}`,
        offset,
        lat: 17.3688,
        lng: 78.5247 + (offset / 6000) * 0.0565,
      })),
    });
    routeId = route.routeId;
    stopIds = route.stopIds;
    busId = (
      await db.query<{ id: string }>(`INSERT INTO buses (bus_number) VALUES ('14') RETURNING id`)
    ).rows[0]!.id;
    tripId = await seedTrip(db, { busId, routeId });
    await db.query(
      `INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, 'main'), ($3, $2, 'starred')`,
      [users.main, busId, users.star],
    );
    // the rider follows today's trip to stop 5
    await db.query(
      `INSERT INTO trip_subscriptions (user_id, trip_id, target_stop_id, travel_time_s) VALUES ($1, $2, $3, 300)`,
      [users.rider, tripId, stopIds[4]],
    );
  });
  afterAll(async () => {
    await db?.close();
    await r?.close();
  });
  beforeEach(() => {
    push.reset();
    sms.sent.length = 0;
    sms.fail(false);
  });

  it("restarting the worker mid fan-out produces zero duplicates, and the center has everyone", async () => {
    const crowd = await students("CROWD", 80);
    const id = await announce(2, "all", "Crash test");
    const bell: NotifyEvent = {
      type: "announcement",
      announcementId: id,
      at: new Date(now).toISOString(),
    };
    await processNotifyEntries(deps, [entry(bell)]);
    push.crashAfter(30);
    await expect(deliverDue(deps)).rejects.toThrow(/killed/);
    const firstRun = push.sent.length;
    expect(firstRun).toBe(30);
    // the restarted worker re-reads the unacknowledged doorbell and drains the queue
    push.crashAfter(Infinity);
    await processNotifyEntries(deps, [entry(bell)]);
    await drain();
    for (const u of crowd) expect(pushesTo(u)).toBeLessThanOrEqual(1);
    const parents = await db.query(`SELECT id FROM notifications WHERE source_key = $1`, [
      `announcement:${id}`,
    ]);
    expect(parents.rows).toHaveLength(1);
    const rows = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM notification_recipients WHERE notification_id = $1`,
      [parents.rows[0]!.id as string],
    );
    // every student (crowd + the named ones), once each
    expect(rows.rows[0]!.n).toBe(crowd.length + 6);
    // at most once per student: the ones claimed as the worker died lost their buzz, not their record
    expect(push.sent.length).toBeGreaterThan(crowd.length - 64);
    const ann = await db.query<{ notification_id: string }>(
      `SELECT notification_id FROM announcements WHERE id = $1`,
      [id],
    );
    expect(ann.rows[0]!.notification_id).toBe(parents.rows[0]!.id);
    await db.query(
      `DELETE FROM push_subscriptions WHERE endpoint LIKE '%' AND user_id = ANY($1::text[]::uuid[])`,
      [crowd],
    );
    await db.query(`DELETE FROM profiles WHERE id = ANY($1::text[]::uuid[])`, [crowd]);
  });

  const stopReached = (
    s: number,
    event: "arrived" | "skipped" | "departed" = "arrived",
    extra = {},
  ): SseEvent => ({
    type: "stop.reached",
    data: {
      tripId,
      stopId: stopIds[s - 1]!,
      seq: s,
      busId,
      event,
      at: new Date(now).toISOString(),
      ...extra,
    },
  });

  it("a geofence flapping 20 times produces one arrival notification", async () => {
    const flaps = Array.from({ length: 20 }, (_, i) =>
      entry(stopReached(1, i % 2 ? "departed" : "arrived")),
    );
    await processBroadcastEntries(deps, flaps);
    await drain();
    const mine = (await centre(users.rider!)).rows.filter((n) => n.source_key.startsWith("stop:"));
    expect(mine.map((n) => n.title)).toEqual(["Bus 14 — at Stop 1"]);
    expect(pushesTo(users.rider!)).toBe(1);
    expect(push.sent[0]!.msg).toMatchObject({ tag: `trip-${tripId}-progress`, renotify: false });
  });

  it("a stop passed unconfirmed fires `skipped`, and every later stop still notifies", async () => {
    await processBroadcastEntries(deps, [
      entry(stopReached(2, "skipped")),
      entry(stopReached(3)),
      entry(stopReached(4)),
    ]);
    await drain();
    const titles = (await centre(users.rider!)).rows
      .filter((n) => n.source_key.startsWith("stop:"))
      .map((n) => n.title);
    expect(titles).toEqual([
      "Bus 14 — at Stop 1",
      "Bus 14 passed Stop 2",
      "Bus 14 — at Stop 3",
      "Bus 14 — at Stop 4",
    ]);
    // one updating notification on the phone: every one shares the collapse tag
    expect(new Set(push.sent.map((s) => s.msg.tag))).toEqual(new Set([`trip-${tripId}-progress`]));
  });

  it("replaying a full day of backfilled pings fires zero retroactive alerts", async () => {
    const before = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM notifications`))
      .rows[0]!.n;
    const day = Array.from({ length: 5 }, (_, i) => [
      entry(stopReached(i + 1, "arrived", { backfill: true })),
      // and the same crossings, not flagged but hours old
      entry({
        ...stopReached(i + 1),
        data: { ...stopReached(i + 1).data, at: new Date(now - 6 * 3600_000).toISOString() },
      }),
      entry({
        type: "bus.status",
        data: {
          id: busId,
          state: "DARK",
          reason: "signal_lost",
          cadence: 5,
          lastSeenAt: new Date(now - 7 * 3600_000).toISOString(),
          tripId,
          at: new Date(now - 7 * 3600_000).toISOString(),
        },
      }),
    ]).flat();
    await processBroadcastEntries(deps, day);
    await drain();
    const after = (await db.query<{ n: number }>(`SELECT count(*)::int n FROM notifications`))
      .rows[0]!.n;
    expect(after).toBe(before);
    expect(push.sent).toEqual([]);
  });

  it("a stale leave-now reaches the center only — never a late buzz", async () => {
    const e: NotifyEvent = {
      type: "leave_now",
      subscriptionId: "0b5e0000-0000-4000-8000-000000000001",
      userId: users.rider!,
      tripId,
      busId,
      stopId: stopIds[4]!,
      etaP50S: 600,
      etaP90S: 720,
      travelTimeS: 300,
      bufferS: 180,
      at: new Date(now - 5 * 60_000).toISOString(),
    };
    await processNotifyEntries(deps, [entry(e)]);
    await drain();
    const row = (await centre(users.rider!)).rows.find((n) =>
      n.source_key.startsWith("leave_now:"),
    );
    expect(row).toMatchObject({ tier: 1, channel: "inapp_only", failure_reason: "late" });
    expect(push.sent).toEqual([]);
  });

  it("600 students, one T0 announcement: every one delivered within 30 s", async () => {
    const crowd = await students("BIG", 600);
    push.latency(20); // a push service answering in 20 ms
    const id = await announce(0, "all", "All buses cancelled");
    const t0 = Date.now();
    await processNotifyEntries(deps, [
      entry({ type: "announcement", announcementId: id, at: new Date(now).toISOString() }),
    ]);
    await drain();
    const elapsedS = (Date.now() - t0) / 1000;
    const delivered = await db.query<{ n: number; sms: number }>(
      `SELECT count(*) FILTER (WHERE r.channel = 'push')::int n, count(r.provider_ref)::int sms
         FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
        WHERE n.source_key = $1 AND r.user_id = ANY($2::text[]::uuid[])`,
      [`announcement:${id}`, crowd],
    );
    expect(delivered.rows[0]!.n).toBe(600);
    // T0 always goes by SMS as well (ARCH §6.1)
    expect(delivered.rows[0]!.sms).toBe(600);
    expect(push.sent[0]!.msg.requireInteraction).toBe(true);
    process.stderr.write(
      `T0 to 600: recorded + delivered in ${elapsedS.toFixed(2)} s (${db.engine}, 20 ms push latency)\n`,
    );
    expect(elapsedS).toBeLessThan(30);
    await db.query(`DELETE FROM profiles WHERE id = ANY($1::text[]::uuid[])`, [crowd]);
  }, 60_000);

  it("push revoked mid-session: T1 falls back to SMS at once, the subscription is pruned, the center is written", async () => {
    push.setStatus(() => 410);
    await processNotifyEntries(deps, [
      entry({
        type: "leave_now",
        subscriptionId: "0b5e0000-0000-4000-8000-000000000002",
        userId: users.rider!,
        tripId,
        busId,
        stopId: stopIds[4]!,
        etaP50S: 480,
        etaP90S: 600,
        travelTimeS: 300,
        bufferS: 180,
        at: new Date(now).toISOString(),
      }),
    ]);
    await drain();
    expect(sms.sent.map((m) => [m.to, m.template])).toEqual([
      [expect.stringMatching(/^\+91/), "t1_alert"],
    ]);
    const row = (await centre(users.rider!)).rows.find(
      (n) => n.source_key === `leave_now:0b5e0000-0000-4000-8000-000000000002:${stopIds[4]}`,
    );
    expect(row).toMatchObject({ channel: "sms", tier: 1 });
    expect(row!.failure_reason).toMatch(/push 410: subscription removed/);
    const subs = await db.query(`SELECT 1 FROM push_subscriptions WHERE user_id = $1`, [
      users.rider,
    ]);
    expect(subs.rows).toEqual([]);
  });

  it("kill switch: T3 suppressed, T0 breaks through (and the center has both)", async () => {
    await db.query(`UPDATE profiles SET alerts_paused_until = $2 WHERE id = $1`, [
      users.paused,
      new Date(now + 3 * 3600_000).toISOString(),
    ]);
    const info = await announce(3, "all", "Info while paused");
    const critical = await announce(0, "all", "Critical while paused");
    await processNotifyEntries(deps, [
      entry({ type: "announcement", announcementId: info, at: new Date(now).toISOString() }),
      entry({ type: "announcement", announcementId: critical, at: new Date(now).toISOString() }),
    ]);
    await drain();
    const mine = (await centre(users.paused!)).rows.filter((n) => n.title.endsWith("while paused"));
    expect(mine.map((n) => [n.title, n.channel, n.failure_reason])).toEqual([
      ["Info while paused", "inapp_only", "paused"],
      ["Critical while paused", "push", null],
    ]);
  });

  it("the center is written even when every transport fails", async () => {
    push.setStatus(() => 500);
    sms.fail(true);
    const id = await announce(0, "all", "Nothing works");
    await processNotifyEntries(deps, [
      entry({ type: "announcement", announcementId: id, at: new Date(now).toISOString() }),
    ]);
    await drain();
    const row = (await centre(users.main!)).rows.find((n) => n.title === "Nothing works");
    expect(row!.channel).toBe("inapp_only");
    expect(row!.failure_reason).toMatch(/push 500.*sms: MSG91 rejected/);
    const nopush = (await centre(users.nopush!)).rows.find((n) => n.title === "Nothing works");
    expect(nopush!.failure_reason).toMatch(/no push subscription; sms/);
  });

  it("quiet hours defer a T2 to the end of the window; T0 is not deferred", async () => {
    // quiet 07:00 → 08:00 IST; it is 07:40
    await db.query(
      `UPDATE profiles SET quiet_start_min = 420, quiet_duration_min = 60 WHERE id = $1`,
      [users.quiet],
    );
    const id = await announce(2, "all", "During quiet hours");
    await processNotifyEntries(deps, [
      entry({ type: "announcement", announcementId: id, at: new Date(now).toISOString() }),
    ]);
    await drain();
    expect(pushesTo(users.quiet!)).toBe(0);
    now += 21 * 60_000; // 08:01 IST
    await drain();
    expect(pushesTo(users.quiet!)).toBe(1);
    now -= 21 * 60_000;
  });

  it("trip start: main favourite gets T1, starred gets T3 with Follow / Not today; a muted star is quiet", async () => {
    await processNotifyEntries(deps, [
      entry({ type: "trip_start", tripId, busId, at: new Date(now).toISOString() }),
    ]);
    await drain();
    const main = push.sent.find((s) => s.endpoint.endsWith(users.main!))!.msg;
    const star = push.sent.find((s) => s.endpoint.endsWith(users.star!))!.msg;
    expect(main).toMatchObject({ title: "Your bus has started — Bus 14", data: { tier: 1 } });
    expect(star.data.tier).toBe(3);
    expect(star.actions?.map((a) => a.action)).toEqual(["follow", "not_today"]);

    // "Not today" on another trip of the same bus: muted, not unstarred
    await db.query(`UPDATE favourites SET muted_until = $3 WHERE user_id = $1 AND bus_id = $2`, [
      users.star,
      busId,
      new Date(now + 3600_000).toISOString(),
    ]);
    push.reset();
    const trip2 = (
      await db.query<{ id: string }>(
        `INSERT INTO trips (bus_id, route_id, service_date, shift, run_seq, status, started_at)
         VALUES ($1, $2, operating_date(), 'evening', 2, 'completed', now()) RETURNING id`,
        [busId, routeId],
      )
    ).rows[0]!.id;
    await processNotifyEntries(deps, [
      entry({ type: "trip_start", tripId: trip2, busId, at: new Date(now).toISOString() }),
    ]);
    await drain();
    expect(pushesTo(users.star!)).toBe(0);
    const muted = (await centre(users.star!)).rows.find(
      (n) => n.source_key === `trip_start:${trip2}:starred`,
    );
    expect(muted).toMatchObject({ channel: "inapp_only", failure_reason: "muted" });
  });

  it("a ticket resolved before its doorbell was processed buzzes nobody that the bus is out", async () => {
    const t = await db.query<{ id: string }>(
      `INSERT INTO tickets (kind, severity, bus_id, title, description, status, resolved_at, opened_at)
       VALUES ('out_of_commission', 0, $1, 'Bus 14 is out of commission', 'Clutch', 'resolved', $2, $3) RETURNING id`,
      [busId, new Date(now - 60_000).toISOString(), new Date(now - 3600_000).toISOString()],
    );
    const ticketId = t.rows[0]!.id;
    await processNotifyEntries(deps, [
      entry({ type: "ticket", ticketId, transition: "opened", at: new Date(now).toISOString() }),
      entry({ type: "ticket", ticketId, transition: "resolved", at: new Date(now).toISOString() }),
    ]);
    await drain();
    const rows = (await centre(users.main!)).rows.filter((n) =>
      n.source_key.startsWith(`ticket:${ticketId}`),
    );
    expect(rows.map((n) => [n.tier, n.channel, n.failure_reason])).toEqual([
      [0, "inapp_only", "late"],
      [2, "push", null],
    ]);
    expect(sms.sent).toEqual([]); // no T0 SMS for a bus already back
  });

  it("recovers a published announcement whose doorbell was lost", async () => {
    const id = await announce(2, "all", "Doorbell lost");
    await db.query(`UPDATE announcements SET published_at = $2 WHERE id = $1`, [
      id,
      new Date(now - 60_000).toISOString(),
    ]);
    expect(await recoverLost(deps)).toBeGreaterThanOrEqual(1);
    const n = await db.query(`SELECT 1 FROM notifications WHERE source_key = $1`, [
      `announcement:${id}`,
    ]);
    expect(n.rows).toHaveLength(1);
    expect(await recoverLost(deps)).toBe(0); // and once recorded, never again
  });

  it("signal lost outside a known zone is T2 to the trip's riders; in a known zone it is T4, in-app only", async () => {
    const status = (reason: string, at: number, deadZone: unknown = null): SseEvent => ({
      type: "bus.status",
      data: {
        id: busId,
        state: "DARK",
        reason,
        cadence: 5,
        lastSeenAt: new Date(at - 45_000).toISOString(),
        tripId,
        at: new Date(at).toISOString(),
        deadZone: deadZone as null,
      },
    });
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, 'p', 'a') ON CONFLICT DO NOTHING`,
      [users.rider, `https://push.test/${users.rider}`],
    );
    await processBroadcastEntries(deps, [
      entry(status("signal_lost", now)),
      entry(status("known_dead_zone", now + 1000, { label: "Uppal flyover", avgOutageS: 90 })),
    ]);
    await drain();
    const rows = (await centre(users.rider!)).rows.filter((n) =>
      n.source_key.startsWith("signal:"),
    );
    expect(rows.map((n) => [n.tier, n.channel])).toEqual([
      [2, "push"],
      [4, "inapp_only"],
    ]);
    expect(rows[1]!.title).toBe("Bus 14 is in a known dead zone near Uppal flyover");
  });
});
