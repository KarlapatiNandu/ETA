import { z } from "zod";

/** Claim and recovery API (SCHEMA §1 claim flow). Gateway validates, web app calls. */

const rollNo = z.string().trim().min(1).max(20);
const otp = z.string().regex(/^\d{6}$/, "must be the 6-digit code");
/** bcrypt (used by Supabase Auth) silently truncates beyond 72 bytes. */
const password = z.string().min(8, "must be at least 8 characters").max(72);

export const OtpStartRequest = z.object({ roll_no: rollNo });
export type OtpStartRequest = z.infer<typeof OtpStartRequest>;

/**
 * Identical in shape and status for every roll number — on the roster or not, claimed or
 * not — so the endpoint cannot be used to enumerate the roster.
 */
export const OtpStartResponse = z.object({
  status: z.literal("sent"),
  /** "+91 ••••• •3210" — a stable decoy for roll numbers that will not receive a code */
  masked_phone: z.string(),
  expires_in_s: z.number().int(),
});
export type OtpStartResponse = z.infer<typeof OtpStartResponse>;

export const ClaimVerifyRequest = z.object({ roll_no: rollNo, otp, password });
export type ClaimVerifyRequest = z.infer<typeof ClaimVerifyRequest>;

export const RecoverVerifyRequest = z.object({ roll_no: rollNo, otp, new_password: password });
export type RecoverVerifyRequest = z.infer<typeof RecoverVerifyRequest>;

export const ApiError = z.object({ error: z.string(), message: z.string() });
export type ApiError = z.infer<typeof ApiError>;

/** The one failure message every OTP verification error maps to. */
export const GENERIC_OTP_FAILURE = "That code is incorrect or has expired. Request a new one.";
