import { SseEvent, type SseEventOf } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import { computeEta, ETA, type Eta } from "@busmitra/geo";
import { inSpan } from "@busmitra/telemetry";
import {
  ack,
  claimStale,
  ensureGroup,
  readGroup,
  STREAMS,
  TTL,
  type Keys,
  type Redis,
  type StreamEntry,
} from "@busmitra/redis";
import type { RouteCache } from "../lib/route-cache.ts";
import { osrmSegmentSpeeds, type HistoryCache } from "../lib/speed-model.ts";
import type { Osrm } from "../osrm.ts";

/**
 * engine/eta.ts (BUILD_PLAN Stage 5, ARCH §5.5): consumer group `eta` on `stream:events`.
 *
 * Every accepted position → the ETA to each stop still ahead of the bus, as a range:
 *   `trip:{id}:eta` HASH stop_id → {p50, p90, confidence, at, rung}   (5 min TTL)
 * and an `eta.update` on the `pubsub:eta` channel when a stop's ETA moves by more than 30 s
 * against what was last announced — the gateway turns that into per-user frames for the
 * connections watching that stop. Pub/sub, not the stream: ETA frames are per-user and are
 * re-derived on connect from the hash, never replayed (invariant 9).
 *
 * It never fabricates (invariant 2): no ETA while the bus is off-route, for one cycle after a
 * re-snap (ARCH §5.3), or once the bus is DARK or ENDED — those are withdrawn, so a client
 * stops counting down instead of counting down to nothing.
 *
 * Predictions are logged to `eta_predictions` once per stop as p50 enters the 10-, 5- and
 * 2-minute buckets; the stop-events worker fills in the actual arrival. That is the evidence
 * for the Stage 5 MAE gate.
 */

/** ETA frames are announced when p50 moves this much against the last announcement. */
export const MATERIAL_CHANGE_S = 30;
/** log a prediction for horizon H when p50 ∈ (H − 60, H] */
export const HORIZONS_S = [600, 300, 120] as const;

