/**
 * Shared operational constants. Each one is named in docs/ARCHITECTURE.md; change the
 * document in the same commit as the number.
 */

/** ARCH §5.7 — presence thresholds are multiples of the tracker's cadence, never seconds. */
export const PRESENCE = {
  DEGRADED_CADENCE_MULTIPLE: 3,
  DARK_CADENCE_MULTIPLE: 9,
  ENDED_AFTER_DARK_S: 600,
  /** A PingBatch without cadence_s is treated as this. */
  DEFAULT_CADENCE_S: 5,
} as const;

/** ARCH §5.7 — a ping older than this at ingest is backfill. */
export const BACKFILL_LAG_S = 30;

/** SCHEMA §1 — claim / recovery OTP limits. */
export const CLAIM = {
  OTP_DIGITS: 6,
  OTP_TTL_S: 600,
  MAX_CHALLENGES_PER_HOUR: 3,
  MAX_ATTEMPTS_PER_CHALLENGE: 5,
  LOCKOUT_S: 1800,
} as const;

/** ARCH §10 — ingest HMAC skew window. */
export const INGEST_MAX_SKEW_S = 300;

/** ARCH §7 — SSE. */
export const SSE = { HEARTBEAT_S: 15, CONN_TTL_S: 45, MAX_STREAMS_PER_USER: 3 } as const;

/**
 * ARCH §12 / BUILD_PLAN Stage 8 — the alerting rules. One definition: the console's
 * observability page, the engine's gauges and `infra/grafana/provisioning/alerting` all use
 * these numbers (the Grafana YAML repeats them; `alerts.test.ts` keeps it in step).
 */
export const ALERTS = {
  /** p95 fix → SSE frame, seconds, sustained for SUSTAIN_S */
  PING_TO_FRAME_P95_S: 8,
  SUSTAIN_S: 300,
  /** entries a consumer group has not been delivered yet */
  CONSUMER_LAG: 1000,
  /** push POSTs refused (not 2xx), as a share of attempts over the last hour */
  PUSH_FAILURE_RATE: 0.1,
  /** a bus DARK this long on a running trip (a trip only runs inside a service window) */
  DARK_S: 15 * 60,
  /** pings the persister could not write — any at all needs a human */
  DEAD_LETTERS: 0,
} as const;
