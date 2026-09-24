import { randomBytes } from "node:crypto";
import type { Queryable } from "@busmitra/db";

/**
 * Tracker identity for the signed endpoints (ARCH §10).
 *
 * Secrets are decrypted with pgp_sym_decrypt and TRACKER_SECRET_KEY, which lives only in the
 * gateway environment (invariant 6). Lookups are cached in process memory, and a cached entry
 * is served past its TTL if Postgres cannot be reached: ingest must keep flowing while the
 * database is down (ARCH §11 — "Postgres down: live map unaffected"). The accepted cost: a
 * revoked or rotated secret keeps verifying for up to CACHE_TTL_MS.
 */

export const TRACKERS = {
  CACHE_TTL_MS: 60_000,
  /** unknown device ids are remembered briefly, so a flood of forged ids cannot hammer Postgres */
  NEGATIVE_TTL_MS: 30_000,
  /** both secrets verify for this long after a rotation, so a rotation cannot brick a bus mid-route */
  ROTATION_OVERLAP_MS: 10 * 60_000,
  /**
   * A signature that fails against a cached secret re-reads the tracker once, at most this often
   * per device: a phone freshly paired or rotated on another gateway instance is accepted within
   * seconds instead of a minute, and a flood of forged signatures costs one query per 5 s.
   */
  REFRESH_ON_MISS_MS: 5_000,
} as const;

export interface TrackerIdentity {
  trackerId: string;
  deviceUid: string;
  busId: string | null;
  /** current secret first; the previous one only inside the rotation overlap */
  secrets: string[];
}

export interface TrackerDirectory {
  get(deviceUid: string): Promise<TrackerIdentity | null>;
  forget(deviceUid: string): void;
  /** re-read from Postgres if the cached entry is older than REFRESH_ON_MISS_MS */
  refresh(deviceUid: string): Promise<TrackerIdentity | null>;
}

export function createTrackerDirectory(
  db: Queryable,
  secretKey: string,
  now: () => number = Date.now,
): TrackerDirectory {
  const cache = new Map<string, { value: TrackerIdentity | null; at: number }>();
  const dir: TrackerDirectory = {
    forget: (uid) => void cache.delete(uid),
    async refresh(deviceUid) {
      const hit = cache.get(deviceUid);
      if (hit && now() - hit.at < TRACKERS.REFRESH_ON_MISS_MS) return hit.value;
      cache.delete(deviceUid);
      try {
        return await dir.get(deviceUid);
      } catch (err) {
        // Postgres down: keep serving what we had (stale-on-error, as get does)
        if (hit) {
          cache.set(deviceUid, hit);
          return hit.value;
        }
        throw err;
      }
    },
    async get(deviceUid) {
      const hit = cache.get(deviceUid);
      const ttl = hit?.value ? TRACKERS.CACHE_TTL_MS : TRACKERS.NEGATIVE_TTL_MS;
      if (hit && now() - hit.at < ttl) return hit.value;
      try {
        const { rows } = await db.query<{
          id: string;
          bus_id: string | null;
          secret: string;
          prev: string | null;
          rotated_at: Date | null;
        }>(
          `SELECT id, bus_id,
                  pgp_sym_decrypt(secret_enc, $2) AS secret,
                  CASE WHEN secret_prev_enc IS NOT NULL
                       THEN pgp_sym_decrypt(secret_prev_enc, $2) END AS prev,
                  secret_rotated_at AS rotated_at
             FROM trackers WHERE device_uid = $1`,
          [deviceUid, secretKey],
        );
        const r = rows[0];
        const value: TrackerIdentity | null = r
          ? {
              trackerId: r.id,
              deviceUid,
              busId: r.bus_id,
              secrets: [
                r.secret,
                ...(r.prev &&
                r.rotated_at &&
                now() - new Date(r.rotated_at).getTime() < TRACKERS.ROTATION_OVERLAP_MS
                  ? [r.prev]
                  : []),
              ],
            }
          : null;
        cache.set(deviceUid, { value, at: now() });
        return value;
      } catch (err) {
        if (hit) return hit.value; // stale-on-error: Postgres is down, keep ingest alive
        throw err;
      }
    },
  };
  return dir;
}

/** A fresh shared secret: 32 random bytes, base64url. Shown once, never stored in plaintext. */
export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create (or re-pair) a driver-phone tracker for a bus and issue its secret. Service-role only:
 * the admin console's pairing screen (Stage 7) will call this; until then, the CLI does.
 */
export async function provisionTracker(
  q: Queryable,
  secretKey: string,
  opts: { busNumber: string; deviceUid: string; kind?: "driver_phone" | "hardware" },
): Promise<{ trackerId: string; busId: string; secret: string }> {
  const bus = await q.query<{ id: string }>(
    `INSERT INTO buses (bus_number) VALUES ($1)
     ON CONFLICT (bus_number) DO UPDATE SET bus_number = EXCLUDED.bus_number RETURNING id`,
    [opts.busNumber],
  );
  const busId = bus.rows[0]!.id;
  const secret = newSecret();
  const t = await q.query<{ id: string }>(
    `INSERT INTO trackers (device_uid, kind, bus_id, secret_enc)
     VALUES ($1, $2::tracker_kind_t, $3, pgp_sym_encrypt($4, $5))
     ON CONFLICT (device_uid) DO UPDATE
       SET bus_id = EXCLUDED.bus_id, secret_prev_enc = NULL,
           secret_enc = EXCLUDED.secret_enc, secret_rotated_at = now()
     RETURNING id`,
    [opts.deviceUid, opts.kind ?? "driver_phone", busId, secret, secretKey],
  );
  return { trackerId: t.rows[0]!.id, busId, secret };
}

/** Issue a new secret; the old one keeps verifying for ROTATION_OVERLAP_MS. */
export async function rotateTrackerSecret(
  q: Queryable,
  secretKey: string,
  deviceUid: string,
): Promise<string | null> {
  const secret = newSecret();
  const { rows } = await q.query(
    `UPDATE trackers
        SET secret_prev_enc = secret_enc,
            secret_enc = pgp_sym_encrypt($2, $3),
            secret_rotated_at = now()
      WHERE device_uid = $1 RETURNING id`,
    [deviceUid, secret, secretKey],
  );
  return rows.length ? secret : null;
}
