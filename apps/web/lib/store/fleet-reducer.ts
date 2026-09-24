import type { LiveBus, PresenceState, SseEvent } from "@busmitra/contracts";

/**
 * The fleet store's state transitions, as a pure function so the ordering rules are tested:
 *
 *  - a position older than the one held is ignored (replay, a reordered frame);
 *  - a status judged against an older fix than the one held is stale and ignored — a replayed
 *    DEGRADED must not turn a bus that has since reported back amber;
 *  - ENDED removes the bus (ARCH §5.7): it is never drawn, frozen or otherwise;
 *  - a snapshot is everything this connection wants, so it replaces the fleet.
 */

export interface BusView extends LiveBus {
  reason?: string | null;
  /** when the current state was entered (server clock, ms) */
  stateSince?: number;
}

export interface StopMark {
  seq: number;
  stopId: string;
  event: "arrived" | "departed" | "skipped";
  at: string | null;
  backfill: boolean;
}

/** A live ETA to one stop on one trip (Stage 5): p50/p90 seconds from `at`, the fix time. */
export interface StopEta {
  p50: number;
  p90: number;
  confidence: "high" | "medium" | "low" | null;
  at: string | null;
}

/** ARCH §5.7 by age alone: 3× cadence DEGRADED, 9× DARK (never absolute seconds). */
export function presenceByAge(ts: string, cadenceS: number, serverNow: number): PresenceState {
  const ageS = (serverNow - Date.parse(ts)) / 1000;
  if (ageS < 3 * cadenceS) return "LIVE";
  if (ageS < 9 * cadenceS) return "DEGRADED";
  return "DARK";
}

export const etaKey = (tripId: string, stopId: string) => `${tripId}|${stopId}`;

/** Seconds left on an ETA at `serverNow`: the countdown between frames. */
export function remaining(eta: StopEta, serverNow: number): { p50: number; p90: number } {
  const elapsed = eta.at ? Math.max(0, (serverNow - Date.parse(eta.at)) / 1000) : 0;
  return { p50: Math.max(0, eta.p50 - elapsed), p90: Math.max(0, eta.p90 - elapsed) };
}

export interface FleetState {
  buses: Record<string, BusView>;
  /** etaKey(trip, stop) → ETA, for the stops this connection asked for */
  etas: Record<string, StopEta>;
  /** per trip, stop events seen this session (the vertical timeline, Stage 5) */
  stops: Record<string, StopMark[]>;
  connId: string | null;
  /** serverTime − local time, ms: ages are shown on the gateway's clock, not the phone's */
  clockOffsetMs: number;
}

export const initialFleet = (): FleetState => ({
  buses: {},
  etas: {},
  stops: {},
  connId: null,
  clockOffsetMs: 0,
});

const t = (iso: string) => Date.parse(iso);

export function applyEvent(state: FleetState, e: SseEvent, localNow: number): FleetState {
  switch (e.type) {
    case "stream.ready":
      return {
        ...state,
        connId: e.data.connId,
        clockOffsetMs: t(e.data.serverTime) - localNow,
        // per-user frames are re-derived on every connect (invariant 9): start clean
        etas: {},
      };

    case "eta.update": {
      const d = e.data;
      const key = etaKey(d.tripId, d.stopId);
      if (d.withdrawn) {
        if (!(key in state.etas)) return state;
        const { [key]: _gone, ...rest } = state.etas;
        return { ...state, etas: rest };
      }
      const held = state.etas[key];
      if (held?.at && d.at && t(held.at) > t(d.at)) return state; // an older prediction
      return {
        ...state,
        etas: {
          ...state.etas,
          [key]: { p50: d.p50, p90: d.p90, confidence: d.confidence ?? null, at: d.at ?? null },
        },
      };
    }

    case "fleet.snapshot": {
      const buses: Record<string, BusView> = {};
      for (const b of e.data.buses) {
        if (b.state === "ENDED") continue;
        const held = state.buses[b.id];
        // the snapshot is authoritative for membership; a newer fix already held still wins
        buses[b.id] = held && t(held.ts) > t(b.ts) ? held : { ...b, stateSince: held?.stateSince };
      }
      return {
        ...state,
        buses,
        clockOffsetMs: e.data.serverTime ? t(e.data.serverTime) - localNow : state.clockOffsetMs,
      };
    }

    case "bus.position": {
      const d = e.data;
      const held = state.buses[d.id];
      if (held && t(held.ts) >= t(d.ts)) return state;
      const next: BusView = {
        ...(held ?? { state: "LIVE" as PresenceState, cadence: 5, tripId: null }),
        ...d,
        tripId: d.tripId ?? held?.tripId ?? null,
        routeId: d.routeId ?? held?.routeId ?? null,
        cadence: d.cadence ?? held?.cadence ?? 5,
        // a fix is live only if it is fresh on the gateway's clock: the first slice of a
        // reconnect flush can be the newest fix so far and still minutes old (invariant 2)
        state: presenceByAge(d.ts, d.cadence ?? held?.cadence ?? 5, localNow + state.clockOffsetMs),
        deadZone: null,
        reason: null,
        stateSince: held?.state === "LIVE" ? held.stateSince : localNow + state.clockOffsetMs,
      };
      return { ...state, buses: { ...state.buses, [d.id]: next } };
    }

    case "bus.status": {
      const d = e.data;
      const held = state.buses[d.id];
      if (!held) return state;
      if (t(d.lastSeenAt) < t(held.ts)) return state; // judged against an older fix: stale
      if (d.state === "ENDED") {
        const { [d.id]: _gone, ...rest } = state.buses;
        return { ...state, buses: rest, etas: dropTrip(state.etas, held.tripId) };
      }
      return {
        ...state,
        buses: {
          ...state.buses,
          [d.id]: {
            ...held,
            state: d.state,
            cadence: d.cadence,
            reason: d.reason ?? null,
            deadZone: d.deadZone ?? null,
            stateSince: d.at ? t(d.at) : localNow + state.clockOffsetMs,
          },
        },
        // a DARK bus has no ETA (the engine withdraws it too; this does not wait for that frame)
        etas: d.state === "DARK" ? dropTrip(state.etas, held.tripId) : state.etas,
      };
    }

    case "stop.reached": {
      const d = e.data;
      const list = state.stops[d.tripId] ?? [];
      const event = d.event ?? "arrived";
      if (list.some((m) => m.seq === d.seq && m.event === event)) return state;
      const mark: StopMark = {
        seq: d.seq,
        stopId: d.stopId,
        event,
        at: d.at ?? null,
        backfill: d.backfill ?? false,
      };
      return { ...state, stops: { ...state.stops, [d.tripId]: [...list, mark] } };
    }

    default:
      return state; // notification / ticket.update: Stage 6–7 consumers
  }
}

function dropTrip(etas: Record<string, StopEta>, tripId: string | null): Record<string, StopEta> {
  if (!tripId) return etas;
  const prefix = `${tripId}|`;
  if (!Object.keys(etas).some((k) => k.startsWith(prefix))) return etas;
  return Object.fromEntries(Object.entries(etas).filter(([k]) => !k.startsWith(prefix)));
}
