import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  AlertPrefsPatch,
  FavouriteKind,
  NotificationAction,
  PushSubscribe,
  type NotificationItem,
} from "@busmitra/contracts";
import { withContext, type Db } from "@busmitra/db";
import type { Osrm } from "@busmitra/engine/osrm";
import { travelTime } from "@busmitra/engine/walk";
import { endOfServiceDay } from "@busmitra/notify";
import { contextOf, requireUser } from "../../plugins/auth.ts";

/**
 * The student's half of the notification spine (BUILD_PLAN Stage 6): push subscriptions, the
 * notification center, the inline actions (*Follow*, *Not today*), favourites, the kill switch
 * and alert preferences. Every query is scoped to the caller: these run with the service role,
 * so the scoping here is the authorisation (SCHEMA §9) and is covered by tests.
 */

export interface NotificationRouteDeps {
  db: Db;
  vapidPublicKey?: string;
  osrmFoot?: Osrm;
  osrmCar?: Osrm;
  now?: () => number;
}

/** "I'm on the bus": three hours, capped at the end of the operating day (ARCH §6.5). */
export const PAUSE_MS = 3 * 3600_000;

const Id = z.object({ id: z.uuid() });
const BusId = z.object({ busId: z.uuid() });

export async function notificationRoutes(app: FastifyInstance, deps: NotificationRouteDeps) {
  app.addHook("preHandler", requireUser);
  const now = () => (deps.now ?? Date.now)();

  // ── push ────────────────────────────────────────────────────────────────

  app.get("/v1/push/config", async () => ({ publicKey: deps.vapidPublicKey ?? null }));

  /** Register this browser. An endpoint belongs to one account: signing in as someone else moves it. */
  app.post("/v1/push/subscriptions", async (req, reply) => {
    const body = PushSubscribe.parse(req.body);
    await deps.db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, is_standalone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth,
             user_agent = EXCLUDED.user_agent, is_standalone = EXCLUDED.is_standalone,
             failure_count = 0, backoff_until = NULL`,
      [
        req.user!.id,
        body.endpoint,
        body.keys.p256dh,
        body.keys.auth,
        req.headers["user-agent"]?.slice(0, 300) ?? null,
        body.standalone ?? null,
      ],
    );
    return reply.code(201).send({ ok: true });
  });

  app.delete("/v1/push/subscriptions", async (req, reply) => {
    const { endpoint } = z.object({ endpoint: z.string().min(1) }).parse(req.body);
    await deps.db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [
      endpoint,
      req.user!.id,
    ]);
    return reply.code(204).send();
  });

  // ── the notification center ─────────────────────────────────────────────

  app.get(
    "/v1/notifications",
    async (req): Promise<{ items: NotificationItem[]; next: string | null }> => {
      const q = z
        .object({
          tier: z.coerce.number().int().min(0).max(4).optional(),
          unread: z.enum(["0", "1"]).default("0"),
          before: z.iso.datetime({ offset: true }).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        })
        .parse(req.query);
      const { rows } = await deps.db.query<NotificationItem & { queued_at: Date }>(
        `SELECT n.id, n.tier, n.category, n.title, n.body, n.created_at, r.read_at, r.acknowledged_at,
              r.channel, n.bus_id, n.trip_id, n.payload, r.queued_at,
              CASE WHEN k.id IS NOT NULL
                   THEN json_build_object('id', k.id, 'status', k.status, 'title', k.title) END AS ticket
         FROM notification_recipients r
         JOIN notifications n ON n.id = r.notification_id
         LEFT JOIN tickets k ON k.id = n.ticket_id
        WHERE r.user_id = $1
          AND ($2::int IS NULL OR n.tier = $2)
          AND (NOT $3 OR r.read_at IS NULL)
          AND ($4::timestamptz IS NULL OR r.queued_at < $4)
        ORDER BY r.queued_at DESC, n.id
        LIMIT $5`,
        [req.user!.id, q.tier ?? null, q.unread === "1", q.before ?? null, q.limit],
      );
      const items = rows.map(({ queued_at, ...n }) => ({
        ...n,
        created_at: new Date(n.created_at).toISOString(),
        read_at: n.read_at && new Date(n.read_at).toISOString(),
        acknowledged_at: n.acknowledged_at && new Date(n.acknowledged_at).toISOString(),
        _q: new Date(queued_at).toISOString(),
      }));
      return {
        items: items.map(({ _q, ...n }) => n),
        next: items.length === q.limit ? items[items.length - 1]!._q : null,
      };
    },
  );

  /** The badge: unread, and T0s still waiting for an acknowledgement. */
  app.get("/v1/notifications/summary", async (req) => {
    const { rows } = await deps.db.query<{ unread: number; unacked_critical: number }>(
      `SELECT count(*) FILTER (WHERE r.read_at IS NULL)::int AS unread,
              count(*) FILTER (WHERE n.tier = 0 AND r.acknowledged_at IS NULL)::int AS unacked_critical
         FROM notification_recipients r JOIN notifications n ON n.id = r.notification_id
        WHERE r.user_id = $1`,
      [req.user!.id],
    );
    return rows[0];
  });

  app.post("/v1/notifications/:id/read", async (req, reply) => {
    const { id } = Id.parse(req.params);
    await deps.db.query(
      `UPDATE notification_recipients SET read_at = COALESCE(read_at, now())
        WHERE notification_id = $1 AND user_id = $2`,
      [id, req.user!.id],
    );
    return reply.code(204).send();
  });

  app.post("/v1/notifications/read-all", async (req, reply) => {
    await deps.db.query(
      `UPDATE notification_recipients SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
      [req.user!.id],
    );
    return reply.code(204).send();
  });

  /** T0 requires an acknowledgement (ARCH §6.1); acknowledging also reads it. */
  app.post("/v1/notifications/:id/ack", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { rows } = await deps.db.query(
      `UPDATE notification_recipients
          SET acknowledged_at = COALESCE(acknowledged_at, now()), read_at = COALESCE(read_at, now())
        WHERE notification_id = $1 AND user_id = $2 RETURNING notification_id`,
      [id, req.user!.id],
    );
    if (!rows.length)
      return reply.code(404).send({ error: "not_found", message: "No such notification." });
    return reply.code(204).send();
  });

  /**
   * *Follow* creates today's trip subscription for the bus that just started, to the stop on its
   * route nearest the student's pinned start; *Not today* mutes the bus until midnight without
   * unstarring it (ARCH §6.4). Both mark the notification read.
   */
  app.post("/v1/notifications/:id/actions", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { action } = NotificationAction.parse(req.body);
    const userId = req.user!.id;
    const found = await deps.db.query<{ bus_id: string | null; trip_id: string | null }>(
      `SELECT n.bus_id, n.trip_id FROM notifications n
         JOIN notification_recipients r ON r.notification_id = n.id AND r.user_id = $2
        WHERE n.id = $1`,
      [id, userId],
    );
    const n = found.rows[0];
    if (!n?.bus_id)
      return reply.code(404).send({ error: "not_found", message: "No such notification." });
    await deps.db.query(
      `UPDATE notification_recipients SET read_at = COALESCE(read_at, now()) WHERE notification_id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (action === "not_today") {
      const until = endOfServiceDay(now()).toISOString();
      await deps.db.query(
        `UPDATE favourites SET muted_until = $3 WHERE user_id = $1 AND bus_id = $2`,
        [userId, n.bus_id, until],
      );
      return { action, muted_until: until };
    }

    const trip = await deps.db.query<{ route_id: string; status: string }>(
      `SELECT route_id, status FROM trips WHERE id = $1 AND service_date = operating_date()`,
      [n.trip_id],
    );
    const t = trip.rows[0];
    if (!t || !["scheduled", "running", "dark"].includes(t.status))
      return reply
        .code(422)
        .send({ error: "trip_not_running", message: "That bus is no longer running today." });
    const stop = await deps.db.query<{ stop_id: string }>(
      `SELECT rs.stop_id FROM route_stops rs JOIN stops s ON s.id = rs.stop_id, profiles p
        WHERE rs.route_id = $1 AND p.id = $2 AND p.home_location IS NOT NULL
        ORDER BY ST_Distance(s.location, p.home_location), rs.seq LIMIT 1`,
      [t.route_id, userId],
    );
    if (!stop.rows[0])
      return reply.code(409).send({
        error: "no_home_pin",
        message: "Pin where you start from, so we know which stop to follow.",
      });
    const stopId = stop.rows[0].stop_id;
    const walk = await travelTime(
      { db: deps.db, foot: deps.osrmFoot, car: deps.osrmCar },
      userId,
      stopId,
    ).catch(() => null);
    const sub = await withContext(deps.db, contextOf(req), async (q) => {
      // 0–1 per day: following this bus retires today's other subscription
      await q.query(
        `UPDATE trip_subscriptions s SET state = 'completed' FROM trips t
          WHERE t.id = s.trip_id AND s.user_id = $1 AND s.trip_id <> $2
            AND t.service_date = operating_date() AND s.state = 'active'`,
        [userId, n.trip_id],
      );
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO trip_subscriptions (user_id, trip_id, target_stop_id, travel_time_s, travel_mode, buffer_s)
         SELECT $1, $2, $3, $4, p.travel_mode, p.default_buffer_s FROM profiles p WHERE p.id = $1
         ON CONFLICT (user_id, trip_id) DO UPDATE SET state = 'active'
         RETURNING id`,
        [userId, n.trip_id, stopId, walk?.durationS ?? null],
      );
      return rows[0]!.id;
    });
    return { action, subscription_id: sub, stop_id: stopId };
  });

  // ── favourites ──────────────────────────────────────────────────────────

  app.get("/v1/me/favourites", async (req) => {
    const { rows } = await deps.db.query(
      `SELECT f.bus_id, b.bus_number, f.kind, f.muted_until
         FROM favourites f JOIN buses b ON b.id = f.bus_id
        WHERE f.user_id = $1 AND b.archived_at IS NULL
        ORDER BY f.kind, length(b.bus_number), b.bus_number`,
      [req.user!.id],
    );
    return { favourites: rows };
  });

  /** Star a bus, or make it *the* main one — the previous main becomes starred (one_main_fav). */
  app.put("/v1/me/favourites/:busId", async (req, reply) => {
    const { busId } = BusId.parse(req.params);
    const { kind } = z.object({ kind: FavouriteKind }).parse(req.body);
    const userId = req.user!.id;
    const bus = await deps.db.query(`SELECT 1 FROM buses WHERE id = $1 AND archived_at IS NULL`, [
      busId,
    ]);
    if (!bus.rows.length)
      return reply.code(404).send({ error: "not_found", message: "No such bus." });
    await deps.db.tx(async (q) => {
      if (kind === "main")
        await q.query(
          `UPDATE favourites SET kind = 'starred' WHERE user_id = $1 AND kind = 'main' AND bus_id <> $2`,
          [userId, busId],
        );
      await q.query(
        `INSERT INTO favourites (user_id, bus_id, kind) VALUES ($1, $2, $3::fav_kind_t)
         ON CONFLICT (user_id, bus_id) DO UPDATE SET kind = EXCLUDED.kind`,
        [userId, busId, kind],
      );
    });
    return { bus_id: busId, kind };
  });

  app.delete("/v1/me/favourites/:busId", async (req, reply) => {
    const { busId } = BusId.parse(req.params);
    await deps.db.query(`DELETE FROM favourites WHERE user_id = $1 AND bus_id = $2`, [
      req.user!.id,
      busId,
    ]);
    return reply.code(204).send();
  });

  /** Undo a "Not today". */
  app.delete("/v1/me/favourites/:busId/mute", async (req, reply) => {
    const { busId } = BusId.parse(req.params);
    await deps.db.query(
      `UPDATE favourites SET muted_until = NULL WHERE user_id = $1 AND bus_id = $2`,
      [req.user!.id, busId],
    );
    return reply.code(204).send();
  });

  // ── kill switch and preferences ─────────────────────────────────────────

  /**
   * "I'm on the bus": pause for three hours (never past the end of the operating day, so the
   * next morning's alerts arrive), and today's followed trip becomes `boarded`, which also ends
   * its leave-now.
   */
  app.post("/v1/me/pause", async (req) => {
    const t = now();
    const until = new Date(Math.min(t + PAUSE_MS, endOfServiceDay(t).getTime()));
    await withContext(deps.db, contextOf(req), async (q) => {
      await q.query(`UPDATE profiles SET alerts_paused_until = $2 WHERE id = $1`, [
        req.user!.id,
        until.toISOString(),
      ]);
      await q.query(
        `UPDATE trip_subscriptions s SET state = 'boarded', boarded_at = now() FROM trips t
          WHERE t.id = s.trip_id AND s.user_id = $1 AND t.service_date = operating_date() AND s.state = 'active'`,
        [req.user!.id],
      );
    });
    return { alerts_paused_until: until.toISOString() };
  });

  app.delete("/v1/me/pause", async (req, reply) => {
    await withContext(deps.db, contextOf(req), (q) =>
      q.query(`UPDATE profiles SET alerts_paused_until = NULL WHERE id = $1`, [req.user!.id]),
    );
    return reply.code(204).send();
  });

  app.get("/v1/me/alerts", async (req) => {
    const { rows } = await deps.db.query(
      `SELECT alerts_paused_until, max_tier, critical_breakthrough, quiet_start_min, quiet_duration_min,
              (SELECT count(*)::int FROM push_subscriptions s WHERE s.user_id = p.id AND s.failure_count < 5) AS push_devices
         FROM profiles p WHERE id = $1`,
      [req.user!.id],
    );
    return rows[0];
  });

  app.patch("/v1/me/alerts", async (req) => {
    const b = AlertPrefsPatch.parse(req.body);
    const { rows } = await withContext(deps.db, contextOf(req), (q) =>
      q.query(
        `UPDATE profiles
            SET max_tier = COALESCE($2, max_tier),
                critical_breakthrough = COALESCE($3, critical_breakthrough),
                quiet_start_min = CASE WHEN $4 THEN $5 ELSE quiet_start_min END,
                quiet_duration_min = CASE WHEN $4 THEN $6 ELSE quiet_duration_min END
          WHERE id = $1
          RETURNING max_tier, critical_breakthrough, quiet_start_min, quiet_duration_min`,
        [
          req.user!.id,
          b.max_tier ?? null,
          b.critical_breakthrough ?? null,
          b.quiet_start_min !== undefined,
          b.quiet_start_min ?? null,
          b.quiet_duration_min ?? null,
        ],
      ),
    );
    return rows[0];
  });
}

