import type { Queryable } from "@busmitra/db";

/**
 * Scheduled trips from today's event-day list (carried forward from Stage 5: "Bus 22 · 7:40 AM ·
 * scheduled" needs a `scheduled` trip with `scheduled_start_at`).
 *
 * `one_live_trip` allows one open trip per bus — scheduled included — so a bus doing a 7:10
 * senior run and an 8:00 junior run cannot hold both as scheduled trips at once. This pass
 * therefore keeps exactly the *next* departure scheduled for each bus: when the 7:10 run starts
 * (the driver's START resumes the scheduled trip, services/trips.ts) and later completes, the
 * next pass schedules the 8:00. Trips are created on the service day only, never ahead: a trip
 * scheduled for tomorrow would be resumed by today's START.
 *
 * A scheduled trip nobody started within two hours of its time is cancelled, so it does not sit
 * in `one_live_trip` blocking the bus's next run. Idempotent: `ON CONFLICT DO NOTHING` against
 * both trip uniqueness rules, and a departure already materialised is never materialised twice.
 */

export const SCHEDULE_EVERY_MS = 60_000;
/** a departure more than this far in the past is not scheduled any more */
export const SCHEDULE_GRACE_MIN = 30;
export const SCHEDULE_ABANDON_MIN = 120;

export async function materialiseEventDayTrips(
  q: Queryable,
  now: number = Date.now(),
): Promise<{ scheduled: number; abandoned: number }> {
  const at = new Date(now).toISOString();
  const abandoned = await q.query(
    `UPDATE trips SET status = 'cancelled'
      WHERE status = 'scheduled' AND started_at IS NULL AND scheduled_start_at IS NOT NULL
        AND scheduled_start_at < $1::timestamptz - make_interval(mins => $2)
      RETURNING id`,
    [at, SCHEDULE_ABANDON_MIN],
  );
  const scheduled = await q.query(
    `WITH today AS (
       SELECT (($1::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date AS d
     ), due AS (
       SELECT DISTINCT ON (e.bus_id) e.bus_id, e.route_id,
              (e.service_date + e.departure_time) AT TIME ZONE 'Asia/Kolkata' AS start_at
         FROM event_day_buses e
         JOIN routes r ON r.id = e.route_id
         CROSS JOIN today
        WHERE r.published_at IS NOT NULL AND r.archived_at IS NULL
          AND e.service_date = today.d AND e.bus_id IS NOT NULL AND e.departure_time IS NOT NULL
          AND (e.service_date + e.departure_time) AT TIME ZONE 'Asia/Kolkata'
                > $1::timestamptz - make_interval(mins => $2)
          AND NOT EXISTS (
            SELECT 1 FROM trips t WHERE t.bus_id = e.bus_id
               AND t.scheduled_start_at = (e.service_date + e.departure_time) AT TIME ZONE 'Asia/Kolkata')
        ORDER BY e.bus_id, e.departure_time
     ), shifted AS (
       SELECT due.*, today.d,
              CASE WHEN extract(hour FROM start_at AT TIME ZONE 'Asia/Kolkata') < 12
                   THEN 'morning'::shift_t ELSE 'evening'::shift_t END AS shift
         FROM due, today
        WHERE NOT EXISTS (SELECT 1 FROM trips t WHERE t.bus_id = due.bus_id
                            AND t.status IN ('scheduled', 'running', 'dark'))
     )
     INSERT INTO trips (bus_id, route_id, service_date, shift, run_seq, status, scheduled_start_at)
     SELECT s.bus_id, s.route_id, s.d, s.shift,
            COALESCE((SELECT max(run_seq) + 1 FROM trips t
                       WHERE t.bus_id = s.bus_id AND t.service_date = s.d AND t.shift = s.shift), 1),
            'scheduled', s.start_at
       FROM shifted s
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [at, SCHEDULE_GRACE_MIN],
  );
  return { scheduled: scheduled.rows.length, abandoned: abandoned.rows.length };
}
