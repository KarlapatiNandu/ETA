/** ARCH §5.4. Change the document in the same commit as any of these numbers. */
export const CROSSING = {
  /** below this the bus is stopped at the stop */
  ARRIVE_SPEED_KMH: 8,
  /** a slow fix this close in time to the crossing confirms the arrival */
  ARRIVE_WINDOW_MS: 60_000,
  /** this far past the stop without stopping: it drove straight through, still an arrival */
  DRIVE_THROUGH_M: 100,
  DEPART_SPEED_KMH: 12,
  DEPART_PAST_M: 50,
  /** this far past with no confirmed arrival: the stop was skipped */
  SKIP_PAST_M: 300,
  /** the bus must have come this close to the stop, or it was a detour, not an arrival */
  MAX_APPROACH_M: 150,
} as const;

export interface RouteStop {
  /** route_stops.seq */
  seq: number;
  stopId: string;
  /** D_k: route_stops.cumulative_dist_m */
  offset: number;
}

export type StopEventKind = "arrived" | "departed" | "skipped";

export interface StopEvent {
  kind: StopEventKind;
  /** index into the route's stop list */
  index: number;
  seq: number;
  stopId: string;
  /** epoch ms; arrivals are interpolated to the moment the offset crossed D_k */
  at: number;
}

export interface CrossingState {
  /** expectedNextStopIndex — only ever advances, except on a re-snap */
  next: number;
  /** crossed D_k, arrival not yet confirmed */
  candidate: { index: number; at: number } | null;
  /** arrival confirmed, departure not yet seen */
  departing: number | null;
  /** epoch ms of the most recent fix slower than ARRIVE_SPEED_KMH */
  lastSlowAt: number | null;
}

export function initialCrossingState(): CrossingState {
  return { next: 0, candidate: null, departing: null, lastSlowAt: null };
}

export interface CrossingFix {
  /** accepted offset before this fix; null for the first fix of a trip */
  sPrev: number | null;
  sNow: number;
  prevAt: number | null;
  at: number;
  speedKmh: number | null;
  /** perpendicular distance of this fix from the route */
  distanceM: number;
}

/**
 * ARCH §5.4 — arrivals by route-offset crossing, not by circles.
 *
 * A circular 80 m geofence misses a stop about half the time at 60 km/h with a 5 s cadence
 * (pings 83 m apart). Crossing D_k between two offsets cannot be missed.
 *
 * Sequence is enforced: only `state.next` can arrive. The `skipped` rule is what keeps that
 * from freezing the trip — a stop the bus is decisively past (D_k + 300 m) without a
 * confirmed arrival is written off and the sequence moves on, so one detour, one empty stop
 * the driver ignored, or one dead zone spanning a stop cannot block every stop after it.
 *
 * The first fix of a trip is treated as coming from -∞: stops just behind it confirm as
 * the origin, stops well behind it (a mid-route start) are skipped.
 */
