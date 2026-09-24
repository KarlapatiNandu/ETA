import type { LeaveNowEvent } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import { readFleet, STREAMS, type Keys, type Redis } from "@busmitra/redis";

/**
 * The leave-now evaluator (BUILD_PLAN Stage 5, ARCH §5.6) — the highest-stakes computation in
 * the product. Every 10 s, over the `subs_active` partial index (a few hundred rows at most):
 *
 *   leaveNow ⟺ remaining ETA_p50(bus → stop) ≤ travelTime + buffer
 *   buffer    = the student's buffer + (ETA_p90 − ETA_p50)      — noisier route ⇒ earlier alert
 *
 * It **emits the event only** (to `stream:notify`); Stage 6 delivers it. Exactly once per
 * (student, trip): the `notified_departure_at IS NULL` compare-and-set in Postgres is the gate
 * (invariant 5), so two evaluators, a restart or a replay cannot fire twice.
 *
 * It never fires from a stale picture: the bus must be LIVE and the ETA must come from a fix no
 * older than two cadences plus ten seconds. A DEGRADED bus waits for its next fix; a DARK one
 * has no ETA at all. Being early costs two minutes; being late costs the bus — but a "leave now"
 * built on a position from three minutes ago is neither, it is a guess.
 *
 * Lifecycle, on the same pass: subscriptions to trips that have ended become `completed`, and a
 * bus that reached or passed the stop before the alert fired makes the subscription `missed`.
 */

export const TICK_MS = 10_000;

export interface LeaveNowDeps {
  db: Queryable;
  redis: Redis;
  keys: Keys;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

interface ActiveSub {
  id: string;
  user_id: string;
  trip_id: string;
  target_stop_id: string;
  travel_time_s: number | null;
  buffer_s: number;
  bus_id: string;
  trip_status: string;
  stop_seq: number;
  stop_index: number;
}

export interface TickReport {
  evaluated: number;
  fired: LeaveNowEvent[];
  completed: number;
  missed: number;
  waiting: { subscriptionId: string; reason: string }[];
}

export function shouldLeave(p: {
  remainingP50S: number;
  p90MinusP50S: number;
  travelTimeS: number;
  bufferS: number;
}): boolean {
  return p.remainingP50S <= p.travelTimeS + p.bufferS + Math.max(0, p.p90MinusP50S);
}

export async function tickOnce(deps: LeaveNowDeps): Promise<TickReport> {
  const now = (deps.now ?? Date.now)();
  const report: TickReport = { evaluated: 0, fired: [], completed: 0, missed: 0, waiting: [] };

  // trips that ended take their subscriptions with them
  const done = await deps.db.query(
    `UPDATE trip_subscriptions s SET state = 'completed'
       FROM trips t
      WHERE t.id = s.trip_id AND s.state = 'active' AND t.status IN ('completed', 'cancelled')
      RETURNING s.id`,
  );
  report.completed = done.rows.length;

  const { rows } = await deps.db.query<ActiveSub>(
    `SELECT s.id, s.user_id, s.trip_id, s.target_stop_id, s.travel_time_s, s.buffer_s,
            t.bus_id, t.status AS trip_status, rs.seq AS stop_seq,
            (SELECT count(*)::int FROM route_stops x WHERE x.route_id = t.route_id AND x.seq < rs.seq) AS stop_index
       FROM trip_subscriptions s
       JOIN trips t ON t.id = s.trip_id
       JOIN LATERAL (SELECT seq FROM route_stops r
                      WHERE r.route_id = t.route_id AND r.stop_id = s.target_stop_id
                      ORDER BY seq LIMIT 1) rs ON true
      WHERE s.state = 'active' AND s.notified_departure_at IS NULL`,
  );
  if (!rows.length) return report;
  const fleet = await readFleet(deps.redis, deps.keys);

  for (const sub of rows) {
    report.evaluated++;
    const bus = fleet[sub.bus_id];
    const wait = (reason: string) => report.waiting.push({ subscriptionId: sub.id, reason });
    if (!bus || bus.tripId !== sub.trip_id) {
      wait("bus not on this trip yet");
      continue;
    }
    if (bus.seq >= sub.stop_index) {
      // the bus reached or passed the stop before the alert could fire
      const m = await deps.db.query(
        `UPDATE trip_subscriptions SET state = 'missed' WHERE id = $1 AND state = 'active' RETURNING id`,
        [sub.id],
      );
      report.missed += m.rows.length;
      continue;
    }
    if (bus.state !== "LIVE") {
      wait(`bus ${bus.state}`);
      continue;
    }
    if (sub.travel_time_s === null) {
      wait("no travel time (no home pin)");
      continue;
    }
    const raw = await deps.redis.hget(deps.keys.tripEta(sub.trip_id), sub.target_stop_id);
    if (!raw) {
      wait("no ETA");
      continue;
    }
    const eta = JSON.parse(raw) as { p50: number; p90: number; at: string };
    const ageS = (now - Date.parse(eta.at)) / 1000;
    if (ageS > 2 * bus.cadence + 10) {
      wait("ETA stale");
      continue;
    }
    const remaining = Math.max(0, eta.p50 - ageS);
    const spread = eta.p90 - eta.p50;
    if (
      !shouldLeave({
        remainingP50S: remaining,
        p90MinusP50S: spread,
        travelTimeS: sub.travel_time_s,
        bufferS: sub.buffer_s,
      })
    )
      continue;

    // exactly once: the database decides who fires (invariant 5)
    const won = await deps.db.query(
      `UPDATE trip_subscriptions SET notified_departure_at = to_timestamp($2 / 1000.0)
        WHERE id = $1 AND notified_departure_at IS NULL AND state = 'active' RETURNING id`,
      [sub.id, now],
    );
    if (!won.rows.length) continue;
    const event: LeaveNowEvent = {
      type: "leave_now",
      subscriptionId: sub.id,
      userId: sub.user_id,
      tripId: sub.trip_id,
      busId: sub.bus_id,
      stopId: sub.target_stop_id,
      etaP50S: Math.round(remaining),
      etaP90S: Math.round(Math.max(remaining, eta.p90 - ageS)),
      travelTimeS: sub.travel_time_s,
      bufferS: sub.buffer_s,
      at: new Date(now).toISOString(),
    };
    await deps.redis.xadd(
      deps.keys.streamNotify,
      "MAXLEN",
      "~",
      STREAMS.NOTIFY_MAXLEN,
      "*",
      "d",
      JSON.stringify(event),
    );
    report.fired.push(event);
  }
  return report;
}

export async function runLeaveNow(deps: LeaveNowDeps & { signal: AbortSignal }): Promise<void> {
  while (!deps.signal.aborted) {
    const started = Date.now();
    try {
      const r = await tickOnce(deps);
      for (const e of r.fired)
        deps.log?.("leave-now: fired", { sub: e.subscriptionId, trip: e.tripId, eta: e.etaP50S });
    } catch (err) {
      // Postgres down: no alert rather than an alert that could fire twice (the gate is there)
      if (deps.signal.aborted) break;
      deps.log?.("leave-now: tick failed", { error: (err as Error).message });
    }
    const wait = Math.max(0, TICK_MS - (Date.now() - started));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      deps.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
