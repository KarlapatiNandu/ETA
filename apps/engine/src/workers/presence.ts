import { PRESENCE } from "@busmitra/config";
import type { PresenceState, SseEventOf } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import {
  publishEvents,
  readFleet,
  setFleetState,
  TTL,
  type FleetEntry,
  type Keys,
  type Redis,
} from "@busmitra/redis";
import type { RouteCache } from "../lib/route-cache.ts";

/**
 * engine/presence.ts (BUILD_PLAN Stage 3, ARCH §5.7): a 5 s sweeper over `fleet:live` that
 * drives LIVE → DEGRADED → DARK → ENDED.
 *
 * Thresholds are multiples of the cadence the tracker reported with its last fix (3× DEGRADED,
 * 9× DARK, invariant 3), never absolute seconds: a moving bus (5 s) goes amber at 15 s and red
 * at 45 s, a parked one (15 s) at 45 s and 135 s — so a healthy bus standing at a stop stays
 * green. ENDED by timeout is DARK for 10 more minutes; the bus leaves the map, but the trip is
 * not closed, so a tracker that comes back puts it back (the `dark_timeout` flag).
 *
 * Postgres is written on transitions only (signal_outages, trips.status) and is never needed
 * for the transition itself: with the database down, buses still go amber and red on time and
 * the outage row is written when it comes back (invariant 1).
 *
 * Deliberately not built on Redis key-expiry notifications — they are lazy and best-effort.
 */

export const SWEEP_EVERY_MS = 5_000;

/** What the bus's presence is at `now`, from the age of its last fix and its cadence alone. */
export function judgePresence(
  entry: Pick<FleetEntry, "ts" | "cadence" | "state" | "flag">,
  now: number,
): PresenceState {
  // an explicit trip end is final; only the sweeper's own timeout can be undone by a new fix
  if (entry.state === "ENDED" && entry.flag !== "dark_timeout") return "ENDED";
  const cadence = entry.cadence > 0 ? entry.cadence : PRESENCE.DEFAULT_CADENCE_S;
  const ageS = (now - Date.parse(entry.ts)) / 1000;
  if (ageS < PRESENCE.DEGRADED_CADENCE_MULTIPLE * cadence) return "LIVE";
  if (ageS < PRESENCE.DARK_CADENCE_MULTIPLE * cadence) return "DEGRADED";
  if (ageS < PRESENCE.DARK_CADENCE_MULTIPLE * cadence + PRESENCE.ENDED_AFTER_DARK_S) return "DARK";
  return "ENDED";
}

/** The open outage for a bus, kept in Redis so a restarted sweeper finds it. */
export interface OpenOutage {
  tripId: string;
  /** signal_outages.id; null while the row could not be written (Postgres down) */
  id: string | null;
  startedAt: string;
  lat: number;
  lng: number;
  deadZoneId: string | null;
}

export interface DeadZoneHit {
  id: string;
  label: string | null;
  avgOutageS: number;
}

