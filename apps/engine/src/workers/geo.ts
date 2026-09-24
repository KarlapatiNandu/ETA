import { PRESENCE } from "@busmitra/config";
import {
  StreamMessage,
  type BroadcastEvent,
  type SseEventOf,
  type StreamPing,
  type StreamTripEnd,
} from "@busmitra/contracts";
import {
  finishCrossings,
  initialTripState,
  reachedIndex,
  stepTrip,
  type StopEvent,
  type TripGeoState,
} from "@busmitra/geo";
import {
  ack,
  claimStale,
  ensureGroup,
  publishEvents,
  readGroup,
  setFleetState,
  STREAMS,
  TTL,
  writeFleetIfNewer,
  type FleetEntry,
  type Keys,
  type Redis,
  type StreamEntry,
} from "@busmitra/redis";
import { inSpan, traceparentOf } from "@busmitra/telemetry";
import type { RouteCache } from "../lib/route-cache.ts";

/**
 * engine/geo.ts (BUILD_PLAN Stage 2): consumer group `geo` on `stream:pings`.
 *
 *   snap → monotonic progress → EWMA speed → fleet:live (+ bus/trip hint keys)
 *
 * The maths is @busmitra/geo's `stepTrip`; this file only moves state between it and Redis.
 * Per-trip state lives in `trip:{id}:geo`, not in process memory, so a restarted worker
 * resumes mid-trip exactly where the last one stopped.
 *
 * Run ONE geo consumer. A consumer group spreads entries across consumers, which would let two
 * workers step the same trip concurrently. fleet:live stays correct regardless (compare-and-set
 * on ts), but the per-trip state would not. Sharding by bus is the scale-out path, and at 30
 * buses (6 pings/s) it is nowhere near needed.
 *
 * Stage 3: every accepted fix becomes a `bus.position` event on `stream:events`, and every
 * stop crossing a `stop.reached` event — the SSE gateway fans them out, and the stop-events
 * consumer writes them to trip_stop_events (so Postgres is never on this worker's path).
 * Positions are coalesced to the newest per bus per batch: a 500-ping reconnect flush is one
 * frame to every student, not 500.
 */

export interface GeoDeps {
  redis: Redis;
  keys: Keys;
  routes: RouteCache;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

async function loadState(deps: GeoDeps, tripId: string): Promise<TripGeoState> {
  const raw = await deps.redis.get(deps.keys.tripGeo(tripId));
  return raw ? (JSON.parse(raw) as TripGeoState) : initialTripState();
}

export function presenceAtIngest(
  recordedAt: number,
  ingestedAt: number,
  cadenceS: number,
): FleetEntry["state"] {
  const ageS = (ingestedAt - recordedAt) / 1000;
  if (ageS < PRESENCE.DEGRADED_CADENCE_MULTIPLE * cadenceS) return "LIVE";
  if (ageS < PRESENCE.DARK_CADENCE_MULTIPLE * cadenceS) return "DEGRADED";
  return "DARK";
}

/** Events produced while processing a batch, published once before the batch is acked. */
export class EventSink {
  private readonly positions = new Map<string, SseEventOf<"bus.position">>();
  private readonly others: BroadcastEvent[] = [];
  /** Stage 8: the trace each event continues — the span active when it was produced */
  private readonly traces = new WeakMap<BroadcastEvent, string>();

