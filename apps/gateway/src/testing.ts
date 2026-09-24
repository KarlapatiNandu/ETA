import { SignJWT } from "jose";
import { createTestDb, type TestDb } from "@busmitra/db/testing";
import type { Osrm } from "@busmitra/engine/osrm";
import type { SmsMessage } from "@busmitra/notify";
import type { TestRedis } from "@busmitra/redis/testing";
import { buildApp } from "./app.ts";
import type { AuthAdmin } from "./services/auth-admin.ts";
import type { Geocoder } from "./services/geocoder.ts";
import { createMemoryFileStore } from "./services/files.ts";
import { createJwtVerifier } from "./services/jwt.ts";

const SECRET = "test-secret-with-at-least-thirty-two-chars";
export const TRACKER_KEY = "tracker-key-for-tests-0123456789abcdef";
export const SMS_RECEIPT_TOKEN = "receipt-token-for-tests-0123";

/**
 * The gateway wired to an in-process Postgres, a recording SMS sender and a fake Auth. Pass a
 * test Redis to mount the Stage 2 tracker endpoints (ingest, trips, survey), and an OSRM stub
 * for the survey-matching admin endpoint.
 */
export async function createTestGateway(
  opts: {
    redis?: TestRedis;
    osrm?: Osrm;
    now?: () => number;
    instanceId?: string;
    sse?: { heartbeatS?: number; connTtlS?: number };
    /** share one database between several gateways (a restart, a second instance) */
    db?: TestDb;
    geocoder?: Geocoder;
    osrmFoot?: Osrm;
  } = {},
) {
  const db: TestDb = opts.db ?? (await createTestDb());
  const sent: SmsMessage[] = [];
  const passwords = new Map<string, string>();
  const authAdmin: AuthAdmin = {
    // Real Supabase Auth is a separate service with its own connection. PGlite has one, so the
    // fake writes straight through (bypassing the harness's transaction queue) — going through
    // the queue here deadlocks behind the claim transaction that is calling us.
    async createUser({ email, password }) {
      const { rows } = await db.raw.query<{ id: string }>(
        "INSERT INTO auth.users (email) VALUES ($1) RETURNING id",
        [email],
      );
      const id = rows[0]!.id;
      passwords.set(id, password);
      return { id };
    },
    async deleteUser(id) {
      await db.raw.query("DELETE FROM auth.users WHERE id = $1", [id]);
    },
    async updatePassword(id, password) {
      passwords.set(id, password);
    },
  };
  const files = createMemoryFileStore();
  const surveyFiles = createMemoryFileStore();
  const app = await buildApp(
    {
      db,
      sms: { send: async (m) => void sent.push(m) },
      authAdmin,
      files,
      verifyJwt: createJwtVerifier({ secret: SECRET }),
      decoyKey: "decoy-key-for-tests-0123456789abcdef",
      webOrigin: "http://localhost:3000",
      driverOrigin: "http://localhost:5173",
      ...(opts.redis
        ? { redis: opts.redis.redis, keys: opts.redis.keys, trackerKey: TRACKER_KEY }
        : {}),
      surveyFiles,
      osrm: opts.osrm,
      now: opts.now,
      instanceId: opts.instanceId,
      sse: opts.sse,
      geocoder: opts.geocoder,
      osrmFoot: opts.osrmFoot,
      smsReceiptToken: SMS_RECEIPT_TOKEN,
    },
    { logger: false },
  );
  const tokenFor = (userId: string) =>
    new SignJWT({ role: "authenticated" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(SECRET));
  /** Most recent OTP sent to a number (the SMS send is fire-and-forget; let it land). */
  const lastOtp = async (to: string) => {
    await new Promise((r) => setImmediate(r));
    return [...sent].reverse().find((m) => m.to === to)?.vars.otp;
  };
  return { app, db, sent, passwords, files, surveyFiles, tokenFor, lastOtp };
}
