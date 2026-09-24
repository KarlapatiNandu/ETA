/**
 * The tracker's reporting cadence (BUILD_PLAN Stage 2): 5 s moving, 15 s stationary, and the
 * current value sent as `cadence_s` in every batch. Presence thresholds are multiples of it
 * (ARCH §5.7), so the driver PWA and the simulator must agree on it exactly — which is why the
 * rule lives here, once, as a pure function.
 */

export const CADENCE = {
  MOVING_S: 5,
  STATIONARY_S: 15,
  /** below this the bus is standing still (≈ 5.4 km/h, walking pace) */
  STILL_MPS: 1.5,
  /** it must stay still this long before the tracker slows down — not at every red light */
  STILL_FOR_MS: 30_000,
  /** a trip's batches go out at this interval whatever the cadence */
  BATCH_EVERY_MS: 5_000,
  /** most buffered pings one request carries on a reconnect flush */
  MAX_BATCH: 500,
} as const;

export interface CadenceState {
  cadenceS: number;
  /** epoch ms since which the bus has been continuously still; null while moving */
  stillSince: number | null;
}

export const initialCadence = (): CadenceState => ({
  cadenceS: CADENCE.MOVING_S,
  stillSince: null,
});

/**
 * Feed every GPS fix. Speeds up immediately on movement (a departing bus must not wait 15 s to
 * be seen), slows down only after STILL_FOR_MS of stillness. A null speed is treated as moving:
 * reporting too often is cheap, reporting too rarely turns a healthy bus amber.
 */
export function nextCadence(
  state: CadenceState,
  speedMps: number | null,
  at: number,
): CadenceState {
  if (speedMps === null || speedMps >= CADENCE.STILL_MPS) {
    return { cadenceS: CADENCE.MOVING_S, stillSince: null };
  }
  const since = state.stillSince ?? at;
  return {
    cadenceS: at - since >= CADENCE.STILL_FOR_MS ? CADENCE.STATIONARY_S : state.cadenceS,
    stillSince: since,
  };
}

/**
 * Whether a fix at `at` is due, given the last one recorded at `lastAt`.
 *
 * `lastCadenceS` is the cadence the *last* ping was sent with — the promise the tracker made
 * about when the next one would come. The next ping is due at the sooner of that promise and
 * the current cadence. Without it, the moment the tracker slows from 5 s to 15 s the last
 * ping still advertises 5 s while the next one is 15 s away, and the presence sweeper
 * (3 × 5 s = 15 s) turns a parked bus amber on every stop — the exact false alarm
 * ARCH §5.7 exists to prevent. Speeding up is never delayed: min() takes the faster one.
 */
export function pingDue(
  lastAt: number | null,
  at: number,
  cadenceS: number,
  lastCadenceS: number = cadenceS,
): boolean {
  const due = Math.min(cadenceS, lastCadenceS);
  // 250 ms of slack: watchPosition callbacks do not land on exact second boundaries
  return lastAt === null || at - lastAt >= due * 1000 - 250;
}
