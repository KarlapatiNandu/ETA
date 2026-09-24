import { toLocal, type LatLng } from "./geometry.ts";

/**
 * Douglas–Peucker (survey cleanup, Stage 1). `epsilonM` is the largest perpendicular
 * deviation, in metres, a dropped vertex may have had from the simplified line.
 *
 * Iterative with an explicit stack: a 45-minute 1 Hz survey is ~2,700 points, and a
 * recursive version on a pathological (spiral) trace would recurse that deep.
 */
export function simplifyTrace<T extends LatLng>(points: readonly T[], epsilonM: number): T[] {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const a = points[first]!;
    const b = toLocal(a, points[last]!);
    const len = Math.hypot(b.x, b.y);
    let maxD = -1;
    let idx = -1;
    for (let i = first + 1; i < last; i++) {
      const p = toLocal(a, points[i]!);
      // distance to the segment (not the infinite line), so a trace that doubles back is kept
      let d: number;
      if (len === 0) d = Math.hypot(p.x, p.y);
      else {
        const t = Math.max(0, Math.min(1, (p.x * b.x + p.y * b.y) / (len * len)));
        d = Math.hypot(p.x - b.x * t, p.y - b.y * t);
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > epsilonM) {
      keep[idx] = 1;
      stack.push([first, idx], [idx, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}

/** Drop consecutive duplicate vertices (zero-length segments break projection maths). */
export function dedupe<T extends LatLng>(points: readonly T[], minGapM = 0.5): T[] {
  const out: T[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(p);
      continue;
    }
    const v = toLocal(prev, p);
    if (Math.hypot(v.x, v.y) > minGapM) out.push(p);
  }
  return out;
}