/**
 * MSG91's delivery-receipt webhook (BUILD_PLAN Stage 6 "SMS adapter with delivery receipts").
 * Unauthenticated by nature, so it is guarded by a shared token in the URL and only ever *marks*
 * an SMS delivered or failed — it cannot create or send anything. The payload shape varies by
 * MSG91 product, so any object carrying a request id and a status is read.
 */
export async function smsReceiptRoutes(app: FastifyInstance, deps: { db: Db; token?: string }) {
  app.post("/v1/notify/sms-receipt", async (req, reply) => {
    const { token } = z.object({ token: z.string().optional() }).parse(req.query);
    if (!deps.token || token !== deps.token)
      return reply.code(404).send({ error: "not_found", message: "Not found" });
    const reports: { ref: string; ok: boolean; status: string }[] = [];
    // the status sits beside the request id, or one level down in a per-number report
    const statusIn = (o: Record<string, unknown>): unknown => {
      const own = o.status ?? o.desc ?? o.description;
      if (own != null) return own;
      for (const v of Object.values(o))
        if (Array.isArray(v))
          for (const x of v)
            if (x && typeof x === "object") {
              const s = statusIn(x as Record<string, unknown>);
              if (s != null) return s;
            }
      return null;
    };
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (!v || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      const ref = o.requestId ?? o.request_id ?? o.requestID;
      const status = typeof ref === "string" ? statusIn(o) : null;
      if (typeof ref === "string" && status != null) {
        const s = String(status).toLowerCase();
        reports.push({
          ref,
          ok: s === "1" || s.startsWith("deliv"),
          status: String(status).slice(0, 40),
        });
        return;
      }
      Object.values(o).forEach(walk);
    };
    walk(req.body);
    for (const r of reports) {
      await deps.db.query(
        r.ok
          ? `UPDATE notification_recipients SET delivered_at = COALESCE(delivered_at, now()) WHERE provider_ref = $1`
          : `UPDATE notification_recipients SET failure_reason = concat_ws('; ', failure_reason, 'sms receipt: ' || $2)
              WHERE provider_ref = $1`,
        r.ok ? [r.ref] : [r.ref, r.status],
      );
    }
    return { received: reports.length };
  });
}
