import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { HomePin, Subscribe, type Me, type SubscriptionView } from "@busmitra/contracts";
import { withContext, type Db } from "@busmitra/db";
import type { Osrm } from "@busmitra/engine/osrm";
import { travelTime } from "@busmitra/engine/walk";
import { readFleetEntry, type Keys, type Redis } from "@busmitra/redis";
import { contextOf, requireUser } from "../../plugins/auth.ts";

/**
 * The student's own pin and "the bus I am taking today" (BUILD_PLAN Stage 5).
 *
 * These run with the service role, which bypasses RLS — so every statement here is scoped to
 * `req.user.id` by hand, and me.test.ts attacks each one as another student (invariant 12).
 * Writes run inside withContext as the student, which is how the audit trigger knows a student
 * editing their own preferences is not an admin action (SCHEMA §8).
 */
export interface MeDeps {
  db: Db;
  redis?: Redis;
  keys?: Keys;
  osrmFoot?: Osrm;
  osrmCar?: Osrm;
}

const httpError = (statusCode: number, message: string, code = "bad_request") =>
  Object.assign(new Error(message), { statusCode, code });

async function loadMe(db: Db, userId: string): Promise<Me> {
  const { rows } = await db.query<{
    id: string;
    roll_no: string;
    full_name: string;
    lat: number | null;
    lng: number | null;
    home_label: string | null;
    travel_mode: Me["travelMode"];
    default_buffer_s: number;
  }>(
    `SELECT id, roll_no, full_name, ST_Y(home_location::geometry) AS lat, ST_X(home_location::geometry) AS lng,
            home_label, travel_mode, default_buffer_s
       FROM profiles WHERE id = $1`,
    [userId],
  );
  const r = rows[0];
  if (!r) throw httpError(404, "No profile.", "not_found");
  return {
    id: r.id,
    rollNo: r.roll_no,
    fullName: r.full_name,
    home:
      r.lat === null || r.lng === null
        ? null
        : { lat: Number(r.lat), lng: Number(r.lng), label: r.home_label },
    travelMode: r.travel_mode,
    bufferS: Number(r.default_buffer_s),
  };
}

const VIEW = `
  SELECT s.id, s.trip_id, t.bus_id, b.bus_number, t.route_id, r.name AS route_name,
         s.target_stop_id, st.name AS stop_name, rs.seq AS stop_seq, rs.cumulative_dist_m AS stop_offset,
         s.state, s.travel_mode, s.travel_time_s, s.buffer_s, s.notified_departure_at, s.created_at
    FROM trip_subscriptions s
    JOIN trips t ON t.id = s.trip_id
    JOIN buses b ON b.id = t.bus_id
    JOIN routes r ON r.id = t.route_id
    JOIN stops st ON st.id = s.target_stop_id
    JOIN LATERAL (SELECT seq, cumulative_dist_m FROM route_stops x
                   WHERE x.route_id = t.route_id AND x.stop_id = s.target_stop_id
                   ORDER BY seq LIMIT 1) rs ON true`;

type ViewRow = {
  id: string;
  trip_id: string;
  bus_id: string;
  bus_number: string;
  route_id: string;
  route_name: string;
  target_stop_id: string;
  stop_name: string;
  stop_seq: number;
  stop_offset: number;
  state: SubscriptionView["state"];
  travel_mode: SubscriptionView["travelMode"];
  travel_time_s: number | null;
  buffer_s: number;
  notified_departure_at: Date | null;
  created_at: Date;
};

