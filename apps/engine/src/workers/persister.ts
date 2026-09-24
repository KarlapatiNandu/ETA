import { StreamMessage, type StreamPing } from "@busmitra/contracts";
import { toCsv, type Db } from "@busmitra/db";
import { snapToRoute, SNAP } from "@busmitra/geo";
import {
  ack,
  appendEntries,
  claimStale,
  ensureGroup,
  readGroup,
  STREAMS,
  type Keys,
  type Redis,
  type StreamEntry,
} from "@busmitra/redis";
import type { RouteCache } from "../lib/route-cache.ts";

/**
 * engine/persister.ts (BUILD_PLAN Stage 2): consumer group `persist` on `stream:pings`.
 *
 * Batches 200 rows or 2 s, then:
 *
 *   COPY → positions_staging (a temp table: unlogged, private to this transaction)
 *   INSERT INTO positions SELECT … ON CONFLICT (trip_id, recorded_at) DO NOTHING
 *
 * COPY has no ON CONFLICT: one duplicate aborts the whole batch, and a tracker retrying after
 * a timeout is an everyday event (SCHEMA §4). Staging keeps COPY's throughput and makes a
 * duplicate a no-op. Nobody waits on this worker (invariant 1): if Postgres is down, entries
 * stay pending in the stream and are written when it comes back.
 */

export const PERSIST = { BATCH_ROWS: 200, BATCH_MS: 2000 } as const;

const STAGING_COLUMNS = [
  "trip_id",
  "bus_id",
  "recorded_at",
  "ingested_at",
  "lng",
  "lat",
  "speed_kmh",
  "heading_deg",
  "accuracy_m",
  "route_offset_m",
  "is_backfill",
] as const;

const CREATE_STAGING = `
  CREATE TEMP TABLE positions_staging (
    trip_id uuid, bus_id uuid, recorded_at timestamptz, ingested_at timestamptz,
    lng double precision, lat double precision, speed_kmh real, heading_deg smallint,
    accuracy_m real, route_offset_m double precision, is_backfill boolean
  ) ON COMMIT DROP`;

const MERGE = `
  INSERT INTO positions (trip_id, bus_id, recorded_at, ingested_at, location, speed_kmh,
                         heading_deg, accuracy_m, route_offset_m, is_backfill)
  SELECT trip_id, bus_id, recorded_at, ingested_at,
         ST_SetSRID(ST_MakePoint(lng, lat), 4326)::geography,
         speed_kmh, heading_deg, accuracy_m, route_offset_m, is_backfill
    FROM positions_staging
  ON CONFLICT (trip_id, recorded_at) DO NOTHING`;

