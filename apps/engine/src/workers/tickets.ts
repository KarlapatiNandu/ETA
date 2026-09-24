import type { Queryable } from "@busmitra/db";

/**
 * Automatic signal-loss tickets (ARCH §5.7, BUILD_PLAN Stage 7 "auto-opened signal-loss
 * tickets"). An outage outside any known dead zone that is still open after five minutes becomes
 * a ticket in the TD's queue; when the bus reports again the ticket resolves itself, with the
 * outage's length in the note, so the queue holds what still needs a human.
 *
 * Reads `signal_outages` (written by the presence sweeper), never Redis: a ticket is an
 * operational record, and this pass runs only when Postgres is up to hold it. Idempotent by
 * `one_open_signal_ticket` — any number of passes, or of engines, open one ticket per trip.
 *
 * Opening one notifies no student: the T2 "signal lost" alert is driven by the presence
 * transition itself (Stage 6), not by the paperwork about it.
 */

export const SIGNAL_TICKET_AFTER_S = 300;
export const TICKETS_EVERY_MS = 30_000;

export async function syncSignalTickets(
  q: Queryable,
  now: number = Date.now(),
): Promise<{ opened: string[]; resolved: string[] }> {
  const at = new Date(now).toISOString();
  const opened = await q.query<{ id: string }>(
    `WITH due AS (
       SELECT o.trip_id, o.bus_id, o.started_at, t.route_id, b.bus_number,
              round(ST_Y(o.entry_point::geometry)::numeric, 5) AS lat,
              round(ST_X(o.entry_point::geometry)::numeric, 5) AS lng
         FROM signal_outages o
         JOIN trips t ON t.id = o.trip_id
         JOIN buses b ON b.id = o.bus_id
        WHERE o.recovered_at IS NULL AND o.dead_zone_id IS NULL
          -- a trip that has ended is not a bus anyone is waiting for (an outage can outlive
          -- its trip: see M07 gotchas)
          AND t.status IN ('running', 'dark')
          AND o.started_at <= $1::timestamptz - make_interval(secs => $2)
     ), ins AS (
       INSERT INTO tickets (kind, severity, bus_id, trip_id, route_id, title, description, opened_at)
       SELECT 'signal_lost', 2, bus_id, trip_id, route_id,
              'No signal from bus ' || bus_number,
              'Silent since ' || to_char(started_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI')
                || ' IST, last seen at ' || lat || ', ' || lng
                || '. Opened automatically after ' || ($2 / 60) || ' minutes outside any known dead zone.',
              $1::timestamptz
         FROM due
       ON CONFLICT DO NOTHING
       RETURNING id
     )
     INSERT INTO ticket_events (ticket_id, to_status, note, created_at)
     SELECT id, 'open', 'opened automatically', $1::timestamptz FROM ins
     RETURNING ticket_id AS id`,
    [at, SIGNAL_TICKET_AFTER_S],
  );
  const resolved = await q.query<{ id: string }>(
    `WITH done AS (
       SELECT k.id, k.status AS from_status,
              -- the trip's latest outage: still open, or closed by the trip's end (0009: no exit
              -- point), means the bus never came back
              CASE WHEN COALESCE((SELECT x.recovered_at IS NULL OR x.exit_point IS NULL
                                    FROM signal_outages x WHERE x.trip_id = k.trip_id
                                   ORDER BY x.started_at DESC LIMIT 1), true)
                   THEN 'The trip ended while the bus was still silent.'
                   ELSE 'Signal came back after ' || COALESCE(
                          (SELECT ceil(o.duration_s / 60.0)::int::text FROM signal_outages o
                            WHERE o.trip_id = k.trip_id AND o.exit_point IS NOT NULL
                            ORDER BY o.recovered_at DESC LIMIT 1), '?') || ' min.'
              END AS note
         FROM tickets k JOIN trips t ON t.id = k.trip_id
        WHERE k.kind = 'signal_lost' AND k.status IN ('open', 'acknowledged') AND k.opened_by IS NULL
          AND (t.status IN ('completed', 'cancelled')
               OR NOT EXISTS (SELECT 1 FROM signal_outages x
                               WHERE x.trip_id = k.trip_id AND x.recovered_at IS NULL))
     ), upd AS (
       UPDATE tickets k SET status = 'resolved', resolved_at = $1::timestamptz,
              resolution_note = d.note
         FROM done d WHERE k.id = d.id
       RETURNING k.id, d.from_status, k.resolution_note
     )
     INSERT INTO ticket_events (ticket_id, from_status, to_status, note, created_at)
     SELECT id, from_status, 'resolved', resolution_note, $1::timestamptz FROM upd
     RETURNING ticket_id AS id`,
    [at],
  );
  return { opened: opened.rows.map((r) => r.id), resolved: resolved.rows.map((r) => r.id) };
}
