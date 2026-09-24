import { CADENCE, initialCadence, nextCadence, pingDue, type Ping } from "@busmitra/contracts";
import { fromLocal, headingAtOffset, pointAtOffset, toLocal, type Route } from "@busmitra/geo";

/**
 * The synthetic bus (BUILD_PLAN Stage 1 "Simulator"). Deterministic: same route, options and
 * seed ⇒ byte-identical output, so a failure seen once can be replayed exactly.
 *
 * It models the *tracker*, not just the bus: fixes are sampled at the shared cadence rule
 * (5 s moving / 15 s stationary), queued, and sent in 5 s batches; inside a dead zone nothing
 * is sent and everything is flushed on reconnect with its original recorded_at — exactly
 * what the driver PWA does, so the gateway and engine see what they will see in the field.
 */

export function prng(seed: number): () => number {
  let a = seed >>> 0 || 1;
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

export interface SimOptions {
  seed: number;
  /** epoch ms the trip starts */
  t0: number;
  /** D_k of the route's stops; the bus dwells at each */
  stops: readonly number[];
  cruiseKmh?: number;
  /** GPS noise, σ per axis in metres (ARCH §5.3 assumes σ ≈ 8 m) */
  noiseM?: number;
  /** route-offset ranges with no network: a place (a flyover underpass) */
  deadZones?: readonly [number, number][];
  /** time ranges (ms after t0) with no network: airplane mode, a phone in a pocket */
  offline?: readonly [number, number][];
  /** detours: from offset `atS`, `durationS` seconds displaced `offsetM` sideways */
  offRoute?: readonly { atS: number; durationS: number; offsetM: number }[];
  /** unplanned stops (traffic, signals) per km */
  stallsPerKm?: number;
  dwellS?: readonly [number, number];
  /** probability a batch is sent twice (a retry after a lost ack) */
  dupRate?: number;
  /** probability two consecutive batches arrive in the wrong order */
  reorderRate?: number;
}

export type SimPing = Required<Pick<Ping, "recorded_at" | "lat" | "lng">> & {
  speed_kmh: number;
  heading_deg: number;
  accuracy_m: number;
};

export interface SimBatch {
  /** epoch ms the tracker sends it */
  sendAt: number;
  cadenceS: number;
  pings: SimPing[];
  kind: "live" | "flush" | "duplicate";
}

export interface SimTrip {
  batches: SimBatch[];
  /** every distinct fix, in recorded order — what `positions` must end up holding */
  pings: SimPing[];
  endAt: number;
}

const ACCEL = 1.0; // m/s²
const BRAKE = 1.2;

function inRanges(v: number, ranges: readonly [number, number][] | undefined): boolean {
  return !!ranges?.some(([a, b]) => v >= a && v < b);
}

export function simulateTrip(route: Route, opts: SimOptions): SimTrip {
  const rng = prng(opts.seed);
  const cruise = (opts.cruiseKmh ?? 24 + rng() * 14) / 3.6;
  const noise = opts.noiseM ?? 8;
  const [dwellMin, dwellMax] = opts.dwellS ?? [15, 45];
  const stops = [...opts.stops].sort((a, b) => a - b);

  let s = 0;
  let v = 0;
  let t = opts.t0;
  let nextStop = 0;
  let holdUntil: number | null = null;
  let wander = 0;
  let cadence = initialCadence();
  let lastFix: number | null = null;
  let lastFixCadence: number | undefined;
  let nextBatch = opts.t0 + CADENCE.BATCH_EVERY_MS;
  let wasOffline = false;
  const pending: SimPing[] = [];
  const pings: SimPing[] = [];
  const batches: SimBatch[] = [];

  const fix = (): SimPing => {
    let p = pointAtOffset(route, s);
    const heading = headingAtOffset(route, s);
    // a detour covers the ground the bus would have driven in `durationS` at cruise speed
    const active = opts.offRoute?.find(
      (d) => s >= d.atS && s <= d.atS + cruise * d.durationS && d.offsetM > 0,
    );
    if (active) {
      // sideways, perpendicular to the direction of travel
      const rad = ((heading + 90) * Math.PI) / 180;
      p = fromLocal(p, { x: Math.sin(rad) * active.offsetM, y: Math.cos(rad) * active.offsetM });
    }
    const jittered = fromLocal(p, { x: gaussian(rng) * noise, y: gaussian(rng) * noise });
    const local = toLocal(p, jittered);
    return {
      recorded_at: new Date(t).toISOString(),
      lat: Math.round(jittered.lat * 1e7) / 1e7,
      lng: Math.round(jittered.lng * 1e7) / 1e7,
      speed_kmh: Math.max(0, Math.round((v * 3.6 + gaussian(rng) * 0.8) * 10) / 10),
      heading_deg: Math.round((heading + gaussian(rng) * 3 + 360) % 360) % 360,
      accuracy_m: Math.round(Math.max(3, noise + Math.hypot(local.x, local.y) * 0.3) * 10) / 10,
    };
  };

  const sendPending = (kind: SimBatch["kind"]) => {
    while (pending.length) {
      batches.push({
        sendAt: t,
        cadenceS: cadence.cadenceS,
        pings: pending.splice(0, CADENCE.MAX_BATCH),
        kind,
      });
    }
  };

  // one-second physics ticks, with the tracker sampling on top
  for (let guard = 0; guard < 6 * 3600; guard++) {
    if (holdUntil !== null) {
      v = 0;
      if (t >= holdUntil) holdUntil = null;
    } else {
      wander = Math.max(-0.25, Math.min(0.25, wander + gaussian(rng) * 0.03));
      let target = cruise * (1 + wander);
      const toStop = nextStop < stops.length ? stops[nextStop]! - s : Infinity;
      target = Math.min(target, Math.sqrt(2 * BRAKE * Math.max(0, toStop)));
      v = target > v ? Math.min(target, v + ACCEL) : Math.max(target, v - BRAKE * 1.5);
      if (toStop <= 2) {
        s = stops[nextStop]!;
        v = 0;
        holdUntil = t + Math.round((dwellMin + rng() * (dwellMax - dwellMin)) * 1000);
        nextStop++;
      } else if (rng() < (opts.stallsPerKm ?? 0.3) * (v / 1000)) {
        holdUntil = t + Math.round((20 + rng() * 60) * 1000); // a signal, a jam
      }
    }
    s = Math.min(route.total, s + v);
    t += 1000;
    while (nextStop < stops.length && stops[nextStop]! < s - 5) nextStop++; // passed without stopping

    cadence = nextCadence(cadence, v, t);
    if (pingDue(lastFix, t, cadence.cadenceS, lastFixCadence)) {
      const p = fix();
      pending.push(p);
      pings.push(p);
      lastFix = t;
      lastFixCadence = cadence.cadenceS;
    }
    const offline = inRanges(s, opts.deadZones) || inRanges(t - opts.t0, opts.offline);
    if (t >= nextBatch) {
      nextBatch += CADENCE.BATCH_EVERY_MS;
      if (!offline) sendPending(wasOffline ? "flush" : "live");
      if (!offline) wasOffline = false;
    }
    if (offline) wasOffline = true;
    if (s >= route.total && holdUntil === null && nextStop >= stops.length) break;
  }
  // stand at the terminus for 20 s, then flush whatever is left (the phone is back online)
  // (on the same cadence rule as the rest of the trip: a fixed 5 s step here would leave a
  // gap longer than the previous fix promised whenever the bus arrived at the slow cadence)
  let tookOne = false;
  for (let i = 0; i < 20 || !tookOne; i++) {
    t += 1000;
    v = 0;
    cadence = nextCadence(cadence, v, t);
    if (pingDue(lastFix, t, cadence.cadenceS, lastFixCadence)) {
      const p = fix();
      pending.push(p);
      pings.push(p);
      lastFix = t;
      lastFixCadence = cadence.cadenceS;
      tookOne = true;
    }
  }
  sendPending(wasOffline ? "flush" : "live");

  // transport faults, after the fact so the fix sequence itself is unchanged by them
  const out: SimBatch[] = [];
  for (const b of batches) {
    out.push(b);
    if (rng() < (opts.dupRate ?? 0.02))
      out.push({ ...b, sendAt: b.sendAt + 700, kind: "duplicate" });
  }
  for (let i = 0; i + 1 < out.length; i++) {
    if (rng() < (opts.reorderRate ?? 0.02)) {
      const a = out[i]!;
      const b = out[i + 1]!;
      [a.sendAt, b.sendAt] = [b.sendAt, a.sendAt];
      out[i] = b;
      out[i + 1] = a;
      i++;
    }
  }
  return { batches: out, pings, endAt: t };
}

/**
 * Replay a recorded trace (tests/fixtures) as a tracker would have sent it, shifted to start at
 * `t0`. Deterministic: the same fixture and t0 give the same batches.
 */
export function replayTrace(
  trace: {
    pings: {
      t: string;
      lat: number;
      lng: number;
      speed_kmh?: number | null;
      accuracy_m?: number | null;
    }[];
  },
  t0: number,
  opts: { offline?: readonly [number, number][] } = {},
): SimTrip {
  const start = Date.parse(trace.pings[0]!.t);
  let cadence = initialCadence();
  let lastFix: number | null = null;
  let lastFixCadence: number | undefined;
  let nextBatch = t0 + CADENCE.BATCH_EVERY_MS;
  let wasOffline = false;
  const pending: SimPing[] = [];
  const pings: SimPing[] = [];
  const batches: SimBatch[] = [];
  const flush = (at: number) => {
    while (pending.length) {
      batches.push({
        sendAt: at,
        cadenceS: cadence.cadenceS,
        pings: pending.splice(0, CADENCE.MAX_BATCH),
        kind: wasOffline ? "flush" : "live",
      });
    }
  };
  for (const raw of trace.pings) {
    const at = t0 + (Date.parse(raw.t) - start);
    while (nextBatch <= at) {
      if (!inRanges(nextBatch - t0, opts.offline)) {
        flush(nextBatch);
        wasOffline = false;
      } else wasOffline = true;
      nextBatch += CADENCE.BATCH_EVERY_MS;
    }
    const speed = raw.speed_kmh ?? null;
    cadence = nextCadence(cadence, speed === null ? null : speed / 3.6, at);
    if (!pingDue(lastFix, at, cadence.cadenceS, lastFixCadence)) continue;
    const p: SimPing = {
      recorded_at: new Date(at).toISOString(),
      lat: raw.lat,
      lng: raw.lng,
      speed_kmh: speed ?? 0,
      heading_deg: 0,
      accuracy_m: raw.accuracy_m ?? 10,
    };
    pending.push(p);
    pings.push(p);
    lastFix = at;
    lastFixCadence = cadence.cadenceS;
  }
  flush(nextBatch);
  return { batches, pings, endAt: nextBatch };
}

/** A 1 Hz "phone on the dashboard" survey of `line`, for seeding routes through the real pipeline. */
export function surveyOf(
  route: Route,
  opts: { seed: number; t0: number; kmh?: number; noiseM?: number },
): { t: string; lat: number; lng: number; accuracy_m: number }[] {
  const rng = prng(opts.seed);
  const v = (opts.kmh ?? 30) / 3.6;
  const n = Math.floor(route.total / v);
  return Array.from({ length: n + 1 }, (_, i) => {
    const p = pointAtOffset(route, Math.min(route.total, i * v));
    const q = fromLocal(p, {
      x: gaussian(rng) * (opts.noiseM ?? 5),
      y: gaussian(rng) * (opts.noiseM ?? 5),
    });
    return { t: new Date(opts.t0 + i * 1000).toISOString(), lat: q.lat, lng: q.lng, accuracy_m: 6 };
  });
}
