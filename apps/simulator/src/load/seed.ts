import { createECDH, createHmac, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "@busmitra/db";

/**
 * Synthetic students for the Stage 8 load run: a roster row, an Auth user, a profile and one
 * push subscription each, pointing at the local push sink. Roll numbers start with LOAD so they
 * can never be mistaken for a real student, and `cleanLoadUsers` removes every one of them.
 *
 * LOCAL ONLY. It writes straight into auth.users and mints tokens with the project's JWT secret —
 * the load harness refuses to run unless the database is on localhost.
 */

export interface LoadUser {
  id: string;
  roll: string;
  token: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** An HS256 Supabase-shaped access token (what `createJwtVerifier` accepts). */
export function mintToken(secret: string, sub: string, ttlS = 4 * 3600): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(
    JSON.stringify({ sub, role: "authenticated", aud: "authenticated", iat: now, exp: now + ttlS }),
  );
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** A browser-shaped subscription: a real P-256 key pair, so web-push can encrypt to it. */
function pushKeys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) };
}

export async function cleanLoadUsers(db: Db): Promise<number> {
  return db.tx(async (q) => {
    const ids = await q.query<{ id: string }>(
      `SELECT id FROM profiles WHERE roll_no LIKE 'LOAD%' AND role = 'student'`,
    );
    const list = ids.rows.map((r) => r.id);
    if (!list.length) return 0;
    await q.query(
      `UPDATE roster_students SET claimed_by = NULL WHERE claimed_by = ANY($1::uuid[])`,
      [list],
    );
    await q.query(`DELETE FROM auth.users WHERE id = ANY($1::uuid[])`, [list]); // cascades
    await q.query(
      `DELETE FROM roster_students r WHERE r.roll_no LIKE 'LOAD%'
          AND NOT EXISTS (SELECT 1 FROM profiles p WHERE p.roll_no = r.roll_no)`,
    );
    return list.length;
  });
}

async function createUser(db: Db, roll: string, role: string): Promise<string> {
  const id = randomUUID();
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO roster_students (roll_no, full_name, admission_year, cohort, phone_e164)
       VALUES ($1, $2, 2025, derive_cohort(2025::smallint, operating_date()), '+919999955555')
       ON CONFLICT (roll_no) DO NOTHING`,
      [roll, `Load ${roll}`],
    );
    await q.query(
      `INSERT INTO auth.users (id, aud, role, email) VALUES ($1, 'authenticated', 'authenticated', $2)`,
      [id, `${roll.toLowerCase()}@students.busmitra.internal`],
    );
    await q.query(
      `INSERT INTO profiles (id, roll_no, full_name, cohort, role, phone_e164, phone_verified_at)
       SELECT $1, roll_no, full_name, cohort, $2::role_t, phone_e164, now()
         FROM roster_students WHERE roll_no = $3`,
      [id, role, roll],
    );
    await q.query(
      `UPDATE roster_students SET claimed_at = now(), claimed_by = $1 WHERE roll_no = $2`,
      [id, roll],
    );
  });
  return id;
}

/**
 * `n` load students (removing any earlier ones first) and the load admin (kept across runs: its
 * announcements reference it). Every student gets a push subscription at `${sinkUrl}/push/<id>`.
 */
export async function seedLoadUsers(
  db: Db,
  opts: { n: number; sinkUrl: string; jwtSecret: string },
): Promise<{ users: LoadUser[]; admin: LoadUser }> {
  await cleanLoadUsers(db);
  const found = await db.query<{ id: string }>(
    `SELECT id FROM profiles WHERE roll_no = 'LOADADMIN'`,
  );
  const adminId = found.rows[0]?.id ?? (await createUser(db, "LOADADMIN", "td_admin"));
  const users: LoadUser[] = [];
  for (let i = 1; i <= opts.n; i++) {
    const roll = `LOAD${String(i).padStart(5, "0")}`;
    const id = await createUser(db, roll, "student");
    const k = pushKeys();
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, is_standalone)
       VALUES ($1, $2, $3, $4, 'busmitra-load', true)`,
      [id, `${opts.sinkUrl}/push/${id}`, k.p256dh, k.auth],
    );
    users.push({ id, roll, token: mintToken(opts.jwtSecret, id) });
  }
  return {
    users,
    admin: { id: adminId, roll: "LOADADMIN", token: mintToken(opts.jwtSecret, adminId) },
  };
}