  private trace(e: BroadcastEvent) {
    const tp = traceparentOf();
    if (tp) this.traces.set(e, tp);
  }
  position(e: SseEventOf<"bus.position">) {
    const cur = this.positions.get(e.data.id);
    if (!cur || cur.data.ts < e.data.ts) {
      this.positions.set(e.data.id, e);
      this.trace(e);
    }
  }
  push(e: BroadcastEvent) {
    this.others.push(e);
    this.trace(e);
  }
  traceOf = (e: BroadcastEvent): string | undefined => this.traces.get(e);
  /** stop events first (in the order they happened), then the newest position per bus */
  drain(): BroadcastEvent[] {
    const out = [...this.others, ...this.positions.values()];
    this.others.length = 0;
    this.positions.clear();
    return out;
  }
}

function stopEvents(
  events: readonly StopEvent[],
  trip: { tripId: string; busId: string },
  backfill: boolean,
): SseEventOf<"stop.reached">[] {
  return events.map((e) => ({
    type: "stop.reached",
    data: {
      tripId: trip.tripId,
      busId: trip.busId,
      stopId: e.stopId,
      seq: e.seq,
      event: e.kind,
      at: new Date(e.at).toISOString(),
      backfill,
    },
  }));
}

export async function processPing(
  deps: GeoDeps,
  ping: StreamPing,
  sink: EventSink = new EventSink(),
): Promise<"written" | "stale" | "skipped"> {
  const loaded = await deps.routes.get(ping.route_id);
  if (!loaded) {
    deps.log?.("geo: unknown route, ping skipped", { route: ping.route_id, trip: ping.trip_id });
    return "skipped";
  }
  const state = await loadState(deps, ping.trip_id);
  const at = Date.parse(ping.recorded_at);
  const step = stepTrip(
    state,
    { at, lat: ping.lat, lng: ping.lng, speedKmh: ping.speed_kmh },
    loaded.route,
    loaded.stops,
  );
  if (step.status === "stale") return "stale";

  const k = deps.keys;
  const entry: FleetEntry = {
    lat: ping.lat,
    lng: ping.lng,
    spd: step.speedKmh === null ? null : Math.round(step.speedKmh * 10) / 10,
    hdg: ping.heading_deg,
    s: step.s === null ? null : Math.round(step.s * 10) / 10,
    seq: reachedIndex(step.state.crossing),
    tripId: ping.trip_id,
    ts: new Date(at).toISOString(),
    // a fix is LIVE only if it was fresh when it arrived. The first slice of a reconnect flush
    // can be the newest fix *so far* and still be minutes old; drawing that as LIVE, even for a
    // moment, is a fabricated position (invariant 2). Judged against ingested_at, the gateway's
    // clock at arrival, with the same cadence multiples as the sweeper (invariant 3).
    state: presenceAtIngest(at, Date.parse(ping.ingested_at), ping.cadence_s),
    cadence: ping.cadence_s,
    flag: step.status === "off_route" ? "off_route" : step.resnapped ? "resnapped" : null,
    routeId: ping.route_id,
  };
  const pipe = deps.redis.pipeline();
  pipe.set(k.tripGeo(ping.trip_id), JSON.stringify(step.state), "EX", TTL.TRIP_GEO_S);
  pipe.set(k.tripSeq(ping.trip_id), String(entry.seq), "EX", TTL.TRIP_SEQ_S);
  if (step.state.ewmaKmh !== null) {
    pipe.set(k.busEwma(ping.bus_id), step.state.ewmaKmh.toFixed(2), "EX", TTL.BUS_EWMA_S);
  }
  if (step.state.lastIndex !== null) {
    pipe.set(k.busSnapIdx(ping.bus_id), String(step.state.lastIndex), "EX", TTL.BUS_SNAPIDX_S);
  }
  pipe.set(
    k.busHeartbeat(ping.bus_id),
    entry.ts,
    "EX",
    TTL.BUS_HEARTBEAT_CADENCE_MULTIPLE * ping.cadence_s,
  );
  await pipe.exec();
  // backfill never overwrites a newer live entry (invariant 4) — enforced atomically in Lua
  const wrote = await writeFleetIfNewer(deps.redis, k, ping.bus_id, entry);
  // crossings are history whether or not this fix is the newest one on the map; a crossing
  // derived from buffered pings is marked, so nothing ever notifies from it (invariant 4)
  for (const e of stopEvents(
    step.events,
    { tripId: ping.trip_id, busId: ping.bus_id },
    ping.is_backfill,
  ))
    sink.push(e);
  if (wrote) {
    sink.position({
      type: "bus.position",
      data: {
        id: ping.bus_id,
        lat: entry.lat,
        lng: entry.lng,
        spd: entry.spd,
        hdg: entry.hdg,
        s: entry.s,
        ts: entry.ts,
        tripId: ping.trip_id,
        routeId: ping.route_id,
        seq: entry.seq,
        cadence: entry.cadence,
        flag: entry.flag ?? null,
      },
    });
  }
  if (step.resnapped) deps.log?.("geo: TRIP_RESNAPPED", { trip: ping.trip_id, s: step.s });
  if (step.wentOffRoute) deps.log?.("geo: OFF_ROUTE", { trip: ping.trip_id, bus: ping.bus_id });
  return "written";
}

export async function processTripEnd(
  deps: GeoDeps,
  end: StreamTripEnd,
  sink: EventSink = new EventSink(),
): Promise<void> {
  const state = await loadState(deps, end.trip_id);
  const loaded = await deps.routes.get(end.route_id);
  if (loaded) {
    // a terminal stop crossed but not yet confirmed resolves as arrived (finishCrossings)
    const done = finishCrossings(state.crossing, loaded.stops, Date.parse(end.at));
    for (const e of stopEvents(done.events, { tripId: end.trip_id, busId: end.bus_id }, false))
      sink.push(e);
    const next = { ...state, crossing: done.state };
    await deps.redis.set(deps.keys.tripGeo(end.trip_id), JSON.stringify(next), "EX", 3600);
    await deps.redis.set(
      deps.keys.tripSeq(end.trip_id),
      String(reachedIndex(done.state)),
      "EX",
      3600,
    );
  }
  const entry = await deps.redis.hget(deps.keys.fleetLive, end.bus_id);
  const ended = await setFleetState(deps.redis, deps.keys, end.bus_id, end.trip_id, "ENDED", {
    flag: "trip_end",
  });
  if (ended && entry) {
    const e = JSON.parse(entry) as FleetEntry;
    sink.push({
      type: "bus.status",
      data: {
        id: end.bus_id,
        state: "ENDED",
        reason: "trip_end",
        cadence: e.cadence,
        lastSeenAt: e.ts,
        tripId: end.trip_id,
        at: end.at,
      },
    });
  }
}

/**
 * Process a batch, then publish what it produced. Publishing happens before the caller acks,
 * so a crash in between re-publishes rather than loses: consumers tolerate duplicates
 * (trip_stop_events is unique on (trip_id, seq, event); clients ignore a position that is not
 * newer than the one they hold).
 */
export async function processEntries(
  deps: GeoDeps,
  entries: readonly StreamEntry<unknown>[],
): Promise<{ written: number; stale: number; invalid: number; published: number }> {
  const out = { written: 0, stale: 0, invalid: 0, published: 0 };
  const sink = new EventSink();
  for (const e of entries) {
    const parsed = StreamMessage.safeParse(e.data);
    if (!parsed.success) {
      out.invalid++;
      continue;
    }
    const msg = parsed.data;
    if (msg.kind === "trip_end") {
      await processTripEnd(deps, msg, sink);
      continue;
    }
    // Stage 8: a traced ping gets its own span, child of the ingest request that brought it
    const r = e.tp
      ? await inSpan(
          "geo.step",
          {
            parent: e.tp,
            attributes: { "busmitra.trip": msg.trip_id, "busmitra.backfill": msg.is_backfill },
          },
          async (span) => {
            const res = await processPing(deps, msg, sink);
            span.setAttribute("busmitra.result", res);
            return res;
          },
        )
      : await processPing(deps, msg, sink);
    if (r === "written") out.written++;
    else out.stale++;
  }
  const events = sink.drain();
  await publishEvents(deps.redis, deps.keys, events, sink.traceOf);
  out.published = events.length;
  return out;
}

/**
 * The consumer loop. Order on start: this consumer's own unacked entries (a crash mid-batch),
 * then anything a dead consumer left behind, then new entries. Entries are acknowledged only
 * after their effects are in Redis, so a crash re-processes rather than loses — and
 * re-processing is safe because stepTrip treats an already-seen fix as stale.
 */
export async function runGeoWorker(
  deps: GeoDeps & { stream: Redis; consumer: string; signal: AbortSignal },
): Promise<void> {
  const k = deps.keys;
  const opts = { stream: k.streamPings, group: STREAMS.GROUP_GEO, consumer: deps.consumer };
  await ensureGroup(deps.redis, k.streamPings, STREAMS.GROUP_GEO);
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
      await processEntries(deps, batch);
      await ack(
        deps.redis,
        k.streamPings,
        STREAMS.GROUP_GEO,
        batch.map((e) => e.id),
      );
    } catch (err) {
      if (deps.signal.aborted) break;
      deps.log?.("geo: batch failed, retrying", { error: (err as Error).message });
      recovering = true; // the failed batch is still pending; re-read it
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}