function toView(r: ViewRow): SubscriptionView {
  return {
    id: r.id,
    tripId: r.trip_id,
    busId: r.bus_id,
    busNumber: r.bus_number,
    routeId: r.route_id,
    routeName: r.route_name,
    stop: {
      id: r.target_stop_id,
      name: r.stop_name,
      seq: Number(r.stop_seq),
      offset: Number(r.stop_offset),
    },
    state: r.state,
    travelMode: r.travel_mode,
    travelTimeS: r.travel_time_s === null ? null : Number(r.travel_time_s),
    bufferS: Number(r.buffer_s),
    notifiedDepartureAt: r.notified_departure_at
      ? new Date(r.notified_departure_at).toISOString()
      : null,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export async function meRoutes(app: FastifyInstance, deps: MeDeps) {
  app.addHook("preHandler", requireUser);

  app.get("/v1/me", async (req) => loadMe(deps.db, req.user!.id));

  app.put("/v1/me/home", async (req) => {
    const body = HomePin.parse(req.body);
    const userId = req.user!.id;
    await withContext(deps.db, contextOf(req), (q) =>
      q.query(
        // the database coarsens the point to ~100 m and empties the walk cache (0006 triggers)
        `UPDATE profiles SET home_location = ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
                home_label = $4, travel_mode = COALESCE($5::travel_mode_t, travel_mode)
          WHERE id = $1`,
        [userId, body.lng, body.lat, body.label ?? null, body.travelMode ?? null],
      ),
    );
    return loadMe(deps.db, userId);
  });

  app.delete("/v1/me/home", async (req) => {
    await withContext(deps.db, contextOf(req), (q) =>
      q.query(`UPDATE profiles SET home_location = NULL, home_label = NULL WHERE id = $1`, [
        req.user!.id,
      ]),
    );
    return loadMe(deps.db, req.user!.id);
  });

  /** Today's subscription, if any: the most recent one that is not completed. */
  app.get(
    "/v1/me/subscription",
    async (req): Promise<{ subscription: SubscriptionView | null }> => {
      const { rows } = await deps.db.query<ViewRow>(
        `${VIEW}
        WHERE s.user_id = $1 AND t.service_date = operating_date() AND s.state <> 'completed'
        ORDER BY s.created_at DESC LIMIT 1`,
        [req.user!.id],
      );
      return { subscription: rows[0] ? toView(rows[0]) : null };
    },
  );

  app.post("/v1/me/subscription", async (req, reply) => {
    const body = Subscribe.parse(req.body);
    const userId = req.user!.id;
    const trip = await deps.db.query<{
      bus_id: string;
      route_id: string;
      status: string;
      today: boolean;
    }>(
      `SELECT bus_id, route_id, status, service_date = operating_date() AS today FROM trips WHERE id = $1`,
      [body.tripId],
    );
    const t = trip.rows[0];
    if (!t || !t.today || !["scheduled", "running", "dark"].includes(t.status)) {
      throw httpError(422, "That bus is not running today.", "trip_not_running");
    }
    const stop = await deps.db.query<{ stop_index: number }>(
      `SELECT (SELECT count(*)::int FROM route_stops x WHERE x.route_id = rs.route_id AND x.seq < rs.seq) AS stop_index
         FROM route_stops rs WHERE rs.route_id = $1 AND rs.stop_id = $2 ORDER BY rs.seq LIMIT 1`,
      [t.route_id, body.stopId],
    );
    if (!stop.rows[0]) throw httpError(422, "That bus does not stop there.", "stop_not_on_route");
    if (deps.redis && deps.keys) {
      const live = await readFleetEntry(deps.redis, deps.keys, t.bus_id).catch(() => null);
      if (live && live.tripId === body.tripId && live.seq >= stop.rows[0].stop_index) {
        throw httpError(422, "That bus has already passed this stop.", "stop_passed");
      }
    }
    const walk = await travelTime(
      { db: deps.db, foot: deps.osrmFoot, car: deps.osrmCar },
      userId,
      body.stopId,
    ).catch(() => null);
    const id = await withContext(deps.db, contextOf(req), async (q) => {
      // "0–1 per day" (ARCH §6.4): following a bus retires today's other subscription
      await q.query(
        `UPDATE trip_subscriptions s SET state = 'completed'
           FROM trips t
          WHERE t.id = s.trip_id AND s.user_id = $1 AND s.trip_id <> $2
            AND t.service_date = operating_date() AND s.state = 'active'`,
        [userId, body.tripId],
      );
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO trip_subscriptions (user_id, trip_id, target_stop_id, travel_time_s, travel_mode, buffer_s)
         SELECT $1, $2, $3, $4, p.travel_mode, p.default_buffer_s FROM profiles p WHERE p.id = $1
         ON CONFLICT (user_id, trip_id) DO UPDATE SET
           -- a new stop is a new promise: its "leave now" has not fired yet
           notified_departure_at = CASE WHEN trip_subscriptions.target_stop_id = EXCLUDED.target_stop_id
                                        THEN trip_subscriptions.notified_departure_at END,
           target_stop_id = EXCLUDED.target_stop_id,
           travel_time_s = EXCLUDED.travel_time_s,
           travel_mode = EXCLUDED.travel_mode,
           buffer_s = EXCLUDED.buffer_s,
           state = 'active'
         RETURNING id`,
        [userId, body.tripId, body.stopId, walk?.durationS ?? null],
      );
      return rows[0]!.id;
    });
    const { rows } = await deps.db.query<ViewRow>(`${VIEW} WHERE s.id = $1 AND s.user_id = $2`, [
      id,
      userId,
    ]);
    return reply.code(201).send({ subscription: toView(rows[0]!) });
  });

  app.delete("/v1/me/subscription/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    // scoped to the caller: someone else's id deletes nothing and answers the same
    await deps.db.query(`DELETE FROM trip_subscriptions WHERE id = $1 AND user_id = $2`, [
      id,
      req.user!.id,
    ]);
    return reply.code(204).send();
  });
}
