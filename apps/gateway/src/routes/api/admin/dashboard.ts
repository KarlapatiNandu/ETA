import type { FastifyInstance } from "fastify";
import { readFleet, type FleetEntry } from "@busmitra/redis";
import type { AppDeps } from "../../../app.ts";
import { requireAdmin } from "../../../plugins/auth.ts";

/**
 * The live fleet dashboard (BUILD_PLAN Stage 7): every bus's presence state, current trip, last
 * ping age and today's ETA accuracy, in one call the console polls.
 *
 * Presence comes from `fleet:live` — the same Redis state students see (invariant 1: Postgres is
 * never the read path for live data). The fleet list, trips and accuracy come from Postgres; if
 * Postgres is down the dashboard fails honestly rather than showing a fleet it cannot name.
 * Ages are on the gateway's clock (`serverTime`), not the TD's PC.
 */
export async function adminDashboardRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook("preHandler", requireAdmin(deps));

  app.get("/v1/admin/dashboard", async () => {
    const now = (deps.now ?? Date.now)();
    const buses = await deps.db.query<{
      id: string;
      bus_number: string;
      status: string;
      status_note: string | null;
      trip_id: string | null;
      trip_status: string | null;
      route_name: string | null;
      scheduled_start_at: Date | null;
      started_at: Date | null;
      open_tickets: number;
      trackers: number;
      mae_s: number | null;
      mae_n: number;
    }>(
      `SELECT b.id, b.bus_number, b.status, b.status_note,
              t.id AS trip_id, t.status AS trip_status, t.scheduled_start_at, t.started_at,
              CASE WHEN r.id IS NOT NULL THEN r.name || ' (' || r.direction || ')' END AS route_name,
              (SELECT count(*)::int FROM tickets k WHERE k.bus_id = b.id
                  AND k.status IN ('open', 'acknowledged')) AS open_tickets,
              (SELECT count(*)::int FROM trackers x WHERE x.bus_id = b.id) AS trackers,
              acc.mae_s, COALESCE(acc.n, 0) AS mae_n
         FROM buses b
         LEFT JOIN LATERAL (
           SELECT * FROM trips t WHERE t.bus_id = b.id
            ORDER BY (t.status IN ('running', 'dark', 'scheduled')) DESC, t.created_at DESC LIMIT 1
         ) t ON true
         LEFT JOIN routes r ON r.id = t.route_id
         LEFT JOIN LATERAL (
           -- today's accuracy at the 10-minute horizon: the number the Stage 5 gate is about
           SELECT round(avg(abs(p.error_s)))::int AS mae_s, count(*)::int AS n
             FROM eta_predictions p JOIN trips tt ON tt.id = p.trip_id
            WHERE tt.bus_id = b.id AND tt.service_date = operating_date()
              AND p.horizon_s = 600 AND p.error_s IS NOT NULL
         ) acc ON true
        WHERE b.archived_at IS NULL
        ORDER BY length(b.bus_number), b.bus_number`,
    );
    let fleet: Record<string, FleetEntry> = {};
    let liveOk = true;
    if (deps.redis && deps.keys) {
      try {
        fleet = await readFleet(deps.redis, deps.keys);
      } catch {
        liveOk = false;
      }
    } else liveOk = false;

    return {
      serverTime: new Date(now).toISOString(),
      live: liveOk,
      buses: buses.rows.map((b) => {
        const e = fleet[b.id];
        // the live entry belongs to this bus's trip only if the trip ids agree
        const onTrip = e && (!b.trip_id || e.tripId === b.trip_id) ? e : null;
        return {
          ...b,
          presence: onTrip?.state ?? null,
          last_fix_at: onTrip?.ts ?? null,
          last_fix_age_s: onTrip
            ? Math.max(0, Math.round((now - Date.parse(onTrip.ts)) / 1000))
            : null,
          cadence_s: onTrip?.cadence ?? null,
          flag: onTrip?.flag ?? null,
          dead_zone: onTrip?.deadZone ?? null,
          speed_kmh: onTrip?.spd ?? null,
        };
      }),
    };
  });
}
