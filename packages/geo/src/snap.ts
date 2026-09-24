import { projectPointOnSegment, type LatLng, type Route } from "./geometry.ts";

/** ARCH §5.2. Change the document in the same commit as any of these numbers. */
export const SNAP = {
  /** segments searched behind the last snapped vertex */
  WINDOW_BACK: 20,
  /** segments searched ahead of it */
  WINDOW_FORWARD: 80,
  /** perpendicular distance beyond which a fix is not on the route */
  OFF_ROUTE_M: 75,
  /** consecutive far fixes before the bus is declared off-route rather than noisy */
  OFF_ROUTE_SUSTAIN: 3,
} as const;

export interface Snap {
  /** index of the segment [index, index+1] the fix projects onto */
  index: number;
  /** route offset of the projection, metres */
  s: number;
  /** perpendicular distance from the fix to the route, metres */
  distance: number;
  point: LatLng;
}

/** Nearest projection onto segments [from, to] inclusive. */
function nearest(p: LatLng, route: Route, from: number, to: number): Snap {
  let best: Snap | null = null;
  for (let i = from; i <= to; i++) {
    const proj = projectPointOnSegment(p, route.coords[i]!, route.coords[i + 1]!);
    // strict < keeps the earliest segment on ties, so a stop on a vertex belongs to the
    // segment that reaches it, not the one that leaves it
    if (!best || proj.distance < best.distance) {
      best = {
        index: i,
        s: route.cum[i]! + proj.along,
        distance: proj.distance,
        point: proj.point,
      };
    }
  }
  return best!;
}

/**
 * Nearest point on the route to `p`.
 *
 * With a `lastIndex` hint the search is the forward-biased window [last-20, last+80]. That
 * makes the common case O(100) instead of O(N) and — more importantly — keeps a bus on a
 * route that loops back near itself from snapping onto the other pass.
 *
 * If the window finds nothing within OFF_ROUTE_M the search widens *forwards only* to the
 * end of the route: after a long dead zone the bus may be more than 80 vertices on, but it
 * is never on the earlier pass. Only a null hint searches the whole route.
 */
export function nearestOnRoute(p: LatLng, route: Route, lastIndex?: number | null): Snap {
  const last = route.coords.length - 2;
  if (lastIndex == null) return nearest(p, route, 0, last);
  const from = Math.max(0, Math.min(last, lastIndex - SNAP.WINDOW_BACK));
  const windowed = nearest(p, route, from, Math.min(last, lastIndex + SNAP.WINDOW_FORWARD));
  if (windowed.distance <= SNAP.OFF_ROUTE_M || lastIndex + SNAP.WINDOW_FORWARD >= last) {
    return windowed;
  }
  const ahead = nearest(p, route, from, last);
  return ahead.distance < windowed.distance ? ahead : windowed;
}

export type SnapStatus =
  /** within OFF_ROUTE_M: `s` is trustworthy */
  | "on_route"
  /** far, but not for long enough to mean anything: hold the previous offset */
  | "noise"
  /** far for OFF_ROUTE_SUSTAIN fixes running: stop trusting the offset (emit OFF_ROUTE) */
  | "off_route";

export interface SnapResult extends Snap {
  status: SnapStatus;
  /** consecutive far fixes including this one; feed back in on the next call */
  offRouteRun: number;
}

/**
 * ARCH §5.2 `snap(ping, route, lastIndex)`.
 *
 * Once a bus is off-route the hint is useless (it may rejoin anywhere), so callers pass
 * `offRouteRun` back in and the search goes global until a fix lands on the route again.
 */
export function snapToRoute(
  p: LatLng,
  route: Route,
  lastIndex: number | null,
  offRouteRun = 0,
): SnapResult {
  const hint = offRouteRun >= SNAP.OFF_ROUTE_SUSTAIN ? null : lastIndex;
  const snap = nearestOnRoute(p, route, hint);
  if (snap.distance <= SNAP.OFF_ROUTE_M) return { ...snap, status: "on_route", offRouteRun: 0 };
  const run = offRouteRun + 1;
  return {
    ...snap,
    status: run >= SNAP.OFF_ROUTE_SUSTAIN ? "off_route" : "noise",
    offRouteRun: run,
  };
}
