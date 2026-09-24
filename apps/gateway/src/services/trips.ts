import type { Db, Queryable } from "@busmitra/db";

/**
 * Trip lookups for ingest, and the start/end lifecycle the driver app drives.
 *
 * Ingest validates every batch against its trip (a stolen secret for bus A must not be able
 * to post positions into bus B's trip — ARCH §10), so the lookup is cached with
 * stale-on-error for the same reason as the tracker directory: Postgres down must not mean
 * ingest down.
 */

export const TRIPS = {
  CACHE_TTL_MS: 30_000,
  /** backfill for a trip that has already ended is still accepted for this long */
  BACKFILL_AFTER_END_MS: 12 * 3600_000,
} as const;

export interface TripInfo {
  id: string;
  busId: string;
  routeId: string;
  status: "scheduled" | "running" | "dark" | "completed" | "cancelled";
  endedAt: number | null;
}

export interface TripDirectory {
  get(tripId: string): Promise<TripInfo | null>;
  forget(tripId: string): void;
}

export function createTripDirectory(db: Queryable, now: () => number = Date.now): TripDirectory {
  const cache = new Map<string, { value: TripInfo | null; at: number }>();
  return {
    forget: (id) => void cache.delete(id),
    async get(tripId) {
      const hit = cache.get(tripId);
      if (hit && now() - hit.at < TRIPS.CACHE_TTL_MS) return hit.value;
      try {
        const { rows } = await db.query<{
          bus_id: string;
          route_id: string;
          status: TripInfo["status"];
          ended_at: Date | null;
        }>(`SELECT bus_id, route_id, status, ended_at FROM trips WHERE id = $1`, [tripId]);
        const r = rows[0];
        const value: TripInfo | null = r
          ? {
              id: tripId,
              busId: r.bus_id,
              routeId: r.route_id,
              status: r.status,
              endedAt: r.ended_at ? new Date(r.ended_at).getTime() : null,
            }
          : null;
        cache.set(tripId, { value, at: now() });
        return value;
      } catch (err) {
        if (hit) return hit.value;
        throw err;
      }
    },
  };
}

/** Whether pings for this trip are still accepted (live, or backfill shortly after it ended). */
export function acceptsPings(trip: TripInfo, now: number): boolean {
  if (trip.status === "cancelled") return false;
  if (trip.status === "completed") {
    return trip.endedAt !== null && now - trip.endedAt < TRIPS.BACKFILL_AFTER_END_MS;
  }
  return true;
}

export interface StartedTrip {
  tripId: string;
  routeId: string;
  resumed: boolean;
  startedAt: string;
  /** a live trip on another route that this start closed — the caller emits its trip_end */
  closed: { tripId: string; routeId: string } | null;
}

const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/**
 * Start (or resume) the bus's trip on `routeId`. `one_live_trip` makes "one open trip per bus"
 * a database fact, so a driver who force-quits and reopens the app resumes the same trip
 * rather than creating a second one. A second run in the same shift gets run_seq + 1.
 */
export async function startTrip(db: Db, busId: string, routeId: string): Promise<StartedTrip> {
  const route = await db.query(
    `SELECT 1 FROM routes WHERE id = $1 AND published_at IS NOT NULL AND archived_at IS NULL`,
    [routeId],
  );
  if (!route.rows.length) throw httpError(422, "That route is not published.");

  const attempt = () =>
    db.tx(async (q) => {
      const live = await q.query<{ id: string; route_id: string; started_at: Date | null }>(
        `SELECT id, route_id, started_at FROM trips
          WHERE bus_id = $1 AND status IN ('scheduled', 'running', 'dark') FOR UPDATE`,
        [busId],
      );
      let closed: StartedTrip["closed"] = null;
      const current = live.rows[0];
      if (current && current.route_id === routeId) {
        const { rows } = await q.query<{ started_at: Date }>(
          `UPDATE trips SET status = 'running', started_at = COALESCE(started_at, now())
            WHERE id = $1 RETURNING started_at`,
          [current.id],
        );
        return {
          tripId: current.id,
          routeId,
          resumed: true,
          startedAt: new Date(rows[0]!.started_at).toISOString(),
          closed,
        };
      }
      if (current) {
        await q.query(`UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1`, [
          current.id,
        ]);
        closed = { tripId: current.id, routeId: current.route_id };
      }
      const { rows } = await q.query<{ id: string; started_at: Date }>(
        `WITH d AS (
           SELECT operating_date() AS service_date,
                  CASE WHEN extract(hour FROM now() AT TIME ZONE 'Asia/Kolkata') < 12
                       THEN 'morning'::shift_t ELSE 'evening'::shift_t END AS shift
         )
         INSERT INTO trips (bus_id, route_id, service_date, shift, run_seq, status, started_at)
         SELECT $1, $2, d.service_date, d.shift,
                COALESCE((SELECT max(run_seq) + 1 FROM trips t
                           WHERE t.bus_id = $1 AND t.service_date = d.service_date AND t.shift = d.shift), 1),
                'running', now()
           FROM d
         RETURNING id, started_at`,
        [busId, routeId],
      );
      return {
        tripId: rows[0]!.id,
        routeId,
        resumed: false,
        startedAt: new Date(rows[0]!.started_at).toISOString(),
        closed,
      };
    });
  try {
    return await attempt();
  } catch (err) {
    // two starts racing for the same bus: one wins one_live_trip, the other resumes it
    if ((err as { code?: string }).code === "23505") return attempt();
    throw err;
  }
}

/** End the trip. Idempotent: ending an already-ended trip succeeds and changes nothing. */
export async function endTrip(
  db: Db,
  busId: string,
  tripId: string,
): Promise<{ routeId: string; endedAt: string; alreadyEnded: boolean }> {
  const { rows } = await db.query<{
    route_id: string;
    status: string;
    ended_at: Date | null;
    bus_id: string;
  }>(`SELECT route_id, status, ended_at, bus_id FROM trips WHERE id = $1`, [tripId]);
  const t = rows[0];
  if (!t || t.bus_id !== busId) throw httpError(404, "No such trip for this bus.");
  if (t.status === "completed" || t.status === "cancelled") {
    return {
      routeId: t.route_id,
      endedAt: new Date(t.ended_at ?? Date.now()).toISOString(),
      alreadyEnded: true,
    };
  }
  const upd = await db.query<{ ended_at: Date }>(
    `UPDATE trips SET status = 'completed', ended_at = now() WHERE id = $1 RETURNING ended_at`,
    [tripId],
  );
  return {
    routeId: t.route_id,
    endedAt: new Date(upd.rows[0]!.ended_at).toISOString(),
    alreadyEnded: false,
  };
}
