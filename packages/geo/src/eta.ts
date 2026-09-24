/** ARCH §5.5. Change the document in the same commit as any of these numbers. */
export const ETA = {
  /** segment_speeds bucket length along the route */
  SEGMENT_M: 200,
  W_HIST: 0.55,
  W_LIVE: 0.35,
  W_OSRM: 0.1,
  COLD_W_OSRM: 0.6,
  COLD_W_LIVE: 0.4,
  CONGESTION_MIN: 0.3,
  CONGESTION_MAX: 1.2,
  MIN_KMH: 5,
  MAX_KMH: 60,
  /** a ladder rung is usable from this many samples */
  MIN_SAMPLES: 5,
  DEFAULT_DWELL_S: 30,
  /** with no history and no OSRM at all, assume town traffic */
  FALLBACK_KMH: 20,
  /** p90/p50 spread when there is no history to measure variance from */
  COLD_P90_FACTOR: 1.35,
} as const;

export interface SegmentStat {
  medianKmh: number;
  p10Kmh: number;
  p90Kmh: number;
  sampleCount: number;
}

/**
 * The `v_hist` fallback ladder: rungs ordered most specific first — (weekday, tod),
 * (weekdayClass, tod), (tod), (any). Take the first with enough samples; null means cold start.
 * Rung 1 will almost never be populated at ~2 trips a day, and that is the design, not a bug.
 */
export function resolveRung(
  rungs: readonly (SegmentStat | null | undefined)[],
): { stat: SegmentStat; rung: number } | null {
  for (let i = 0; i < rungs.length; i++) {
    const r = rungs[i];
    if (r && r.sampleCount >= ETA.MIN_SAMPLES) return { stat: r, rung: i + 1 };
  }
  return null;
}

export interface SpeedModel {
  /** resolved history per 200 m segment index (already run through `resolveRung`) */
  hist: readonly (SegmentStat | null | undefined)[];
  /** OSRM free-flow speed per segment index, km/h */
  osrm: readonly (number | null | undefined)[];
  /** v_live: EWMA of observed speed, km/h */
  liveKmh: number | null;
}

export interface EtaStop {
  offset: number;
  /** expected dwell (historical median of departed − arrived), seconds */
  dwellS?: number | null;
}

export type Confidence = "high" | "medium" | "low";

export interface Eta {
  p50S: number;
  p90S: number;
  confidence: Confidence;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const clampKmh = (v: number) => clamp(v, ETA.MIN_KMH, ETA.MAX_KMH);

/**
 * ARCH §5.5: time from offset `s` to `target`, as a range, never a point.
 *
 *   v_expected = 0.55·v_hist + 0.35·v_live + 0.10·v_osrm           (history resolved)
 *              = 0.60·v_osrm·congestion + 0.40·v_live               (cold start)
 *   congestion = clamp(v_live / v_osrm_here, 0.3, 1.2), v clamped to [5, 60] km/h
 *
 * p90 uses the historical p10 speed where history exists, and a fixed spread where it does
 * not. Confidence says how much of the distance was covered by real history.
 * `stops` are the stops strictly between s and target; their dwells are added.
 */
export function computeEta(
  s: number,
  target: number,
  model: SpeedModel,
  stops: readonly EtaStop[] = [],
): Eta {
  if (target <= s) return { p50S: 0, p90S: 0, confidence: "high" };

  const here = Math.floor(s / ETA.SEGMENT_M);
  const osrmHere = model.osrm[here] ?? null;
  const live = model.liveKmh;
  const congestion =
    live !== null && osrmHere ? clamp(live / osrmHere, ETA.CONGESTION_MIN, ETA.CONGESTION_MAX) : 1;

  let p50 = 0;
  let p90 = 0;
  let histM = 0;
  let pos = s;
  while (pos < target) {
    const seg = Math.floor(pos / ETA.SEGMENT_M);
    const end = Math.min(target, (seg + 1) * ETA.SEGMENT_M);
    const len = end - pos;
    const hist = model.hist[seg];
    const osrm = model.osrm[seg] ?? null;

    let v: number;
    let vSlow: number;
    if (hist) {
      const vOsrm = osrm ?? hist.medianKmh;
      const vLive = live ?? hist.medianKmh;
      v = ETA.W_HIST * hist.medianKmh + ETA.W_LIVE * vLive + ETA.W_OSRM * vOsrm;
      vSlow =
        ETA.W_HIST * hist.p10Kmh + ETA.W_LIVE * Math.min(vLive, hist.p10Kmh) + ETA.W_OSRM * vOsrm;
      histM += len;
    } else if (osrm) {
      v =
        live !== null
          ? ETA.COLD_W_OSRM * osrm * congestion + ETA.COLD_W_LIVE * live
          : osrm * congestion;
      vSlow = v / ETA.COLD_P90_FACTOR;
    } else {
      // OSRM down and no history: the live speed, else a town-traffic guess
      v = live ?? ETA.FALLBACK_KMH;
      vSlow = v / ETA.COLD_P90_FACTOR;
    }
    p50 += len / (clampKmh(v) / 3.6);
    p90 += len / (clampKmh(vSlow) / 3.6);
    pos = end;
  }
  for (const stop of stops) {
    if (stop.offset > s && stop.offset < target) {
      const dwell = stop.dwellS ?? ETA.DEFAULT_DWELL_S;
      p50 += dwell;
      p90 += dwell * 1.5;
    }
  }
  const share = histM / (target - s);
  const confidence: Confidence = share >= 0.8 ? "high" : share >= 0.3 ? "medium" : "low";
  return { p50S: Math.round(p50), p90S: Math.round(Math.max(p50, p90)), confidence };
}