export interface PersisterDeps {
  db: Db;
  redis: Redis;
  keys: Keys;
  routes: RouteCache;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/**
 * Last snapped vertex per trip — the window hint, so history on a loop route snaps to the
 * right pass. Bounded: a long-running worker sees a new trip id twice a day per bus, and a
 * map that only ever grows is a leak with a slow fuse.
 */
const HINT_LIMIT = 500;
const hints = new Map<string, number>();

/**
 * route_offset_m for the history table. The persister snaps independently of the geo worker so
 * that neither waits on the other; NULL when the fix is off the route (never fabricated).
 */
async function offsetFor(routes: RouteCache, p: StreamPing): Promise<number | null> {
  const loaded = await routes.get(p.route_id);
  if (!loaded) return null;
  const snap = snapToRoute(p, loaded.route, hints.get(p.trip_id) ?? null);
  if (snap.distance > SNAP.OFF_ROUTE_M) return null;
  if (hints.size >= HINT_LIMIT && !hints.has(p.trip_id)) {
    // drop the oldest insertion (Map keeps insertion order); at worst one trip re-snaps globally
    hints.delete(hints.keys().next().value!);
  }
  hints.set(p.trip_id, snap.index);
  return Math.round(snap.s * 10) / 10;
}

function row(p: StreamPing, offset: number | null): unknown[] {
  return [
    p.trip_id,
    p.bus_id,
    p.recorded_at,
    p.ingested_at,
    p.lng,
    p.lat,
    p.speed_kmh,
    p.heading_deg,
    p.accuracy_m,
    offset,
    p.is_backfill,
  ];
}

/** A Postgres outage (retry later, keep the entries pending) versus a bad row (dead-letter it). */
export function isOutage(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  if (!e?.code) return true; // ECONNREFUSED, socket closed, pool timeout: no SQLSTATE at all
  if (/^E[A-Z]+$/.test(e.code)) return true; // node network errors (ECONNRESET, ETIMEDOUT, …)
  // class 08 connection exceptions, 57P0x shutdown/crash, 53xxx resources
  return e.code.startsWith("08") || e.code.startsWith("57P") || e.code.startsWith("53");
}

async function writeRows(db: Db, rows: unknown[][]): Promise<number> {
  return db.tx(async (q) => {
    if (!q.copyFrom) throw new Error("persister needs a Db whose transactions support COPY");
    await q.query(CREATE_STAGING);
    await q.copyFrom("positions_staging", STAGING_COLUMNS, toCsv(rows));
    const res = await q.query(`${MERGE} RETURNING 1`);
    return res.rows.length;
  });
}

export interface FlushResult {
  inserted: number;
  duplicates: number;
  dead: number;
}

/**
 * Write one batch. Returns normally when every entry is accounted for (inserted, a duplicate,
 * or dead-lettered) and may be acknowledged; throws when Postgres is unreachable, in which case
 * nothing must be acknowledged.
 */
export async function flushBatch(
  deps: PersisterDeps,
  entries: readonly StreamEntry<unknown>[],
): Promise<FlushResult> {
  const pings: { id: string; ping: StreamPing }[] = [];
  const dead: { id: string; reason: string; data: unknown }[] = [];
  for (const e of entries) {
    const parsed = StreamMessage.safeParse(e.data);
    if (!parsed.success) dead.push({ id: e.id, reason: "invalid stream entry", data: e.data });
    else if (parsed.data.kind === "ping") pings.push({ id: e.id, ping: parsed.data });
    // trip_end carries nothing to persist here (the trips row is written by the gateway)
  }
  const rows: unknown[][] = [];
  for (const { ping } of pings) rows.push(row(ping, await offsetFor(deps.routes, ping)));

  let inserted = 0;
  if (rows.length) {
    try {
      inserted = await writeRows(deps.db, rows);
    } catch (err) {
      if (isOutage(err)) throw err;
      // one bad row poisons a COPY; find it by writing the batch one row at a time
      deps.log?.("persist: batch rejected, isolating bad rows", { error: (err as Error).message });
      inserted = 0;
      for (const [i, r] of rows.entries()) {
        try {
          inserted += await writeRows(deps.db, [r]);
        } catch (rowErr) {
          if (isOutage(rowErr)) throw rowErr;
          dead.push({ id: pings[i]!.id, reason: (rowErr as Error).message, data: pings[i]!.ping });
        }
      }
    }
  }
  if (dead.length) {
    await appendEntries(
      deps.redis,
      deps.keys.streamPingsDead,
      dead.map((d) => ({ stream_id: d.id, reason: d.reason, entry: d.data })),
      STREAMS.DEAD_MAXLEN,
    );
    deps.log?.("persist: dead-lettered", { count: dead.length, first: dead[0]!.reason });
  }
  const deadPings = dead.filter((d) => pings.some((p) => p.id === d.id)).length;
  return { inserted, duplicates: pings.length - deadPings - inserted, dead: dead.length };
}

/**
 * The consumer loop: accumulate up to BATCH_ROWS, or whatever arrived within BATCH_MS of the
 * first entry, then flush and acknowledge. On an outage nothing is acknowledged; the loop
 * backs off and re-reads its own pending entries, so the stream is the buffer (ARCH §11).
 */
export async function runPersister(
  deps: PersisterDeps & { stream: Redis; consumer: string; signal: AbortSignal },
): Promise<void> {
  const k = deps.keys;
  const opts = { stream: k.streamPings, group: STREAMS.GROUP_PERSIST, consumer: deps.consumer };
  await ensureGroup(deps.redis, k.streamPings, STREAMS.GROUP_PERSIST);
  let recovering = true;
  let lastClaim = 0;
  let backoff = 1000;
  while (!deps.signal.aborted) {
    try {
      let batch: StreamEntry<unknown>[];
      if (recovering) {
        batch = await readGroup(deps.stream, { ...opts, count: PERSIST.BATCH_ROWS, pending: true });
        if (batch.length === 0) recovering = false;
      } else if (Date.now() - lastClaim > 30_000) {
        lastClaim = Date.now();
        batch = await claimStale(deps.stream, {
          ...opts,
          minIdleMs: 30_000,
          count: PERSIST.BATCH_ROWS,
        });
      } else {
        batch = await readGroup(deps.stream, { ...opts, count: PERSIST.BATCH_ROWS, blockMs: 1000 });
        const deadline = Date.now() + PERSIST.BATCH_MS;
        while (batch.length > 0 && batch.length < PERSIST.BATCH_ROWS && Date.now() < deadline) {
          const more = await readGroup(deps.stream, {
            ...opts,
            count: PERSIST.BATCH_ROWS - batch.length,
            blockMs: Math.max(1, deadline - Date.now()),
          });
          batch = batch.concat(more);
        }
      }
      if (batch.length === 0) continue;
      const r = await flushBatch(deps, batch);
      await ack(
        deps.redis,
        k.streamPings,
        STREAMS.GROUP_PERSIST,
        batch.map((e) => e.id),
      );
      if (r.duplicates || r.dead) deps.log?.("persist: batch", { size: batch.length, ...r });
      backoff = 1000;
    } catch (err) {
      if (deps.signal.aborted) break;
      deps.log?.("persist: postgres unavailable, entries stay pending", {
        error: (err as Error).message,
        retryInMs: backoff,
      });
      recovering = true;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
