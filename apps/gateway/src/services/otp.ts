import { createHmac, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { CLAIM } from "@busmitra/config";
import type { OtpStartResponse } from "@busmitra/contracts";
import {
  normaliseRollNo,
  syntheticEmail,
  withContext,
  type Db,
  type RequestContext,
} from "@busmitra/db";
import type { SmsSender } from "@busmitra/notify";
import type { AuthAdmin } from "./auth-admin.ts";

/**
 * Claim and recovery OTPs (SCHEMA §1, BUILD_PLAN Stage 4).
 *
 * The enumeration defence is structural, not a matter of careful error messages: EVERY
 * start request — roll number on the roster or not, claimed or not, phone or not — does
 * the same work (bcrypt a fresh code, insert a claim_challenges row) and returns the same
 * shape. Only whether an SMS is actually sent differs, and that send is not awaited.
 * Because decoy requests create real challenge rows, rate limits and lockouts also behave
 * identically for roll numbers that do not exist.
 */

export type Purpose = "claim" | "recover";

export class OtpError extends Error {
  readonly status: 400 | 429;
  readonly code: "invalid_code" | "rate_limited" | "locked";
  constructor(code: OtpError["code"]) {
    super(code);
    this.code = code;
    this.status = code === "invalid_code" ? 400 : 429;
  }
}

export interface OtpDeps {
  db: Db;
  sms: SmsSender;
  authAdmin: AuthAdmin;
  decoyKey: string;
  log: { error(obj: unknown, msg: string): void };
}

export function maskPhone(e164: string): string {
  return `+91 ••••• •${e164.slice(-4)}`;
}

/** Stable per roll number, so repeating a request for a fake roll shows the same digits. */
export function decoyMask(key: string, rollNo: string): string {
  const n = createHmac("sha256", key).update(rollNo).digest().readUInt32BE(0) % 10_000;
  return `+91 ••••• •${String(n).padStart(4, "0")}`;
}

async function isLocked(db: Db, rollNo: string, purpose: Purpose): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM claim_challenges WHERE roll_no = $1 AND purpose = $2 AND locked_until > now() LIMIT 1`,
    [rollNo, purpose],
  );
  return rows.length > 0;
}

export async function startOtp(
  deps: OtpDeps,
  purpose: Purpose,
  rawRollNo: string,
): Promise<OtpStartResponse> {
  const rollNo = normaliseRollNo(rawRollNo);
  const { db } = deps;

  if (await isLocked(db, rollNo, purpose)) throw new OtpError("locked");
  const { rows: recent } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM claim_challenges
      WHERE roll_no = $1 AND purpose = $2 AND created_at > now() - interval '1 hour'`,
    [rollNo, purpose],
  );
  if ((recent[0]?.n ?? 0) >= CLAIM.MAX_CHALLENGES_PER_HOUR) throw new OtpError("rate_limited");

  // Who (if anyone) should actually receive a code.
  const { rows: target } =
    purpose === "claim"
      ? await db.query<{ phone: string }>(
          `SELECT phone_e164 AS phone FROM roster_students
            WHERE roll_no = $1 AND claimed_at IS NULL AND phone_e164 IS NOT NULL`,
          [rollNo],
        )
      : await db.query<{ phone: string }>(
          `SELECT phone_e164 AS phone FROM profiles WHERE roll_no = $1`,
          [rollNo],
        );
  const phone = target[0]?.phone ?? null;

  const code = String(randomInt(0, 10 ** CLAIM.OTP_DIGITS)).padStart(CLAIM.OTP_DIGITS, "0");
  const otpHash = await bcrypt.hash(code, 10);
  await db.query(
    `INSERT INTO claim_challenges (roll_no, purpose, otp_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [rollNo, purpose, otpHash, CLAIM.OTP_TTL_S],
  );

  if (phone) {
    // Not awaited: an SMS provider round-trip would make real roll numbers measurably
    // slower than fake ones. Failures are logged for the runbook, not returned.
    deps.sms
      .send({ to: phone, template: "otp", vars: { otp: code } })
      .catch((err: unknown) => deps.log.error({ err, purpose }, "otp sms failed"));
  }

  return {
    status: "sent",
    masked_phone: phone ? maskPhone(phone) : decoyMask(deps.decoyKey, rollNo),
    expires_in_s: CLAIM.OTP_TTL_S,
  };
}

/**
 * Check the code. Attempt counting commits even when the code is wrong — which is why the
 * failure is decided inside the transaction but thrown after it.
 */
async function consumeChallenge(
  deps: OtpDeps,
  purpose: Purpose,
  rollNo: string,
  otp: string,
  ctx: RequestContext,
) {
  if (await isLocked(deps.db, rollNo, purpose)) throw new OtpError("locked");
  const outcome = await withContext(deps.db, ctx, async (q) => {
    const { rows } = await q.query<{ id: string; otp_hash: string; attempts: number }>(
      `SELECT id, otp_hash, attempts FROM claim_challenges
        WHERE roll_no = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [rollNo, purpose],
    );
    const ch = rows[0];
    if (!ch) return "invalid" as const;
    if (!(await bcrypt.compare(otp, ch.otp_hash))) {
      await q.query(
        `UPDATE claim_challenges SET attempts = attempts + 1,
                locked_until = CASE WHEN attempts + 1 >= $2 THEN now() + make_interval(secs => $3) END
          WHERE id = $1`,
        [ch.id, CLAIM.MAX_ATTEMPTS_PER_CHALLENGE, CLAIM.LOCKOUT_S],
      );
      return "invalid" as const;
    }
    await q.query(`UPDATE claim_challenges SET consumed_at = now() WHERE id = $1`, [ch.id]);
    return "ok" as const;
  });
  if (outcome !== "ok") throw new OtpError("invalid_code");
}

