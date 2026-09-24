import { SseEvent } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import {
  ack,
  claimStale,
  ensureGroup,
  readGroup,
  STREAMS,
  type Keys,
  type Redis,
  type StreamEntry,
} from "@busmitra/redis";

/**
 * Consumer group `stop-events` on `stream:events`: writes every `stop.reached` to
 * trip_stop_events. Kept off the geo worker so Postgres is never on the live path (invariant 1):
 * with the database down the map keeps moving, and the rows land when it comes back.
 *
 * Idempotency is the database's job (invariant 5): UNIQUE (trip_id, seq, event), so a replayed
 * batch or a re-snapped trip that crosses a stop again changes nothing.
 *
 * `source` follows ARCH §5.7: a crossing seen live is `crossing`; a skip, or anything derived
 * from buffered pings flushed late, is `inferred`.
 */

export interface StopEventsDeps {
  db: Queryable;
  redis: Redis;
  keys: Keys;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

/** Integrity errors (FK, check, not-null) mean this row can never be written: skip it. */
const permanent = (err: unknown) => String((err as { code?: string }).code ?? "").startsWith("23");

export async function writeStopEvents(
  deps: StopEventsDeps,
  entries: readonly StreamEntry<unknown>[],
): Promise<{ written: number; duplicate: number; dropped: number }> {
  const out = { written: 0, duplicate: 0, dropped: 0 };
  for (const e of entries) {
    const parsed = SseEvent.safeParse(e.data);
    if (!parsed.success || parsed.data.type !== "stop.reached") continue;
    const d = parsed.data.data;
    const kind = d.event ?? "arrived";
    const source = kind === "skipped" || d.backfill ? "inferred" : "crossing";
    try {
      const res = await deps.db.query(
        `INSERT INTO trip_stop_events (trip_id, stop_id, seq, event, occurred_at, source)
         VALUES ($1, $2, $3, $4::stop_event_t, $5, $6::event_source_t)
         ON CONFLICT (trip_id, seq, event) DO NOTHING RETURNING id`,
        [d.tripId, d.stopId, d.seq, kind, d.at ?? new Date().toISOString(), source],
      );
      if (res.rows.length) out.written++;
      else out.duplicate++;
      if (kind === "arrived" && d.at) {
        // the other half of the Stage 5 accuracy log: what actually happened
        await deps.db.query(
          `UPDATE eta_predictions SET actual_arrival_at = $3
            WHERE trip_id = $1 AND seq = $2 AND actual_arrival_at IS NULL`,
          [d.tripId, d.seq, d.at],
        );
      }
    } catch (err) {
      if (!permanent(err)) throw err; // connection trouble: leave the batch pending, retry
      out.dropped++;
      deps.log?.("stop-events: row refused", {
        trip: d.tripId,
        seq: d.seq,
        error: (err as Error).message,
      });
    }
  }
  return out;
}

export async function runStopEvents(
  deps: StopEventsDeps & { stream: Redis; consumer: string; signal: AbortSignal },
): Promise<void> {
  const k = deps.keys;
  const opts = {
    stream: k.streamEvents,
    group: STREAMS.GROUP_STOP_EVENTS,
    consumer: deps.consumer,
  };
  await ensureGroup(deps.redis, k.streamEvents, STREAMS.GROUP_STOP_EVENTS);
  let recovering = true;
  let lastClaim = 0;
  while (!deps.signal.aborted) {
    try {
      let batch: StreamEntry<unknown>[];
      if (recovering) {
        batch = await readGroup(deps.stream, { ...opts, count: 200, pending: true });
        if (batch.length === 0) recovering = false;
      } else if (Date.now() - lastClaim > 30_000) {
        lastClaim = Date.now();
        batch = await claimStale(deps.stream, { ...opts, minIdleMs: 30_000, count: 200 });
      } else {
        batch = await readGroup(deps.stream, { ...opts, count: 200, blockMs: 1000 });
      }
      if (batch.length === 0) continue;
      await writeStopEvents(deps, batch);
      await ack(
        deps.redis,
        k.streamEvents,
        STREAMS.GROUP_STOP_EVENTS,
        batch.map((e) => e.id),
      );
    } catch (err) {
      if (deps.signal.aborted) break;
      deps.log?.("stop-events: batch failed, retrying", { error: (err as Error).message });
      recovering = true;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
