import type { TestDb } from "./index.ts";
import { syntheticEmail } from "@busmitra/contracts";

/**
 * Synthetic people only — never real roster data in the repo (Read_this_first §7).
 * Phone numbers use the +91 99999 000xx block.
 */
export async function seedStudent(
  db: TestDb,
  opts: {
    rollNo: string;
    admissionYear?: number;
    phone?: string | null;
    role?: string;
    claimed?: boolean;
  },
): Promise<{ userId: string | null; rollNo: string }> {
  const phone = opts.phone === undefined ? "+919999900001" : opts.phone;
  await db.query(
    `INSERT INTO roster_students (roll_no, full_name, admission_year, cohort, phone_e164)
     VALUES ($1, $2, $3, derive_cohort($3::smallint, operating_date()), $4)`,
    [opts.rollNo, `Test ${opts.rollNo}`, opts.admissionYear ?? 2025, phone],
  );
  if (opts.claimed === false) return { userId: null, rollNo: opts.rollNo };
  const userId = await db.createAuthUser(syntheticEmail(opts.rollNo));
  await db.query(
    `INSERT INTO profiles (id, roll_no, full_name, cohort, role, phone_e164, phone_verified_at)
     SELECT $1, roll_no, full_name, cohort, $2::role_t, COALESCE(phone_e164, '+919999900000'), now()
       FROM roster_students WHERE roll_no = $3`,
    [userId, opts.role ?? "student", opts.rollNo],
  );
  await db.query(
    `UPDATE roster_students SET claimed_at = now(), claimed_by = $1 WHERE roll_no = $2`,
    [userId, opts.rollNo],
  );
  return { userId, rollNo: opts.rollNo };
}

/** WKT for a LineString from [lng, lat] pairs. */
export function lineWkt(coords: readonly { lat: number; lng: number }[]): string {
  return `SRID=4326;LINESTRING(${coords.map((c) => `${c.lng} ${c.lat}`).join(",")})`;
}

/** A route row (draft unless `published`), with stops placed at the given offsets. */
export async function seedRoute(
  db: TestDb,
  opts: {
    coords: readonly { lat: number; lng: number }[];
    name?: string;
    lineageId?: string;
    version?: number;
    published?: boolean;
    stops?: { name: string; offset: number; lat: number; lng: number }[];
  },
): Promise<{ routeId: string; lineageId: string; stopIds: string[] }> {
  const { rows } = await db.query<{ id: string; lineage_id: string }>(
    `INSERT INTO routes (lineage_id, name, direction, geometry, version, source)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, 'inbound', $3::geography, $4, 'manual_draw')
     RETURNING id, lineage_id`,
    [opts.lineageId ?? null, opts.name ?? "Test route", lineWkt(opts.coords), opts.version ?? 1],
  );
  const routeId = rows[0]!.id;
  const stopIds: string[] = [];
  for (const [i, s] of (opts.stops ?? []).entries()) {
    const st = await db.query<{ id: string }>(
      `INSERT INTO stops (name, location) VALUES ($1, ST_MakePoint($2, $3)::geography) RETURNING id`,
      [s.name, s.lng, s.lat],
    );
    stopIds.push(st.rows[0]!.id);
    await db.query(
      `INSERT INTO route_stops (route_id, seq, stop_id, cumulative_dist_m) VALUES ($1, $2, $3, $4)`,
      [routeId, i + 1, st.rows[0]!.id, s.offset],
    );
  }
  if (opts.published)
    await db.query(`UPDATE routes SET published_at = now() WHERE id = $1`, [routeId]);
  return { routeId, lineageId: rows[0]!.lineage_id, stopIds };
}

/** A bus with a paired driver-phone tracker whose secret is `secret` (encrypted with `key`). */
export async function seedTracker(
  db: TestDb,
  opts: { busNumber: string; deviceUid: string; secret: string; key: string },
): Promise<{ busId: string; trackerId: string }> {
  const bus = await db.query<{ id: string }>(
    `INSERT INTO buses (bus_number) VALUES ($1) RETURNING id`,
    [opts.busNumber],
  );
  const busId = bus.rows[0]!.id;
  const t = await db.query<{ id: string }>(
    `INSERT INTO trackers (device_uid, kind, bus_id, secret_enc)
     VALUES ($1, 'driver_phone', $2, pgp_sym_encrypt($3, $4)) RETURNING id`,
    [opts.deviceUid, busId, opts.secret, opts.key],
  );
  return { busId, trackerId: t.rows[0]!.id };
}

/** A running trip for `busId` on `routeId`. */
export async function seedTrip(
  db: TestDb,
  opts: { busId: string; routeId: string; status?: string },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO trips (bus_id, route_id, service_date, shift, status, started_at)
     VALUES ($1, $2, operating_date(), 'morning', $3::trip_status_t, now()) RETURNING id`,
    [opts.busId, opts.routeId, opts.status ?? "running"],
  );
  return rows[0]!.id;
}
