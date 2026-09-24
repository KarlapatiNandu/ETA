import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { INGEST_MAX_SKEW_S } from "@busmitra/config";
import { signingPayload, TRACKER_HEADERS } from "@busmitra/contracts";
import { TTL, type Keys, type Redis } from "@busmitra/redis";
import type { TrackerDirectory, TrackerIdentity } from "../services/trackers.ts";

declare module "fastify" {
  interface FastifyRequest {
    rawBody: string;
    device: TrackerIdentity;
  }
}

export interface DeviceAuthDeps {
  trackers: TrackerDirectory;
  redis: Redis;
  keys: Keys;
  now?: () => number;
}

export function sign(secret: string, deviceUid: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret)
    .update(signingPayload(deviceUid, timestamp, body))
    .digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

const deny = (reply: FastifyReply, error: string, message: string) =>
  reply.code(401).send({ error, message });

/**
 * Per-device HMAC authentication for everything a tracker calls (ARCH §10): ingest, trip
 * start/end, survey upload. Register inside the scope that serves those routes; it installs a
 * JSON parser that keeps the raw body, because the signature is over the exact bytes sent.
 *
 * Order matters: skew → identity → signature → nonce. The nonce is recorded only after the
 * signature verifies, so forged requests cannot fill the replay cache or burn real nonces.
 */
export function deviceAuth(
  app: FastifyInstance,
  deps: DeviceAuthDeps,
  opts: { bodyLimit: number },
) {
  const now = deps.now ?? Date.now;
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: opts.bodyLimit },
    (req, body, done) => {
      (req as FastifyRequest).rawBody = body as string;
      try {
        done(null, (body as string).length ? JSON.parse(body as string) : {});
      } catch {
        done(Object.assign(new Error("Body is not valid JSON."), { statusCode: 400 }), undefined);
      }
    },
  );

  app.addHook("preHandler", async (req, reply) => {
    req.rawBody ??= "";
    const deviceUid = req.headers[TRACKER_HEADERS.device];
    const ts = req.headers[TRACKER_HEADERS.timestamp];
    const sig = req.headers[TRACKER_HEADERS.signature];
    if (typeof deviceUid !== "string" || typeof ts !== "string" || typeof sig !== "string") {
      return deny(reply, "unsigned", "Missing tracker signature headers.");
    }
    const tsNum = Number(ts);
    if (!/^\d{9,11}$/.test(ts) || Math.abs(now() / 1000 - tsNum) > INGEST_MAX_SKEW_S) {
      // a phone with a wrong clock lands here: say so, so the driver sheet can tell them why
      return deny(reply, "stale_timestamp", "Request timestamp is outside the ±5 minute window.");
    }
    const lower = sig.toLowerCase();
    const verifies = (id: TrackerIdentity | null) =>
      !!id && id.secrets.some((s) => safeEqualHex(sign(s, deviceUid, ts, req.rawBody), lower));
    let identity = await deps.trackers.get(deviceUid);
    // A miss against the cache may be a secret rotated (or a phone paired) on another gateway
    // instance: re-read once, rate-limited per device, before refusing.
    if (!verifies(identity)) identity = await deps.trackers.refresh(deviceUid);
    // unknown device and wrong signature answer identically: device ids are not enumerable
    if (!identity || !verifies(identity)) {
      return deny(reply, "bad_signature", "Signature does not verify.");
    }
    // The replay cache guards *writes*: a captured ingest batch or trip end must not apply
    // twice. A GET changes nothing, and callers legitimately repeat one (a retry, a React
    // effect that runs twice in development) — refusing those is a self-inflicted failure
    // that reads, to the driver, as "this phone is not assigned to a bus".
    if (req.method === "GET" || req.method === "HEAD") {
      req.device = identity;
      return;
    }
    let fresh: string | null;
    try {
      fresh = await deps.redis.set(
        deps.keys.ingestNonce(lower),
        "1",
        "EX",
        TTL.INGEST_NONCE_S,
        "NX",
      );
    } catch (err) {
      req.log.error({ err }, "device-auth: redis unavailable");
      return reply.code(503).send({ error: "unavailable", message: "Keep buffering and retry." });
    }
    if (fresh !== "OK") {
      // an exact replay of a request already accepted: harmless to the caller, refused here
      return reply
        .code(409)
        .send({ error: "replay", message: "This request was already received." });
    }
    req.device = identity;
  });
}
