import type { FastifyInstance } from "fastify";
import { BACKFILL_LAG_S } from "@busmitra/config";
import { batchCadence, PingBatch, type IngestResult, type StreamPing } from "@busmitra/contracts";
import { appendEntries, STREAMS, type Keys, type Redis } from "@busmitra/redis";
import { instruments, traceparentOfSpan } from "@busmitra/telemetry";
import { deviceAuth } from "../../plugins/device-auth.ts";
import type { TrackerDirectory } from "../../services/trackers.ts";
import { acceptsPings, type TripDirectory } from "../../services/trips.ts";

export const INGEST = {
  /** requests per device per minute: 12 at a 5 s cadence, plus reconnect flushes */
  MAX_REQUESTS_PER_MIN: 120,
  /** a fix further in the future than this is a broken phone clock, not a ping */
  MAX_FUTURE_MS: 5 * 60_000,
  /** older than this is not backfill any more; it would also miss every positions partition */
  MAX_AGE_MS: 48 * 3600_000,
  BODY_LIMIT: 1024 * 1024,
} as const;

export interface IngestDeps {
  trackers: TrackerDirectory;
  trips: TripDirectory;
  redis: Redis;
  keys: Keys;
  now?: () => number;
}

/**
 * POST /v1/ingest (BUILD_PLAN Stage 2). HMAC → validate → per-device rate limit → XADD
 * stream:pings → respond. No database write on this path (invariant 1): the trip lookup is a
 * cached read, and persistence happens later on a consumer nobody waits for.
 *
 * Answers the tracker precisely, because its retry logic depends on it:
 *   200 — every ping is either queued or listed in `rejected` (never resend those)
 *   400 — the batch itself is malformed; resending it will never work
 *   401 — signature or clock problem; 409 `replay` — this exact request was already taken
 *   409 `trip_not_live` — stop sending for this trip; 429 — slow down; 503 — Redis is down,
 *   keep buffering and retry
 */
export async function ingestRoutes(app: FastifyInstance, deps: IngestDeps) {
  const now = deps.now ?? Date.now;
  deviceAuth(app, deps, { bodyLimit: INGEST.BODY_LIMIT });

  app.post("/v1/ingest", async (req, reply) => {
    const batch = PingBatch.parse(req.body);
    if (batch.device_uid !== req.device.deviceUid) {
      return reply
        .code(400)
        .send({ error: "device_mismatch", message: "device_uid does not match the signature." });
    }
    const trip = await deps.trips.get(batch.trip_id);
    const t = now();
    if (!trip || trip.busId !== req.device.busId || !acceptsPings(trip, t)) {
      return reply
        .code(409)
        .send({ error: "trip_not_live", message: "This trip is not open for this bus." });
    }

    const window = Math.floor(t / 60_000);
    const rateKey = deps.keys.ingestRate(req.device.deviceUid, window);
    let count: number;
    try {
      count = await deps.redis.incr(rateKey);
      if (count === 1) await deps.redis.expire(rateKey, 120);
    } catch (err) {
      req.log.error({ err }, "ingest: redis unavailable");
      return reply.code(503).send({ error: "unavailable", message: "Keep buffering and retry." });
    }
    if (count > INGEST.MAX_REQUESTS_PER_MIN) {
      return reply
        .code(429)
        .header("retry-after", "30")
        .send({ error: "rate_limited", message: "Slow down." });
    }

    const cadence = batchCadence(batch);
    const ingestedAt = new Date(t).toISOString();
    const rejected: IngestResult["rejected"] = [];
    const seen = new Set<number>();
    const accepted: StreamPing[] = [];
    batch.pings.forEach((p, index) => {
      const at = Date.parse(p.recorded_at);
      if (at > t + INGEST.MAX_FUTURE_MS)
        return void rejected.push({ index, reason: "future_timestamp" });
      if (at < t - INGEST.MAX_AGE_MS) return void rejected.push({ index, reason: "too_old" });
      // a duplicate inside one batch is dropped here; across batches the unique index and the
      // geo worker's staleness check make it a no-op
      if (seen.has(at)) return;
      seen.add(at);
      accepted.push({
        kind: "ping",
        trip_id: trip.id,
        bus_id: trip.busId,
        route_id: trip.routeId,
        device_uid: batch.device_uid,
        cadence_s: cadence,
        recorded_at: new Date(at).toISOString(),
        ingested_at: ingestedAt,
        lat: p.lat,
        lng: p.lng,
        speed_kmh: p.speed_kmh ?? null,
        heading_deg: p.heading_deg ?? null,
        accuracy_m: p.accuracy_m ?? null,
        // ARCH §5.7: persisted and fed to history, but never notifies and never overwrites live
        is_backfill: t - at > BACKFILL_LAG_S * 1000,
      });
    });
    // recorded order, not arrival order: a flushed buffer and live pings interleave correctly
    accepted.sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
    // Stage 8: the request's span becomes the parent of every step this batch causes
    req.span?.setAttributes({
      "busmitra.device": batch.device_uid,
      "busmitra.pings.accepted": accepted.length,
      "busmitra.pings.rejected": rejected.length,
      "busmitra.pings.backfill": accepted.filter((p) => p.is_backfill).length,
    });
    try {
      await appendEntries(
        deps.redis,
        deps.keys.streamPings,
        accepted,
        STREAMS.PINGS_MAXLEN,
        req.span ? traceparentOfSpan(req.span) : undefined,
      );
    } catch (err) {
      req.log.error({ err }, "ingest: XADD failed");
      return reply.code(503).send({ error: "unavailable", message: "Keep buffering and retry." });
    }
    instruments.ingestPings().add(accepted.length, { result: "accepted" });
    if (rejected.length) instruments.ingestPings().add(rejected.length, { result: "rejected" });
    const result: IngestResult = { accepted: accepted.length, rejected };
    return result;
  });
}
