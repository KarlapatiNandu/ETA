import type { BroadcastEvent, NotifyEvent } from "@busmitra/contracts";
import type { Redis } from "ioredis";
import { STREAMS, type Keys } from "./keys.ts";
import { appendEntries } from "./streams.ts";

/**
 * `stream:events` — broadcast-class domain events (ARCH §7): bus.position, bus.status,
 * stop.reached. The SSE gateway tails it and replays it for Last-Event-ID; the stop-events
 * consumer group writes trip_stop_events from it. Per-user frames never go in here
 * (invariant 9).
 */
export async function publishEvents(
  redis: Redis,
  k: Keys,
  events: readonly BroadcastEvent[],
  /** Stage 8: the traceparent each event continues, if any */
  tpOf?: (e: BroadcastEvent) => string | undefined,
): Promise<string[]> {
  return appendEntries(
    redis,
    k.streamEvents,
    events,
    STREAMS.EVENTS_MAXLEN,
    tpOf && ((e) => tpOf(e as BroadcastEvent)),
  );
}

/**
 * `stream:notify` — domain events for the notification spine (SCHEMA §10). They name a student
 * or an admin action, so they never share `stream:events` with the broadcast frames (invariant 9).
 * Callers ring it only after the row it names is committed: the notify worker reads the truth
 * from that row, and sweeps for rows whose doorbell was lost.
 */
export async function ringNotify(
  redis: Redis,
  k: Keys,
  events: readonly NotifyEvent[],
  tp?: string,
): Promise<string[]> {
  return appendEntries(redis, k.streamNotify, events, STREAMS.NOTIFY_MAXLEN, tp);
}
