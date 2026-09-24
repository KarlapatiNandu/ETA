import { z } from "zod";

/**
 * The ingest contract (ARCH §3, §5.7). Driver phones speak it today; the Stage 9 hardware
 * adapter must emit exactly this shape. Additive changes only — trackers in the field
 * cannot be upgraded in lockstep with the gateway.
 */

export const Ping = z.object({
  /** When the GPS fix happened (tracker clock), ISO-8601 with offset. */
  recorded_at: z.iso.datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speed_kmh: z.number().min(0).max(200).nullable().optional(),
  heading_deg: z.number().int().min(0).max(359).nullable().optional(),
  accuracy_m: z.number().min(0).nullable().optional(),
});
export type Ping = z.infer<typeof Ping>;

export const PingBatch = z.object({
  device_uid: z.string().min(1).max(128),
  trip_id: z.uuid(),
  /**
   * The tracker's *current* reporting interval in seconds (5 moving, 15 stationary for the
   * driver PWA). Presence thresholds are 3× / 9× this value (ARCH §5.7). Optional on the
   * wire only so a malformed tracker degrades instead of being rejected; read it through
   * `batchCadence`, which applies the documented 5 s default.
   */
  cadence_s: z.number().int().min(1).max(300).optional(),
  pings: z.array(Ping).min(1).max(500),
});
export type PingBatch = z.infer<typeof PingBatch>;

export const DEFAULT_CADENCE_S = 5;

export function batchCadence(batch: Pick<PingBatch, "cadence_s">): number {
  return batch.cadence_s ?? DEFAULT_CADENCE_S;
}
