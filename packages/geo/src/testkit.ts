import {
  buildRoute,
  fromLocal,
  offsetPoint,
  pointAtOffset,
  type LatLng,
  type Route,
} from "./geometry.ts";
import type { Fix } from "./trip.ts";

/**
 * Test-only helpers: routes drawn in a local metre frame and a seeded PRNG, so every
 * adversarial fixture is exact and reproducible. Not exported from the package index.
 */

export const ORIGIN: LatLng = { lat: 17.4, lng: 78.4 };

/** Lay out waypoints given in metres east/north of ORIGIN, densified to `spacing` m. */
export function routeFrom(waypoints: [number, number][], spacing = 25): Route {
  const pts: [number, number][] = [];
  for (let i = 0; i < waypoints.length - 1; i++) {
    const [x0, y0] = waypoints[i]!;
    const [x1, y1] = waypoints[i + 1]!;
    const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0) / spacing));
    for (let k = 0; k < n; k++) pts.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  pts.push(waypoints[waypoints.length - 1]!);
  return buildRoute(pts.map(([x, y]) => fromLocal(ORIGIN, { x, y })));
}

export const at = (x: number, y: number): LatLng => fromLocal(ORIGIN, { x, y });

/** mulberry32 — tiny, seedable, good enough for noise. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

export const T0 = Date.UTC(2026, 8, 22, 2, 0, 0); // 07:30 IST

/** Fixes every `cadenceS` along [from, to] at constant speed, with σ = `noiseM` GPS noise. */
export function drive(
  route: Route,
  opts: {
    from?: number;
    to?: number;
    speedKmh?: number;
    cadenceS?: number;
    noiseM?: number;
    seed?: number;
    startAt?: number;
    reportSpeed?: boolean;
  } = {},
): Fix[] {
  const { from = 0, to = route.total, speedKmh = 30, cadenceS = 5, noiseM = 0 } = opts;
  const rng = prng(opts.seed ?? 1);
  const v = speedKmh / 3.6;
  const out: Fix[] = [];
  const start = opts.startAt ?? T0;
  for (let t = 0; ; t += cadenceS) {
    const s = Math.min(to, from + v * t);
    let p = pointAtOffset(route, s);
    if (noiseM > 0) p = offsetPoint(p, Math.abs(gaussian(rng)) * noiseM, rng() * 360);
    out.push({
      at: start + t * 1000,
      ...p,
      speedKmh: opts.reportSpeed === false ? null : speedKmh,
    });
    if (s >= to) break;
  }
  return out;
}