export function detectCrossings(
  state: CrossingState,
  stops: readonly RouteStop[],
  fix: CrossingFix,
): { state: CrossingState; events: StopEvent[] } {
  const st: CrossingState = { ...state, candidate: state.candidate && { ...state.candidate } };
  const events: StopEvent[] = [];
  const emit = (kind: StopEventKind, index: number, at: number) => {
    const stop = stops[index]!;
    events.push({ kind, index, seq: stop.seq, stopId: stop.stopId, at });
  };
  const { sNow, at } = fix;
  if (fix.speedKmh !== null && fix.speedKmh < CROSSING.ARRIVE_SPEED_KMH) st.lastSlowAt = at;

  const slowNear = (t: number) =>
    st.lastSlowAt !== null && Math.abs(st.lastSlowAt - t) <= CROSSING.ARRIVE_WINDOW_MS;

  const confirm = (index: number, arrivedAt: number) => {
    // a stop that never saw its departure (stops closer together than the departure rule
    // can resolve) is departed by the next arrival — the bus cannot be at both
    if (st.departing !== null) emit("departed", st.departing, arrivedAt);
    emit("arrived", index, arrivedAt);
    st.departing = index;
    st.candidate = null;
    st.next = index + 1;
  };

  const departed = () => {
    if (st.departing === null) return;
    const d = stops[st.departing]!.offset;
    if (
      fix.speedKmh !== null &&
      fix.speedKmh > CROSSING.DEPART_SPEED_KMH &&
      sNow > d + CROSSING.DEPART_PAST_M
    ) {
      emit("departed", st.departing, at);
      st.departing = null;
    }
  };

  departed();

  if (st.candidate) {
    const d = stops[st.candidate.index]!.offset;
    if (slowNear(st.candidate.at) || sNow >= d + CROSSING.DRIVE_THROUGH_M) {
      confirm(st.candidate.index, st.candidate.at);
      departed();
    }
  }

  while (st.candidate === null && st.next < stops.length) {
    const k = st.next;
    const d = stops[k]!.offset;
    if (sNow > d + CROSSING.SKIP_PAST_M) {
      emit("skipped", k, at);
      st.next = k + 1;
      continue;
    }
    const sPrev = fix.sPrev ?? -Infinity;
    if (!(sPrev < d && d <= sNow)) break;

    // closest the bus came to the stop across the two fixes: along-route gap and perpendicular
    const along = Math.min(d - sPrev, sNow - d);
    if (Math.hypot(along, fix.distanceM) >= CROSSING.MAX_APPROACH_M) break; // skip rule decides later

    const crossedAt =
      fix.sPrev === null || fix.prevAt === null || sNow === fix.sPrev
        ? at
        : Math.round(fix.prevAt + ((d - fix.sPrev) / (sNow - fix.sPrev)) * (at - fix.prevAt));
    st.candidate = { index: k, at: crossedAt };
    if (slowNear(crossedAt) || sNow >= d + CROSSING.DRIVE_THROUGH_M) {
      confirm(k, crossedAt);
      departed();
    }
  }
  return { state: st, events };
}

/**
 * After a global re-snap (§5.3 recovery) the sequence resets to the stop implied by the new
 * offset. Stops already recorded may be recorded again; `UNIQUE (trip_id, seq, event)` on
 * trip_stop_events is the backstop that makes that harmless.
 */
export function resetCrossings(stops: readonly RouteStop[], s: number): CrossingState {
  let next = stops.findIndex((st) => st.offset > s);
  if (next === -1) next = stops.length;
  return { next, candidate: null, departing: null, lastSlowAt: null };
}

/**
 * Explicit trip end. A stop crossed but not yet confirmed is resolved as arrived — the bus
 * that ends its trip there did stop — because a terminal stop at the very end of the route
 * can never reach the DRIVE_THROUGH margin. Stops never reached stay unrecorded: the trip
 * ended before them, which is different from passing them.
 */
export function finishCrossings(
  state: CrossingState,
  stops: readonly RouteStop[],
  at: number,
): { state: CrossingState; events: StopEvent[] } {
  const events: StopEvent[] = [];
  const st: CrossingState = { ...state, candidate: null };
  const emit = (kind: StopEventKind, index: number, when: number) => {
    const stop = stops[index]!;
    events.push({ kind, index, seq: stop.seq, stopId: stop.stopId, at: when });
  };
  if (state.candidate) {
    if (st.departing !== null) emit("departed", st.departing, state.candidate.at);
    emit("arrived", state.candidate.index, state.candidate.at);
    st.departing = state.candidate.index;
    st.next = state.candidate.index + 1;
  }
  if (st.departing !== null) {
    emit("departed", st.departing, at);
    st.departing = null;
  }
  return { state: st, events };
}

/** Highest stop index reached (trip:{id}:seq); -1 before the first stop. */
export function reachedIndex(state: CrossingState): number {
  return state.next - 1;
}