export interface PresenceDeps {
  redis: Redis;
  keys: Keys;
  db: Queryable;
  routes?: RouteCache;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface SweepReport {
  buses: number;
  transitions: { busId: string; from: PresenceState; to: PresenceState; reason: string }[];
  recovered: string[];
  dbErrors: number;
}

/** Point-in-polygon against learned dead zones (Stage 8 fills the table; empty is honest). */
export async function classifyDeadZone(
  db: Queryable,
  at: { lat: number; lng: number },
  lineageId: string | null,
): Promise<DeadZoneHit | null> {
  const { rows } = await db.query<{ id: string; label: string | null; avg_outage_s: number }>(
    `SELECT id, label, avg_outage_s FROM dead_zones
      WHERE retired_at IS NULL
        AND ST_Covers(polygon, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography)
        AND (route_lineage_id IS NULL OR route_lineage_id = $3::uuid)
      ORDER BY confidence DESC LIMIT 1`,
    [at.lng, at.lat, lineageId],
  );
  const r = rows[0];
  return r ? { id: r.id, label: r.label, avgOutageS: Number(r.avg_outage_s) } : null;
}

async function insertOutage(db: Queryable, busId: string, o: OpenOutage): Promise<string> {
  // one_open_outage: a second sweeper (or a restart) finds the row instead of adding another
  const ins = await db.query<{ id: string }>(
    `INSERT INTO signal_outages (trip_id, bus_id, entry_point, started_at, dead_zone_id)
     VALUES ($1, $2, ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography, $5, $6)
     ON CONFLICT (trip_id) WHERE recovered_at IS NULL DO NOTHING RETURNING id`,
    [o.tripId, busId, o.lng, o.lat, o.startedAt, o.deadZoneId],
  );
  if (ins.rows[0]) return ins.rows[0].id;
  const found = await db.query<{ id: string }>(
    `SELECT id FROM signal_outages WHERE trip_id = $1 AND recovered_at IS NULL`,
    [o.tripId],
  );
  return found.rows[0]!.id;
}

async function closeOutage(
  db: Queryable,
  busId: string,
  o: OpenOutage,
  exit: { lat: number; lng: number; at: string } | null,
): Promise<void> {
  const id = o.id ?? (await insertOutage(db, busId, o));
  if (exit) {
    await db.query(
      `UPDATE signal_outages
          SET recovered_at = GREATEST($2::timestamptz, started_at),
              exit_point = ST_SetSRID(ST_MakePoint($3, $4), 4326)::geography
        WHERE id = $1 AND recovered_at IS NULL`,
      [id, exit.at, exit.lng, exit.lat],
    );
    await db.query(`UPDATE trips SET status = 'running' WHERE id = $1 AND status = 'dark'`, [
      o.tripId,
    ]);
  }
}

/**
 * One pass. Every write to `fleet:live` is a compare-and-set on the fix the judgement was made
 * from, so a ping that lands mid-sweep wins, and a transition already made (by another sweeper)
 * is not announced twice.
 */
export async function sweepOnce(deps: PresenceDeps): Promise<SweepReport> {
  const now = (deps.now ?? Date.now)();
  const k = deps.keys;
  const fleet = await readFleet(deps.redis, k);
  const report: SweepReport = { buses: 0, transitions: [], recovered: [], dbErrors: 0 };
  const events: SseEventOf<"bus.status">[] = [];
  const at = new Date(now).toISOString();

  const tryDb = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      report.dbErrors++;
      deps.log?.("presence: database write deferred", { what, error: (err as Error).message });
      return undefined;
    }
  };

  const busIds = Object.keys(fleet);
  const outageRaw = busIds.length ? await deps.redis.mget(busIds.map((id) => k.busOutage(id))) : [];

  for (const [i, busId] of busIds.entries()) {
    const e = fleet[busId]!;
    if (!e.tripId) continue;
    report.buses++;
    let outage = outageRaw[i] ? (JSON.parse(outageRaw[i]!) as OpenOutage) : null;
    const next = judgePresence(e, now);
    const explicitEnd = e.state === "ENDED" && e.flag !== "dark_timeout";

    // ── an open outage ends: the bus reported again, ended its trip, or moved to a new trip
    if (outage && (outage.tripId !== e.tripId || next === "LIVE" || explicitEnd)) {
      const recovered = outage.tripId === e.tripId && next === "LIVE";
      const exit = recovered || explicitEnd ? { lat: e.lat, lng: e.lng, at: e.ts } : null;
      const o = outage;
      const done = await tryDb("close outage", async () => {
        await closeOutage(deps.db, busId, o, exit);
        return true;
      });
      // with Postgres down the key stays, and the close is retried on the next pass
      if (done) await deps.redis.del(k.busOutage(busId));
      if (recovered) {
        report.recovered.push(busId);
        events.push({
          type: "bus.status",
          data: {
            id: busId,
            state: "LIVE",
            reason: "recovered",
            cadence: e.cadence,
            lastSeenAt: e.ts,
            tripId: e.tripId,
            at,
          },
        });
      }
      outage = null;
    }

    // ── an outage whose row could not be written yet (Postgres was down): try again
    if (outage && outage.id === null) {
      const o = outage;
      const id = await tryDb("open outage (retry)", () => insertOutage(deps.db, busId, o));
      if (id) {
        await deps.redis.set(
          k.busOutage(busId),
          JSON.stringify({ ...o, id }),
          "EX",
          TTL.BUS_OUTAGE_S,
        );
      }
    }

    // DARK with no outage on record — an entry rehydrated as DARK after a Redis loss, or an
    // outage key that expired: the silence is real, so it is logged (no second announcement)
    if (next === "DARK" && e.state === "DARK" && !outage) {
      const o: OpenOutage = {
        tripId: e.tripId,
        id: null,
        startedAt: e.ts,
        lat: e.lat,
        lng: e.lng,
        deadZoneId: null,
      };
      const id = await tryDb("open outage (no transition)", () => insertOutage(deps.db, busId, o));
      await deps.redis.set(
        k.busOutage(busId),
        JSON.stringify({ ...o, id: id ?? null }),
        "EX",
        TTL.BUS_OUTAGE_S,
      );
      continue;
    }

    if (explicitEnd || next === e.state || next === "LIVE") continue;

    // ── a transition: DEGRADED, DARK or ENDED (by timeout)
    let reason = next === "DEGRADED" ? "late" : next === "ENDED" ? "dark_timeout" : "signal_lost";
    let deadZone: FleetEntry["deadZone"] = e.deadZone ?? null;
    let zoneId: string | null = null;
    if (next === "DARK" || (next === "ENDED" && !outage)) {
      const lineage =
        e.routeId && deps.routes
          ? ((await deps.routes.get(e.routeId).catch(() => null))?.lineageId ?? null)
          : null;
      const hit = await tryDb("classify dead zone", () => classifyDeadZone(deps.db, e, lineage));
      if (hit) {
        deadZone = { label: hit.label, avgOutageS: hit.avgOutageS };
        zoneId = hit.id;
        if (next === "DARK") reason = "known_dead_zone";
      }
    }
    const moved = await setFleetState(deps.redis, k, busId, e.tripId, next, {
      expectTs: e.ts,
      ...(next === "ENDED" ? { flag: "dark_timeout" } : {}),
      deadZone,
    });
    if (!moved) continue; // a newer fix landed, or another sweeper got there first

    report.transitions.push({ busId, from: e.state, to: next, reason });
    events.push({
      type: "bus.status",
      data: {
        id: busId,
        state: next,
        reason,
        cadence: e.cadence,
        lastSeenAt: e.ts,
        tripId: e.tripId,
        at,
        deadZone,
      },
    });

    if ((next === "DARK" || next === "ENDED") && !outage) {
      const o: OpenOutage = {
        tripId: e.tripId,
        id: null,
        // the outage began at the last fix we have, not when we noticed
        startedAt: e.ts,
        lat: e.lat,
        lng: e.lng,
        deadZoneId: zoneId,
      };
      const tripId = e.tripId;
      const id = await tryDb("open outage", async () => {
        const rowId = await insertOutage(deps.db, busId, o);
        await deps.db.query(
          `UPDATE trips SET status = 'dark' WHERE id = $1 AND status = 'running'`,
          [tripId],
        );
        return rowId;
      });
      await deps.redis.set(
        k.busOutage(busId),
        JSON.stringify({ ...o, id: id ?? null }),
        "EX",
        TTL.BUS_OUTAGE_S,
      );
    }
  }

  await publishEvents(deps.redis, k, events);
  return report;
}

/** The sweeper loop: a pass every 5 s until aborted. A failed pass is logged, never fatal. */
export async function runPresence(deps: PresenceDeps & { signal: AbortSignal }): Promise<void> {
  while (!deps.signal.aborted) {
    const started = Date.now();
    try {
      const r = await sweepOnce(deps);
      for (const t of r.transitions) deps.log?.("presence: transition", t);
      for (const b of r.recovered) deps.log?.("presence: recovered", { busId: b });
    } catch (err) {
      if (deps.signal.aborted) break;
      deps.log?.("presence: sweep failed", { error: (err as Error).message });
    }
    const wait = Math.max(0, SWEEP_EVERY_MS - (Date.now() - started));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      deps.signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
    });
  }
}
