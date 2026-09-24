import type { Db } from "@busmitra/db";
import { STREAMS, type Keys, type Redis } from "@busmitra/redis";
import type { RunReport } from "./run.ts";

/**
 * The Stage 2 exit check: after a run, `positions` must hold exactly the fixes the fleet
 * sent — none dropped, none duplicated — with original timestamps, and with `is_backfill` set
 * on exactly the ones that arrived more than 30 s after they were recorded.
 */

export interface Verdict {
  expected: number;
  persisted: number;
  missing: number;
  unexpected: number;
  duplicated: number;
  backfill: { expected: number; flagged: number; wronglyFlagged: number; missed: number };
  offsets: { withOffset: number; offRoute: number };
  perTrip: { bus: string; tripId: string; expected: number; persisted: number }[];
  ok: boolean;
}

/** Wait until the persister has caught up: nothing pending, nothing unread. */
export async function waitForDrain(
  redis: Redis,
  keys: Keys,
  timeoutMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const groups = (await redis.call("XINFO", "GROUPS", keys.streamPings)) as unknown[][];
    const persist = groups
      .map((g) =>
        Object.fromEntries(
          Array.from({ length: g.length / 2 }, (_, i) => [g[2 * i], g[2 * i + 1]]),
        ),
      )
      .find((g) => g.name === STREAMS.GROUP_PERSIST);
    if (persist && Number(persist.pending) === 0 && Number(persist.lag ?? 0) === 0) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/** A fix counts as backfill when it reached the gateway more than 30 s after it was recorded. */
const BACKFILL_MS = 30_000;
/** margin either side for request latency; fixes inside it are not judged */
const SLACK_MS = 3_000;

export async function verifyRun(db: Db, report: RunReport): Promise<Verdict> {
  const v: Verdict = {
    expected: 0,
    persisted: 0,
    missing: 0,
    unexpected: 0,
    duplicated: 0,
    backfill: { expected: 0, flagged: 0, wronglyFlagged: 0, missed: 0 },
    offsets: { withOffset: 0, offRoute: 0 },
    perTrip: [],
    ok: false,
  };
  for (const trip of report.trips) {
    const { rows } = await db.query<{
      recorded_at: Date;
      is_backfill: boolean;
      route_offset_m: number | null;
    }>(`SELECT recorded_at, is_backfill, route_offset_m FROM positions WHERE trip_id = $1`, [
      trip.tripId,
    ]);
    const got = new Map<string, { backfill: boolean }>();
    for (const r of rows) {
      const k = new Date(r.recorded_at).toISOString();
      if (got.has(k)) v.duplicated++;
      got.set(k, { backfill: r.is_backfill });
      if (r.route_offset_m === null) v.offsets.offRoute++;
      else v.offsets.withOffset++;
    }
    const expected = Object.entries(trip.fixes);
    v.expected += expected.length;
    v.persisted += rows.length;
    v.perTrip.push({
      bus: trip.bus,
      tripId: trip.tripId,
      expected: expected.length,
      persisted: rows.length,
    });
    for (const [recordedAt, sentAt] of expected) {
      const row = got.get(recordedAt);
      if (!row) {
        v.missing++;
        continue;
      }
      const lag = sentAt - Date.parse(recordedAt);
      if (lag > BACKFILL_MS + SLACK_MS) {
        v.backfill.expected++;
        if (row.backfill) v.backfill.flagged++;
        else v.backfill.missed++;
      } else if (lag < BACKFILL_MS - SLACK_MS && row.backfill) {
        v.backfill.wronglyFlagged++;
      }
      got.delete(recordedAt);
    }
    v.unexpected += got.size;
  }
  v.ok =
    v.missing === 0 &&
    v.unexpected === 0 &&
    v.duplicated === 0 &&
    v.backfill.missed === 0 &&
    v.backfill.wronglyFlagged === 0 &&
    report.fleetRegressions === 0 &&
    report.failedBatches.length === 0;
  return v;
}