export async function verifyClaim(
  deps: OtpDeps,
  input: { roll_no: string; otp: string; password: string },
  ctx: RequestContext,
): Promise<void> {
  const rollNo = normaliseRollNo(input.roll_no);
  await consumeChallenge(deps, "claim", rollNo, input.otp, ctx);

  await withContext(deps.db, ctx, async (q) => {
    const { rows } = await q.query<{ full_name: string; cohort: string; phone_e164: string }>(
      `SELECT full_name, cohort, phone_e164 FROM roster_students
        WHERE roll_no = $1 AND claimed_at IS NULL AND phone_e164 IS NOT NULL FOR UPDATE`,
      [rollNo],
    );
    const r = rows[0];
    // A correct code for an ineligible roll is only possible for a decoy challenge (1 in 10⁶
    // guesses) or a race with another claim — either way, the same generic answer.
    if (!r) throw new OtpError("invalid_code");

    const { id } = await deps.authAdmin.createUser({
      email: syntheticEmail(rollNo),
      password: input.password,
      rollNo,
    });
    try {
      await q.query(
        `INSERT INTO profiles (id, roll_no, full_name, cohort, phone_e164, phone_verified_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [id, rollNo, r.full_name, r.cohort, r.phone_e164],
      );
      await q.query(
        `UPDATE roster_students SET claimed_at = now(), claimed_by = $1 WHERE roll_no = $2`,
        [id, rollNo],
      );
    } catch (err) {
      // the auth user lives outside this transaction — undo it, or the roll is stuck forever
      await deps.authAdmin
        .deleteUser(id)
        .catch((e: unknown) => deps.log.error({ e, id }, "orphan auth user"));
      throw err;
    }
  });
}

export async function verifyRecovery(
  deps: OtpDeps,
  input: { roll_no: string; otp: string; new_password: string },
  ctx: RequestContext,
): Promise<void> {
  const rollNo = normaliseRollNo(input.roll_no);
  await consumeChallenge(deps, "recover", rollNo, input.otp, ctx);
  const { rows } = await deps.db.query<{ id: string }>(
    `SELECT id FROM profiles WHERE roll_no = $1`,
    [rollNo],
  );
  if (!rows[0]) throw new OtpError("invalid_code");
  await deps.authAdmin.updatePassword(rows[0].id, input.new_password);
}