export interface EtaDeps {
  redis: Redis;
  keys: Keys;
  routes: RouteCache;
  history: HistoryCache;
  db?: Queryable;
  osrm?: Osrm;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface StopEta extends Eta {
  stopId: string;
  seq: number;
  /** the fix the prediction starts from, ISO */
  at: string;
  rung: number | null;
}

export interface EtaFrame {
  tripId: string;
  stopId: string;
  p50: number;
  p90: number;
  confidence?: Eta["confidence"];
  at?: string;
  withdrawn?: boolean;
}

/** Last announced ETA per trip|stop, and which horizons are already logged — process memory. */
export class EtaMemory {
  readonly announced = new Map<string, { p50: number; at: number }>();
  readonly logged = new Set<string>();
}

/** The ETAs to every stop ahead of `seq` from offset `s`. Pure given its inputs. */
export async function etasFor(
  deps: EtaDeps,
  p: { routeId: string; s: number; seq: number; at: number; liveKmh: number | null },
): Promise<StopEta[]> {
  const loaded = await deps.routes.get(p.routeId);
  if (!loaded) return [];
  const segments = Math.ceil(loaded.route.total / ETA.SEGMENT_M);
  const [{ hist, rungs }, osrm] = await Promise.all([
    deps.history.resolve(loaded.lineageId, segments, p.at),
    osrmSegmentSpeeds(loaded.route, loaded.id, deps),
  ]);
  const model = { hist, osrm, liveKmh: p.liveKmh };
  const dwell = loaded.stops.map((st, i) => ({
    offset: st.offset,
    dwellS: loaded.dwellS?.[i] ?? null,
  }));
  const here = Math.floor(p.s / ETA.SEGMENT_M);
  const out: StopEta[] = [];
  const seen = new Set<string>();
  for (let i = p.seq + 1; i < loaded.stops.length; i++) {
    const st = loaded.stops[i]!;
    if (st.offset < p.s) continue; // behind the bus but not yet written off: no ETA to the past
    // a circular route serves some stop twice (SCHEMA §3); the student there wants the next pass
    if (seen.has(st.stopId)) continue;
    seen.add(st.stopId);
    const eta = computeEta(p.s, st.offset, model, dwell);
    out.push({
      ...eta,
      stopId: st.stopId,
      seq: st.seq,
      at: new Date(p.at).toISOString(),
      rung: rungs[here] ?? null,
    });
  }
  return out;
}

async function withdraw(deps: EtaDeps, mem: EtaMemory, tripId: string): Promise<EtaFrame[]> {
  const k = deps.keys.tripEta(tripId);
  const stops = await deps.redis.hkeys(k);
  await deps.redis.del(k);
  const frames: EtaFrame[] = [];
  for (const stopId of stops) {
    mem.announced.delete(`${tripId}|${stopId}`);
    frames.push({ tripId, stopId, p50: 0, p90: 0, withdrawn: true });
  }
  return frames;
}

async function logPredictions(deps: EtaDeps, mem: EtaMemory, tripId: string, etas: StopEta[]) {
  if (!deps.db) return;
  for (const e of etas) {
    for (const h of HORIZONS_S) {
      const key = `${tripId}|${e.seq}|${h}`;
      if (mem.logged.has(key) || !(e.p50S <= h && e.p50S > h - 60)) continue;
      mem.logged.add(key);
      const at = Date.parse(e.at);
      try {
        await deps.db.query(
          `INSERT INTO eta_predictions (trip_id, seq, stop_id, horizon_s, predicted_at, p50_s, p90_s,
                                        confidence, rung, predicted_arrival_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT DO NOTHING`,
          [
            tripId,
            e.seq,
            e.stopId,
            h,
            e.at,
            e.p50S,
            e.p90S,
            e.confidence,
            e.rung,
            new Date(at + e.p50S * 1000).toISOString(),
          ],
        );
      } catch (err) {
        // the accuracy log must never cost a live ETA; losing a sample is logged, not fatal
        deps.log?.("eta: prediction not logged", { error: (err as Error).message });
      }
    }
  }
}

/** One broadcast event through the ETA engine; returns the frames to announce. */
export async function processEvent(
  deps: EtaDeps,
  mem: EtaMemory,
  e: SseEvent,
): Promise<EtaFrame[]> {
  if (e.type === "bus.status") {
    const d = e.data;
    if ((d.state === "DARK" || d.state === "ENDED") && d.tripId) {
      return withdraw(deps, mem, d.tripId);
    }
    return [];
  }
  if (e.type !== "bus.position") return [];
  const d = e.data as SseEventOf<"bus.position">["data"];
  if (!d.tripId || !d.routeId) return [];
  // off-route, or the one cycle after a re-snap: no ETA rather than a wrong one
  if (d.s === null || d.flag === "off_route" || d.flag === "resnapped")
    return withdraw(deps, mem, d.tripId);

  const at = Date.parse(d.ts);
  const ewma = await deps.redis.get(deps.keys.busEwma(d.id));
  const liveKmh = ewma === null ? (d.spd ?? null) : Number(ewma);
  const etas = await etasFor(deps, { routeId: d.routeId, s: d.s, seq: d.seq ?? -1, at, liveKmh });

  const k = deps.keys.tripEta(d.tripId);
  const pipe = deps.redis.pipeline();
  // stops the bus has passed since the last fix leave the hash (and are withdrawn below)
  const previous = await deps.redis.hkeys(k);
  const ahead = new Set(etas.map((x) => x.stopId));
  const passed = previous.filter((id) => !ahead.has(id));
  if (passed.length) pipe.hdel(k, ...passed);
  for (const x of etas)
    pipe.hset(
      k,
      x.stopId,
      JSON.stringify({
        p50: x.p50S,
        p90: x.p90S,
        confidence: x.confidence,
        at: x.at,
        rung: x.rung,
      }),
    );
  pipe.expire(k, TTL.TRIP_ETA_S);
  await pipe.exec();

  const frames: EtaFrame[] = passed.map((stopId) => {
    mem.announced.delete(`${d.tripId}|${stopId}`);
    return { tripId: d.tripId!, stopId, p50: 0, p90: 0, withdrawn: true };
  });
  for (const x of etas) {
    const key = `${d.tripId}|${x.stopId}`;
    const last = mem.announced.get(key);
    const expected = last ? last.p50 - (at - last.at) / 1000 : null;
    if (expected !== null && Math.abs(x.p50S - expected) <= MATERIAL_CHANGE_S) continue;
    mem.announced.set(key, { p50: x.p50S, at });
    frames.push({
      tripId: d.tripId,
      stopId: x.stopId,
      p50: x.p50S,
      p90: x.p90S,
      confidence: x.confidence,
      at: x.at,
    });
  }
  await logPredictions(deps, mem, d.tripId, etas);
  return frames;
}

export async function processEtaEntries(
  deps: EtaDeps,
  mem: EtaMemory,
  entries: readonly StreamEntry<unknown>[],
): Promise<EtaFrame[]> {
  const frames: EtaFrame[] = [];
  for (const entry of entries) {
    const parsed = SseEvent.safeParse(entry.data);
    if (!parsed.success) continue;
    const ev = parsed.data;
    // Stage 8: an ETA recomputed from a traced fix is part of that fix's trace
    frames.push(
      ...(entry.tp && ev.type === "bus.position"
        ? await inSpan("eta.compute", { parent: entry.tp }, () => processEvent(deps, mem, ev))
        : await processEvent(deps, mem, ev)),
    );
  }
  if (frames.length) await deps.redis.publish(deps.keys.etaChannel, JSON.stringify(frames));
  return frames;
}

export async function runEtaWorker(
  deps: EtaDeps & { stream: Redis; consumer: string; signal: AbortSignal },
): Promise<void> {
  const k = deps.keys;
  const mem = new EtaMemory();
  const opts = { stream: k.streamEvents, group: STREAMS.GROUP_ETA, consumer: deps.consumer };
  await ensureGroup(deps.redis, k.streamEvents, STREAMS.GROUP_ETA);
  // start from now, on every boot: an ETA computed from a fix that is minutes old is worthless,
  // and the next position of every running bus recomputes them all within one cadence
  await deps.redis.xgroup("SETID", k.streamEvents, STREAMS.GROUP_ETA, "$").catch(() => undefined);
  let lastClaim = Date.now();
  while (!deps.signal.aborted) {
    try {
      let batch: StreamEntry<unknown>[];
      if (Date.now() - lastClaim > 30_000) {
        lastClaim = Date.now();
        batch = await claimStale(deps.stream, { ...opts, minIdleMs: 30_000, count: 200 });
      } else {
        batch = await readGroup(deps.stream, { ...opts, count: 200, blockMs: 1000 });
      }
      if (batch.length === 0) continue;
      await processEtaEntries(deps, mem, batch);
      await ack(
        deps.redis,
        k.streamEvents,
        STREAMS.GROUP_ETA,
        batch.map((e) => e.id),
      );
    } catch (err) {
      if (deps.signal.aborted) break;
      deps.log?.("eta: batch failed, retrying", { error: (err as Error).message });
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
