import {
  detectCrossings,
  initialCrossingState,
  resetCrossings,
  type CrossingState,
  type RouteStop,
  type StopEvent,
} from "./crossings.ts";
import type { Route } from "./geometry.ts";
import { enforceMonotonicProgress, ewma, type ProgressDecision } from "./progress.ts";
import { nearestOnRoute, SNAP, snapToRoute, type SnapResult } from "./snap.ts";

/**
 * Everything the engine remembers about one running trip between pings. Plain JSON, so it
 * round-trips through Redis and a replayed trace reproduces it exactly.
 */
export interface TripGeoState {
  /** last snapped segment: the forward-biased window hint (bus:{id}:snapidx) */
  lastIndex: number | null;
  /** accepted route offset, metres */
  s: number | null;
  /** epoch ms of the fix that produced `s` */
  sAt: number | null;
  /** epoch ms of the newest fix processed at all */
  lastFixAt: number | null;
  backwardRun: number;
  offRouteRun: number;
  /** v_live, km/h (bus:{id}:ewma) */
  ewmaKmh: number | null;
  crossing: CrossingState;
  /** set for one fix after a re-snap: ETAs are not published for that cycle (§5.3) */
  suppressEta: boolean;
}

export function initialTripState(): TripGeoState {
  return {
    lastIndex: null,
    s: null,
    sAt: null,
    lastFixAt: null,
    backwardRun: 0,
    offRouteRun: 0,
    ewmaKmh: null,
    crossing: initialCrossingState(),
    suppressEta: false,
  };
}

export interface Fix {
  /** recorded_at, epoch ms */
  at: number;
  lat: number;
  lng: number;
  speedKmh: number | null;
}

export interface TripStep {
  state: TripGeoState;
  /**
   * `stale` — the fix is not newer than one already processed (out-of-order or backfill
   * behind live). It must not move live state; it is still persisted.
   */
  status: SnapResult["status"] | "stale";
  decision: ProgressDecision | null;
  /** the offset to publish: null while off-route (never fabricate one, invariant 2) */
  s: number | null;
  /** observed speed for this fix (GPS, else derived from progress), km/h */
  speedKmh: number | null;
  distanceM: number | null;
  events: StopEvent[];
  resnapped: boolean;
  /** this fix is the one that crossed the OFF_ROUTE threshold */
  wentOffRoute: boolean;
}

/**
 * One fix through the whole ARCH §5.2–5.4 chain: snap → monotonic progress → EWMA speed →
 * stop crossings. Pure: same state + same fix ⇒ same result, so recorded traces replay
 * deterministically (tests/fixtures).
 */
export function stepTrip(
  prev: TripGeoState,
  fix: Fix,
  route: Route,
  stops: readonly RouteStop[],
): TripStep {
  const base = {
    decision: null,
    events: [] as StopEvent[],
    resnapped: false,
    wentOffRoute: false,
  };
  if (prev.lastFixAt !== null && fix.at <= prev.lastFixAt) {
    return {
      ...base,
      state: prev,
      status: "stale",
      s: prev.offRouteRun >= SNAP.OFF_ROUTE_SUSTAIN ? null : prev.s,
      speedKmh: fix.speedKmh,
      distanceM: null,
    };
  }

  const state: TripGeoState = { ...prev, lastFixAt: fix.at, suppressEta: false };
  const snap = snapToRoute(fix, route, prev.lastIndex, prev.offRouteRun);
  state.offRouteRun = snap.offRouteRun;

  if (snap.status !== "on_route") {
    if (fix.speedKmh !== null) state.ewmaKmh = ewma(prev.ewmaKmh, fix.speedKmh);
    return {
      ...base,
      state,
      status: snap.status,
      s: snap.status === "off_route" ? null : prev.s,
      speedKmh: fix.speedKmh,
      distanceM: snap.distance,
      wentOffRoute: snap.status === "off_route" && prev.offRouteRun < SNAP.OFF_ROUTE_SUSTAIN,
    };
  }

  const dtS = prev.sAt === null ? 0 : (fix.at - prev.sAt) / 1000;
  const prog = enforceMonotonicProgress(prev.s, snap.s, dtS, prev.backwardRun);
  state.backwardRun = prog.backwardRun;

  if (prog.decision === "resnap") {
    const global = nearestOnRoute(fix, route, null);
    state.s = global.s;
    state.sAt = fix.at;
    state.lastIndex = global.index;
    state.crossing = resetCrossings(stops, global.s);
    state.suppressEta = true;
    if (fix.speedKmh !== null) state.ewmaKmh = ewma(prev.ewmaKmh, fix.speedKmh);
    return {
      ...base,
      state,
      status: "on_route",
      decision: prog.decision,
      s: global.s,
      speedKmh: fix.speedKmh,
      distanceM: global.distance,
      resnapped: true,
    };
  }

  if (prog.decision !== "accept") {
    if (fix.speedKmh !== null) state.ewmaKmh = ewma(prev.ewmaKmh, fix.speedKmh);
    return {
      ...base,
      state,
      status: "on_route",
      decision: prog.decision,
      s: prev.s,
      speedKmh: fix.speedKmh,
      distanceM: snap.distance,
    };
  }

  let speed = fix.speedKmh;
  if (speed === null && prev.s !== null && dtS > 0) speed = ((prog.s - prev.s) / dtS) * 3.6;
  if (speed !== null) state.ewmaKmh = ewma(prev.ewmaKmh, speed);

  state.s = prog.s;
  state.sAt = fix.at;
  state.lastIndex = snap.index;
  const crossed = detectCrossings(prev.crossing, stops, {
    sPrev: prev.s,
    sNow: prog.s,
    prevAt: prev.sAt,
    at: fix.at,
    speedKmh: speed,
    distanceM: snap.distance,
  });
  state.crossing = crossed.state;
  return {
    ...base,
    state,
    status: "on_route",
    decision: prog.decision,
    s: prog.s,
    speedKmh: speed,
    distanceM: snap.distance,
    events: crossed.events,
  };
}
