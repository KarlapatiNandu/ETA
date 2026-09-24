import { pointAtOffset, type LatLng, type Route } from "@busmitra/geo";

/**
 * Client-side dead reckoning (ARCH §4): between fixes the marker advances along the route at
 * the last reported speed, and eases to the true position when the next fix lands — the bus
 * glides instead of teleporting.
 *
 * What it will not do (invariant 2 — never fabricate a position):
 *  - extrapolate a bus that is not LIVE: DEGRADED and DARK are drawn at the last true fix;
 *  - extrapolate further than MAX_AHEAD cadences past a fix — beyond that the bus is late,
 *    and the presence sweeper is about to say so;
 *  - run past the end of the route.
 */

export const EASE_MS = 1000;
/** at most this many cadences of extrapolation past the last fix */
export const MAX_AHEAD_CADENCES = 2;

export interface Track {
  /** true offset of the last fix, metres; null off-route */
  s: number | null;
  lat: number;
  lng: number;
  /** fix time, server clock ms */
  at: number;
  /** m/s */
  v: number;
  cadenceS: number;
  live: boolean;
  /** where the marker was drawn when this fix arrived, and when: the easing start */
  fromS: number | null;
  fromPos: LatLng;
  easeStart: number;
}

const easeOut = (k: number) => 1 - (1 - k) ** 3;

/** Where the fix says the bus is at `now`, before easing. */
export function projectedS(tr: Track, now: number, total: number): number | null {
  if (tr.s === null) return null;
  if (!tr.live || tr.v <= 0) return tr.s;
  const ahead = Math.min(Math.max(0, now - tr.at), MAX_AHEAD_CADENCES * tr.cadenceS * 1000);
  return Math.min(total, tr.s + (tr.v * ahead) / 1000);
}

/** The offset (or, off-route, the point) to draw at `now`. */
export function displayAt(
  tr: Track,
  now: number,
  route: Route | null,
): { s: number | null; pos: LatLng } {
  const k = Math.min(1, Math.max(0, (now - tr.easeStart) / EASE_MS));
  const e = easeOut(k);
  if (route && tr.s !== null) {
    const target = projectedS(tr, now, route.total)!;
    const s = tr.fromS === null ? target : tr.fromS + (target - tr.fromS) * e;
    return { s, pos: pointAtOffset(route, s) };
  }
  // off-route, or no geometry: ease straight to the reported point, never guess ahead
  return {
    s: null,
    pos: {
      lat: tr.fromPos.lat + (tr.lat - tr.fromPos.lat) * e,
      lng: tr.fromPos.lng + (tr.lng - tr.fromPos.lng) * e,
    },
  };
}

/** A new fix (or state) arrives: start easing from wherever the marker is drawn right now. */
export function retarget(
  prev: Track | null,
  fix: {
    s: number | null;
    lat: number;
    lng: number;
    at: number;
    kmh: number | null;
    cadenceS: number;
    live: boolean;
  },
  now: number,
  route: Route | null,
): Track {
  const drawn = prev ? displayAt(prev, now, route) : null;
  const sameGeometry = drawn?.s !== null && drawn?.s !== undefined && fix.s !== null;
  return {
    s: fix.s,
    lat: fix.lat,
    lng: fix.lng,
    at: fix.at,
    v: Math.max(0, (fix.kmh ?? 0) / 3.6),
    cadenceS: fix.cadenceS,
    live: fix.live,
    fromS: sameGeometry ? drawn!.s : null,
    fromPos: drawn?.pos ?? { lat: fix.lat, lng: fix.lng },
    easeStart: prev ? now : now - EASE_MS, // the very first fix is drawn where it is
  };
}
