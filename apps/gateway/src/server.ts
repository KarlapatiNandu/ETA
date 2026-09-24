import { hostname } from "node:os";
import { z } from "zod";
import {
  EnvError,
  coreEnv,
  gatewayEnv,
  loadEnv,
  notifyEnv,
  redisEnv,
  smsEnv,
  supabaseEnv,
} from "@busmitra/config";
import { createPgDb } from "@busmitra/db";
import { createOsrm } from "@busmitra/engine/osrm";
import { createConsoleSms, createMsg91Sms } from "@busmitra/notify";
import { createRedis, keys } from "@busmitra/redis";
import { startTelemetry } from "@busmitra/telemetry";
import { buildApp } from "./app.ts";
import { createSupabaseAuthAdmin } from "./services/auth-admin.ts";
import { createSupabaseFileStore, SURVEY_BUCKET } from "./services/files.ts";
import { createPhotonGeocoder } from "./services/geocoder.ts";
import { createJwtVerifier } from "./services/jwt.ts";

// one parse over every group, so the operator sees every missing variable at once
const schema = coreEnv
  .and(supabaseEnv)
  .and(gatewayEnv)
  .and(redisEnv)
  .and(z.object({ OSRM_CAR_URL: z.url(), OSRM_FOOT_URL: z.url(), PHOTON_URL: z.url() }))
  .and(smsEnv)
  .and(notifyEnv);
let env;
try {
  const parsed = loadEnv(schema);
  env = { ...parsed, sms: parsed };
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
if (env.NODE_ENV === "production" && env.sms.SMS_PROVIDER === "console") {
  console.error(
    "SMS_PROVIDER=console is not allowed in production: OTPs would only reach the log.",
  );
  process.exit(1);
}

// Stage 8: before anything records a metric (a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set)
const telemetry = await startTelemetry({ service: "busmitra-gateway" });

const app = await buildApp({
  db: createPgDb(env.DATABASE_URL),
  sms:
    env.sms.SMS_PROVIDER === "msg91"
      ? createMsg91Sms({
          authKey: env.sms.MSG91_AUTH_KEY,
          templateIds: { otp: env.sms.MSG91_TEMPLATE_OTP },
        })
      : createConsoleSms(),
  authAdmin: createSupabaseAuthAdmin(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
  files: createSupabaseFileStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
  verifyJwt: createJwtVerifier({ secret: env.SUPABASE_JWT_SECRET, supabaseUrl: env.SUPABASE_URL }),
  decoyKey: env.CLAIM_DECOY_KEY,
  webOrigin: env.WEB_ORIGIN,
  driverOrigin: env.DRIVER_ORIGIN,
  redis: createRedis(env.REDIS_URL, "gateway"),
  keys,
  trackerKey: env.TRACKER_SECRET_KEY,
  osrm: createOsrm(env.OSRM_CAR_URL, { timeoutMs: 15_000 }),
  osrmFoot: createOsrm(env.OSRM_FOOT_URL, { profile: "foot", timeoutMs: 5_000 }),
  geocoder: createPhotonGeocoder(env.PHOTON_URL),
  vapidPublicKey: env.VAPID_PUBLIC_KEY,
  smsReceiptToken: env.SMS_RECEIPT_TOKEN,
  instanceId: `${hostname()}:${env.GATEWAY_PORT}`,
  surveyFiles: createSupabaseFileStore(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    SURVEY_BUCKET,
  ),
});

await app.listen({ port: env.GATEWAY_PORT, host: "0.0.0.0" });

// A deploy (Fly.io sends SIGINT, Docker SIGTERM) closes the app: every SSE stream ends and deletes
// its connection key (ARCH §7), in-flight requests finish, and buffered telemetry is flushed.
// Without this the process just died and the keys waited out their 45 s TTL.
let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, "gateway: shutting down");
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  await app.close().catch((err) => app.log.error(err));
  await telemetry.shutdown().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
