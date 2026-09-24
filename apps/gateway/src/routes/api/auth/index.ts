import type { FastifyInstance } from "fastify";
import {
  ClaimVerifyRequest,
  GENERIC_OTP_FAILURE,
  OtpStartRequest,
  RecoverVerifyRequest,
} from "@busmitra/contracts";
import type { AppDeps } from "../../../app.ts";
import { contextOf } from "../../../plugins/auth.ts";
import {
  OtpError,
  startOtp,
  verifyClaim,
  verifyRecovery,
  type OtpDeps,
} from "../../../services/otp.ts";

const MESSAGES: Record<OtpError["code"], string> = {
  invalid_code: GENERIC_OTP_FAILURE,
  rate_limited: "Too many requests for this roll number. Try again in an hour.",
  locked: "Too many wrong codes. Try again in 30 minutes.",
};

/**
 * POST /v1/auth/{claim,recover}/{start,verify}. Every failure maps to one of three fixed
 * messages that say nothing about whether the roll number exists.
 */
export async function authRoutes(app: FastifyInstance, deps: AppDeps) {
  const otpDeps: OtpDeps = { ...deps, log: app.log };
  // per-IP ceiling on top of the per-roll limits in the service: stops one client from
  // walking the whole roster space
  const limit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof OtpError) {
      return reply.code(err.status).send({ error: err.code, message: MESSAGES[err.code] });
    }
    throw err;
  });

  for (const purpose of ["claim", "recover"] as const) {
    app.post(`/v1/auth/${purpose}/start`, { config: limit }, async (req) => {
      const body = OtpStartRequest.parse(req.body);
      return startOtp(otpDeps, purpose, body.roll_no);
    });
  }

  app.post("/v1/auth/claim/verify", { config: limit }, async (req) => {
    await verifyClaim(otpDeps, ClaimVerifyRequest.parse(req.body), contextOf(req));
    return { status: "claimed" };
  });

  app.post("/v1/auth/recover/verify", { config: limit }, async (req) => {
    await verifyRecovery(otpDeps, RecoverVerifyRequest.parse(req.body), contextOf(req));
    return { status: "password_reset" };
  });
}
