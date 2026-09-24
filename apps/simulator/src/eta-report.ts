import type { Queryable } from "@busmitra/db";

/**
 * `sim eta-report` — ETA accuracy from `eta_predictions` (BUILD_PLAN Stage 5 "Validate ETA
 * accuracy against reality"). Per horizon: how many predictions have a known arrival, the mean
 * absolute error (the gate: < 90 s at the 10-minute horizon), the bias (positive = the bus came
 * later than predicted), the 90th-percentile absolute error, and how often the arrival fell
 * inside the predicted range [p50 − (p90 − p50), p90] ("the range told the truth").
 *
 * Run it over real trips for the gate. Over simulated trips it checks the pipeline end to end —
 * the simulator's buses are not Hyderabad traffic, and its number is not the gate.
 */
export interface HorizonAccuracy {
  horizonS: number;
  n: number;
  maeS: number | null;
  biasS: number | null;
  p90AbsS: number | null;
  inRangePct: number | null;
  trips: number;
}

export async function etaReport(
  db: Queryable,
  opts: { since: string; busPrefix?: string },
): Promise<HorizonAccuracy[]> {
  const { rows } = await db.query<{
    horizon_s: number;
    n: number;
    mae: number | null;
    bias: number | null;
    p90abs: number | null;
    in_range: number | null;
    trips: number;
  }>(
    `SELECT e.horizon_s,
            count(*)::int AS n,
            round(avg(abs(e.error_s)))::int AS mae,
            round(avg(e.error_s))::int AS bias,
            round(percentile_cont(0.9) WITHIN GROUP (ORDER BY abs(e.error_s)))::int AS p90abs,
            round(100.0 * avg(CASE WHEN e.error_s BETWEEN -(e.p90_s - e.p50_s) AND (e.p90_s - e.p50_s)
                                   THEN 1 ELSE 0 END), 1)::float AS in_range,
            count(DISTINCT e.trip_id)::int AS trips
       FROM eta_predictions e
       JOIN trips t ON t.id = e.trip_id
       JOIN buses b ON b.id = t.bus_id
      WHERE e.actual_arrival_at IS NOT NULL
        AND e.predicted_at >= $1::timestamptz
        AND ($2::text IS NULL OR b.bus_number LIKE $2 || '%')
      GROUP BY e.horizon_s ORDER BY e.horizon_s DESC`,
    [opts.since, opts.busPrefix ?? null],
  );
  return rows.map((r) => ({
    horizonS: Number(r.horizon_s),
    n: Number(r.n),
    maeS: r.mae === null ? null : Number(r.mae),
    biasS: r.bias === null ? null : Number(r.bias),
    p90AbsS: r.p90abs === null ? null : Number(r.p90abs),
    inRangePct: r.in_range === null ? null : Number(r.in_range),
    trips: Number(r.trips),
  }));
}
