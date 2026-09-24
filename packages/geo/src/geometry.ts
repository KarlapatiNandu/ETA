/**
 * Planar-enough geometry on the sphere (ARCH §5.1).
 *
 * Distances use the PostGIS sphere (`ST_Distance(a, b, use_spheroid => false)`), not the
 * WGS84 spheroid. The routes trigger computes `cumulative_dist_m` with the same radius, so a
 * stop offset computed here and a route offset computed in the database agree to the
 * millimetre. Mixing the two models drifts by ~0.3%, which is 75 m over a 25 km route — most
 * of the 100 m arrival-confirmation margin in §5.4.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

/** PostGIS's sphere radius for geography distances with use_spheroid = false. */
export const EARTH_RADIUS_M = 6371008.7714;

const RAD = Math.PI / 180;

export function haversine(a: LatLng, b: LatLng): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north, 0..360. */
export function bearing(a: LatLng, b: LatLng): number {
  const φ1 = a.lat * RAD;
  const φ2 = b.lat * RAD;
  const Δλ = (b.lng - a.lng) * RAD;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) / RAD) % 360) + 360) % 360;
}

/**
 * Local equirectangular frame centred on `origin`, in metres. Accurate to well under 0.1%
 * across a few kilometres, which is far larger than any route segment.
 */
export function toLocal(origin: LatLng, p: LatLng): { x: number; y: number } {
  const k = Math.cos(origin.lat * RAD);
  return {
    x: (p.lng - origin.lng) * RAD * EARTH_RADIUS_M * k,
    y: (p.lat - origin.lat) * RAD * EARTH_RADIUS_M,
  };
}

export function fromLocal(origin: LatLng, v: { x: number; y: number }): LatLng {
  const k = Math.cos(origin.lat * RAD);
  return {
    lat: origin.lat + v.y / (EARTH_RADIUS_M * RAD),
    lng: origin.lng + v.x / (EARTH_RADIUS_M * RAD * k),
  };
}

/** Move `distanceM` from `p` along `bearingDeg`. Used by the simulator to inject noise. */
export function offsetPoint(p: LatLng, distanceM: number, bearingDeg: number): LatLng {
  const b = bearingDeg * RAD;
  return fromLocal(p, { x: distanceM * Math.sin(b), y: distanceM * Math.cos(b) });
}

export interface SegmentProjection {
  /** 0..1 position of the foot of the perpendicular, clamped to the segment. */
  t: number;
  /** metres from `a` to the projected point, along the segment */
  along: number;
  /** perpendicular (or end-point) distance from p to the segment, metres */
  distance: number;
  point: LatLng;
}

export function projectPointOnSegment(p: LatLng, a: LatLng, b: LatLng): SegmentProjection {
  const vb = toLocal(a, b);
  const vp = toLocal(a, p);
  const len2 = vb.x * vb.x + vb.y * vb.y;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (vp.x * vb.x + vp.y * vb.y) / len2));
  const foot = { x: vb.x * t, y: vb.y * t };
  const point = fromLocal(a, foot);
  // Along-distance is scaled to the haversine segment length so that s = D[i] + along never
  // overshoots D[i+1] because the local frame and the sphere disagree in the 5th digit.
  const segLen = haversine(a, b);
  return {
    t,
    along: segLen * t,
    distance: Math.hypot(vp.x - foot.x, vp.y - foot.y),
    point,
  };
}

/** Prefix sums of segment lengths: D[0] = 0, D[i] = D[i-1] + |v[i-1] v[i]| (ARCH §5.1). */
export function buildCumulativeDistances(coords: readonly LatLng[]): number[] {
  const out = new Array<number>(coords.length);
  if (coords.length === 0) return out;
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    out[i] = out[i - 1]! + haversine(coords[i - 1]!, coords[i]!);
  }
  return out;
}

/** A route reduced to what every downstream algorithm needs: vertices and their offsets. */
export interface Route {
  coords: readonly LatLng[];
  /** D[]: cumulative distance to each vertex, metres */
  cum: readonly number[];
  total: number;
}

export function buildRoute(coords: readonly LatLng[], cum?: readonly number[]): Route {
  if (coords.length < 2) throw new RangeError("a route needs at least two vertices");
  const d = cum ?? buildCumulativeDistances(coords);
  if (d.length !== coords.length) throw new RangeError("cum[] must have one entry per vertex");
  return { coords, cum: d, total: d[d.length - 1]! };
}

/** Index i of the segment [i, i+1] containing offset s (binary search over D[]). */
export function segmentAt(route: Route, s: number): number {
  const { cum } = route;
  if (s <= 0) return 0;
  if (s >= route.total) return cum.length - 2;
  let lo = 0;
  let hi = cum.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! <= s) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The point at route offset s (clamped to the route). */
export function pointAtOffset(route: Route, s: number): LatLng {
  const i = segmentAt(route, s);
  const a = route.coords[i]!;
  const b = route.coords[i + 1]!;
  const len = route.cum[i + 1]! - route.cum[i]!;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, (s - route.cum[i]!) / len));
  const vb = toLocal(a, b);
  return fromLocal(a, { x: vb.x * t, y: vb.y * t });
}

/** Direction of travel at offset s, degrees. */
export function headingAtOffset(route: Route, s: number): number {
  const i = segmentAt(route, s);
  return bearing(route.coords[i]!, route.coords[i + 1]!);
}
