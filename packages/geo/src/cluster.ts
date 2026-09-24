import { fromLocal, toLocal, type LatLng } from "./geometry.ts";

/**
 * Dead-zone learning maths (BUILD_PLAN Stage 8, ARCH §5.7): DBSCAN over outage entry points,
 * then a buffered convex hull per cluster. Pure and deterministic like the rest of the package —
 * the same outages in the same order give the same clusters and the same polygon, so the
 * nightly job can be replayed against simulator-injected zones.
 */

export const NOISE = -1;

export interface DbscanResult {
  /** cluster index per input point, in input order; NOISE (-1) for noise */
  labels: number[];
  /** number of clusters (labels run 0..count-1) */
  count: number;
  /** whether each point is a core point (≥ minPts neighbours within ε, itself included) */
  core: boolean[];
}

/**
 * DBSCAN (Ester et al. 1996) with great-circle-accurate distances in a local metric frame.
 * Neighbour search uses an ε-sized grid, so a year of outages (thousands of points) is a
 * linear pass rather than n².
 *
 * `minPts` counts the point itself, as in the original paper and in PostGIS
 * `ST_ClusterDBSCAN`. Border points join the first cluster that reaches them, in input order.
 */
export function dbscan(points: readonly LatLng[], epsM: number, minPts: number): DbscanResult {
  const n = points.length;
  const labels = new Array<number>(n).fill(NOISE);
  const core = new Array<boolean>(n).fill(false);
  if (n === 0) return { labels, count: 0, core };

  const origin = centroid(points);
  const xy = points.map((p) => toLocal(origin, p));
  const cell = (v: number) => Math.floor(v / epsM);
  const grid = new Map<string, number[]>();
  xy.forEach((p, i) => {
    const key = `${cell(p.x)}:${cell(p.y)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(i);
    else grid.set(key, [i]);
  });
  const eps2 = epsM * epsM;
  const neighbours = (i: number): number[] => {
    const p = xy[i]!;
    const cx = cell(p.x);
    const cy = cell(p.y);
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const j of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
          const q = xy[j]!;
          if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 <= eps2) out.push(j);
        }
    return out.sort((a, b) => a - b); // input order, for determinism
  };

  const visited = new Array<boolean>(n).fill(false);
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue;
    visited[i] = true;
    const seeds = neighbours(i);
    if (seeds.length < minPts) continue; // noise for now; may become a border point later
    core[i] = true;
    const c = count++;
    labels[i] = c;
    const queue = [...seeds];
    for (let k = 0; k < queue.length; k++) {
      const j = queue[k]!;
      if (labels[j] === NOISE) labels[j] = c;
      if (visited[j]) continue;
      visited[j] = true;
      const nj = neighbours(j);
      if (nj.length >= minPts) {
        core[j] = true;
        for (const m of nj) if (!visited[m] || labels[m] === NOISE) queue.push(m);
      }
    }
  }
  return { labels, count, core };
}

export function centroid(points: readonly LatLng[]): LatLng {
  let lat = 0;
  let lng = 0;
  for (const p of points) {
    lat += p.lat;
    lng += p.lng;
  }
  return { lat: lat / points.length, lng: lng / points.length };
}

type XY = { x: number; y: number };

const cross = (o: XY, a: XY, b: XY) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Andrew's monotone chain: the hull counter-clockwise, no repeated closing point. */
export function convexHullXY(input: readonly XY[]): XY[] {
  const pts = [...input].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const lower: XY[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: XY[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * The convex hull of `points` grown by `bufferM` in every direction (the Minkowski sum of the
 * hull with a disc), as a closed ring — first point repeated last — counter-clockwise, ready for
 * a WKT POLYGON. A single point becomes a disc and two points a capsule, so a tight cluster still
 * yields a real area.
 *
 * The disc is approximated by `segments` vertices *circumscribing* the circle, so the polygon
 * always contains the true buffer and never cuts a corner off it.
 */
export function bufferedHull(points: readonly LatLng[], bufferM: number, segments = 16): LatLng[] {
  if (points.length === 0) return [];
  const origin = centroid(points);
  const hull = convexHullXY(points.map((p) => toLocal(origin, p)));
  const r = bufferM / Math.cos(Math.PI / segments);
  const grown: XY[] = [];
  for (const v of hull)
    for (let k = 0; k < segments; k++) {
      const a = (2 * Math.PI * k) / segments;
      grown.push({ x: v.x + r * Math.cos(a), y: v.y + r * Math.sin(a) });
    }
  const ring = convexHullXY(grown).map((p) => fromLocal(origin, p));
  ring.push(ring[0]!);
  return ring;
}

/** Ray-casting point-in-polygon on a closed ring, in a local frame (fine at dead-zone scale). */
export function ringContains(ring: readonly LatLng[], p: LatLng): boolean {
  if (ring.length < 4) return false;
  const q = toLocal(p, p);
  const pts = ring.map((v) => toLocal(p, v));
  let inside = false;
  for (let i = 0, j = pts.length - 2; i < pts.length - 1; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    if (a.y > q.y !== b.y > q.y && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x)
      inside = !inside;
  }
  return inside;
}

/** Nearest-rank percentile of a non-empty list (p in 0..100). */
export function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}
