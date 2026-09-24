import { haversine, projectPointOnSegment, type LatLng, type Route } from "./geometry.ts";
import type { Snap } from "./snap.ts";

/**
 * Pure halves of the trace → route pipeline (Stage 1). The OSRM call itself lives in the
 * engine; everything that decides *what* to send and *how to join* the answers lives here,
 * so it can be tested without a routing server.
 */

export const MATCH = {
  /**
   * OSRM /match rejects more than --max-matching-size coordinates (100 by default). 80 leaves
   * headroom; 15 of overlap gives each join a stretch both windows agree on.
   */
  CHUNK: 80,
  OVERLAP: 15,
} as const;

/** [start, end) index windows over `n` points, each ≤ size, consecutive ones sharing `overlap`. */
export function chunkWindows(
  n: number,
  size: number = MATCH.CHUNK,
  overlap: number = MATCH.OVERLAP,
): [number, number][] {
  if (overlap >= size) throw new RangeError("overlap must be smaller than the chunk size");
  if (n <= size) return n > 0 ? [[0, n]] : [];
  const out: [number, number][] = [];
  const step = size - overlap;
  for (let start = 0; ; start += step) {
    const end = Math.min(n, start + size);
    out.push([start, end]);
    if (end === n) break;
  }
  return out;
}

export interface MatchedChunk {
  /** index of the chunk's first input point in the whole trace */
  start: number;
  /** matched road geometry for this chunk, in travel order */
  geometry: LatLng[];
  /** per input point: where OSRM snapped it, or null if it could not be matched */
  tracepoints: (LatLng | null)[];
}

/** Nearest point on a polyline: segment index and projected point. */
function cutAt(line: readonly LatLng[], p: LatLng, preferLate: boolean) {
  let best = { i: 0, d: Infinity, point: line[0]! };
  for (let i = 0; i < line.length - 1; i++) {
    const proj = projectPointOnSegment(p, line[i]!, line[i + 1]!);
    if (proj.distance < best.d || (preferLate && proj.distance === best.d)) {
      best = { i, d: proj.distance, point: proj.point };
    }
  }
  return best;
}

/**
 * Join matched chunks into one polyline. For each pair, a join point is taken from the
 * middle of their overlap — a trace point both chunks matched — and each chunk is cut at its
 * own projection of it, so the overlap contributes its geometry exactly once.
 *
 * Returns the number of joins that had no common matched point (a survey gap): those chunks
 * are concatenated as-is and the admin editor should draw attention to the seam.
 */
export function stitchChunks(chunks: readonly MatchedChunk[]): { line: LatLng[]; gaps: number } {
  const usable = chunks.filter((c) => c.geometry.length >= 2);
  if (usable.length === 0) return { line: [], gaps: 0 };
  let line = usable[0]!.geometry.slice();
  let gaps = 0;
  for (let c = 1; c < usable.length; c++) {
    const prev = usable[c - 1]!;
    const next = usable[c]!;
    const lo = next.start;
    const hi = prev.start + prev.tracepoints.length; // overlap is [lo, hi)
    const mid = Math.floor((lo + hi) / 2);
    let join: LatLng | null = null;
    // search outwards from the middle of the overlap for a point both chunks matched
    for (let off = 0; off < hi - lo && !join; off++) {
      for (const j of [mid + off, mid - off - 1]) {
        if (j < lo || j >= hi) continue;
        const a = prev.tracepoints[j - prev.start];
        if (a && next.tracepoints[j - next.start]) {
          join = a;
          break;
        }
      }
    }
    if (!join) {
      gaps++;
      line = line.concat(next.geometry);
      continue;
    }
    const a = cutAt(line, join, true);
    const b = cutAt(next.geometry, join, false);
    line = [...line.slice(0, a.i + 1), a.point, ...next.geometry.slice(b.i + 1)];
  }
  return { line: dropDuplicates(line), gaps };
}

function dropDuplicates(line: LatLng[]): LatLng[] {
  return line.filter((p, i) => i === 0 || haversine(line[i - 1]!, p) > 0.05);
}

/**
 * Every separate pass of the route near `p`: runs of consecutive segments within `maxM`,
 * each reduced to its closest projection. A circular route that serves a stop outbound and
 * again inbound has two passes near that stop.
 */
export function findPasses(route: Route, p: LatLng, maxM = 150): Snap[] {
  const passes: Snap[] = [];
  let current: Snap | null = null;
  for (let i = 0; i < route.coords.length - 1; i++) {
    const proj = projectPointOnSegment(p, route.coords[i]!, route.coords[i + 1]!);
    if (proj.distance > maxM) {
      if (current) passes.push(current);
      current = null;
      continue;
    }
    const snap = {
      index: i,
      s: route.cum[i]! + proj.along,
      distance: proj.distance,
      point: proj.point,
    };
    if (!current || snap.distance < current.distance) current = snap;
  }
  if (current) passes.push(current);
  return passes;
}

export interface StopPlacement extends Snap {
  /** true if the stop had to be placed at or before the previous stop's offset */
  outOfOrder: boolean;
}

/**
 * D_k for each stop, in the given order (publish time, SCHEMA §3 route_stops). With `near`
 * (the offset where the admin clicked) the pass closest to it is used; otherwise the first
 * pass beyond the previous stop — which is what places a repeated stop on its second pass.
 */
export function projectStops(
  route: Route,
  stops: readonly { point: LatLng; near?: number | null }[],
): StopPlacement[] {
  const out: StopPlacement[] = [];
  let prevS = -Infinity;
  for (const stop of stops) {
    const passes = findPasses(route, stop.point);
    let pick: Snap | undefined;
    if (stop.near != null && passes.length) {
      pick = passes.reduce((a, b) =>
        Math.abs(b.s - stop.near!) < Math.abs(a.s - stop.near!) ? b : a,
      );
    } else {
      pick = passes.find((p) => p.s > prevS + 1);
    }
    if (!pick) {
      // no pass within reach: fall back to the nearest point anywhere, and let the caller warn
      pick = findPasses(route, stop.point, Infinity)[0]!;
    }
    out.push({ ...pick, outOfOrder: pick.s <= prevS });
    prevS = Math.max(prevS, pick.s);
  }
  return out;
}
