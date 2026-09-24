/** ARCH §5.3. Change the document in the same commit as any of these numbers. */
export const PROGRESS = {
  /** a fix this far behind the accepted offset is rejected as jitter */
  BACKWARD_TOLERANCE_M: 30,
  /** consecutive backward rejections that mean the bus really reversed */
  RESNAP_AFTER_BACKWARD: 4,
  /** fastest a campus bus can plausibly cover route distance */
  MAX_SPEED_MPS: 120 / 3.6,
  /** slack on top of speed × dt, for GPS error at both ends */
  JUMP_SLACK_M: 60,
} as const;

/** The longest forward move along the route that is physically possible in `dtS` seconds. */
export function maxPlausibleJump(dtS: number): number {
  return Math.max(0, dtS) * PROGRESS.MAX_SPEED_MPS + PROGRESS.JUMP_SLACK_M;
}

export type ProgressDecision =
  /** take `s` (never below the previous offset: small jitter is held, not followed) */
  | "accept"
  /** more than BACKWARD_TOLERANCE behind: jitter, keep the previous offset */
  | "reject_backward"
  /** further ahead than the bus could have driven: a GPS spike, keep the previous offset */
  | "reject_spike"
  /**
   * RESNAP_AFTER_BACKWARD backward fixes running: this is a U-turn, a missed turn or a
   * mid-route start, not jitter. Re-snap globally, reset the stop sequence, suppress ETAs
   * for a cycle (§5.3 recovery). Without this the offset freezes for the rest of the trip.
   */
  | "resnap";

export interface ProgressResult {
  decision: ProgressDecision;
  /** the offset to carry forward (the previous one unless accepted) */
  s: number;
  backwardRun: number;
}

/**
 * ARCH §5.3. `dtS` is the time since the last *accepted* fix, not the last fix: measured
 * from the last fix, a run of rejected spikes would keep the plausible-jump budget small
 * forever and freeze a bus that really did cover the distance.
 */
export function enforceMonotonicProgress(
  sPrev: number | null,
  sNew: number,
  dtS: number,
  backwardRun: number,
): ProgressResult {
  if (sPrev === null) return { decision: "accept", s: sNew, backwardRun: 0 };
  if (sNew < sPrev - PROGRESS.BACKWARD_TOLERANCE_M) {
    const run = backwardRun + 1;
    if (run >= PROGRESS.RESNAP_AFTER_BACKWARD)
      return { decision: "resnap", s: sPrev, backwardRun: 0 };
    return { decision: "reject_backward", s: sPrev, backwardRun: run };
  }
  if (sNew - sPrev > maxPlausibleJump(dtS)) {
    return { decision: "reject_spike", s: sPrev, backwardRun };
  }
  return { decision: "accept", s: Math.max(sPrev, sNew), backwardRun: 0 };
}

/** ARCH §5.5 v_live: exponentially weighted moving average, α = 0.3. */
export const EWMA_ALPHA = 0.3;

export function ewma(prev: number | null, sample: number, alpha: number = EWMA_ALPHA): number {
  return prev === null ? sample : alpha * sample + (1 - alpha) * prev;
}
