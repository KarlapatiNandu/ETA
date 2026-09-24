import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Db } from "@busmitra/db";
import type { Osrm } from "@busmitra/engine/osrm";
import type { SmsSender } from "@busmitra/notify";
import type { Keys, Redis } from "@busmitra/redis";
import { authHook } from "./plugins/auth.ts";
import { otelPlugin } from "./plugins/otel.ts";
import { adminAnnouncementRoutes } from "./routes/api/admin/announcements.ts";
import { adminAuditRoutes } from "./routes/api/admin/audit.ts";
import { adminDashboardRoutes } from "./routes/api/admin/dashboard.ts";
import { adminEventDayRoutes } from "./routes/api/admin/event-day.ts";
import { adminObservabilityRoutes } from "./routes/api/admin/observability.ts";
import { adminFleetRoutes } from "./routes/api/admin/fleet.ts";
import { adminRosterRoutes } from "./routes/api/admin/roster.ts";
import { adminRouteRoutes } from "./routes/api/admin/routes.ts";
import { adminTicketRoutes } from "./routes/api/admin/tickets.ts";
import { authRoutes } from "./routes/api/auth/index.ts";
import { meRoutes } from "./routes/api/me.ts";
import { searchRoutes } from "./routes/api/search.ts";
import { networkRoutes } from "./routes/api/network.ts";
import { notificationRoutes, smsReceiptRoutes } from "./routes/api/notifications.ts";
import { ingestRoutes } from "./routes/ingest/index.ts";
import { EventHub } from "./routes/stream/hub.ts";
import { reclaimPhantoms, streamRoutes } from "./routes/stream/index.ts";
import { trackerRoutes } from "./routes/tracker/index.ts";
import type { AuthAdmin } from "./services/auth-admin.ts";
import type { FileStore } from "./services/files.ts";
import type { Geocoder } from "./services/geocoder.ts";
import type { JwtVerifier } from "./services/jwt.ts";
import { createTrackerDirectory } from "./services/trackers.ts";
import { createTripDirectory } from "./services/trips.ts";

export interface AppDeps {
  db: Db;
  sms: SmsSender;
  authAdmin: AuthAdmin;
  files: FileStore;
  verifyJwt: JwtVerifier;
  decoyKey: string;
  webOrigin: string;
  /** the driver PWA's origin — it calls the signed tracker endpoints cross-origin */
  driverOrigin?: string;
  /**
   * Stage 2 ingest. Without Redis the gateway still serves auth and admin (the Stage 4 test
   * harness runs that way); the tracker endpoints are simply not mounted.
   */
  redis?: Redis;
  keys?: Keys;
  /** TRACKER_SECRET_KEY — decrypts trackers.secret_enc (invariant 6) */
  trackerKey?: string;
  /** Stage 1 route capture */
  osrm?: Osrm;
  surveyFiles?: FileStore;
  now?: () => number;
  /**
   * Stage 3 SSE. Stable across restarts of the same instance (hostname:port by default), so a
   * gateway restarted after SIGKILL recognises and deletes its own phantom connection keys.
   */
  instanceId?: string;
  /** test knobs: heartbeat and connection-key TTL, seconds */
  sse?: { heartbeatS?: number; connTtlS?: number };
  /** Stage 5: Photon, for area search when the text is a place rather than a stop */
  geocoder?: Geocoder;
  /** Stage 5: walking (and cycling) times; `osrm` above is the car profile */
  osrmFoot?: Osrm;
  /** Stage 6: VAPID public key the browser subscribes with (none = push off) */
  vapidPublicKey?: string;
  /** Stage 6: shared secret on the MSG91 delivery-receipt webhook */
  smsReceiptToken?: string;
}

export async function buildApp(
  deps: AppDeps,
  opts: { logger?: boolean } = {},
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: true });

  await app.register(cors, {
    origin: deps.driverOrigin ? [deps.webOrigin, deps.driverOrigin] : deps.webOrigin,
    credentials: true,
    // @fastify/cors defaults to GET,HEAD,POST: without PUT and DELETE the admin route editor's
    // save and discard fail in the browser at the preflight, which no inject() test can see
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
  });
  // Redis-backed when Redis is configured, so per-IP limits hold across gateway instances;
  // in-memory otherwise (tests, single instance). The namespace comes from the key registry.
  await app.register(rateLimit, {
    global: false,
    ...(deps.redis && deps.keys
      ? { redis: deps.redis, nameSpace: deps.keys.httpRateLimitPrefix, skipOnError: false }
      : {}),
  });
  otelPlugin(app);
  app.addHook("onRequest", authHook(deps));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: "invalid_request",
        message: err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      });
    }
    const e = err as { statusCode?: number; code?: unknown; stops?: unknown };
    if (e.statusCode && e.statusCode < 500) {
      // domain errors carry a machine-readable code (e.g. repeated_stops); Fastify's own are FST_*
      const code =
        typeof e.code === "string" && !e.code.startsWith("FST_") ? e.code : "bad_request";
      return reply.code(e.statusCode).send({
        error: code,
        message: (err as Error).message,
        ...(e.stops ? { stops: e.stops } : {}),
      });
    }
    req.log.error(err);
    return reply.code(500).send({ error: "internal", message: "Something went wrong." });
  });

  // one directory per process, shared by ingest and the admin console: a rotation from the
  // console forgets the cached secret here at once (the other instances within CACHE_TTL_MS)
  const trackers = deps.trackerKey
    ? createTrackerDirectory(deps.db, deps.trackerKey, deps.now)
    : undefined;

  app.get("/healthz", async () => ({ ok: true }));
  await app.register(async (scope) => authRoutes(scope, deps));
  await app.register(async (scope) => adminRosterRoutes(scope, deps));
  await app.register(async (scope) => adminRouteRoutes(scope, deps));
  // Stage 7: the Transport Department's console
  await app.register(async (scope) => adminFleetRoutes(scope, { ...deps, trackers }));
  await app.register(async (scope) => adminTicketRoutes(scope, deps));
  await app.register(async (scope) => adminAnnouncementRoutes(scope, deps));
  await app.register(async (scope) => adminEventDayRoutes(scope, deps));
  await app.register(async (scope) => adminAuditRoutes(scope, deps));
  await app.register(async (scope) => adminDashboardRoutes(scope, deps));
  await app.register(async (scope) => networkRoutes(scope, deps));
  const stage5 = {
    db: deps.db,
    redis: deps.redis,
    keys: deps.keys,
    geocoder: deps.geocoder,
    osrmFoot: deps.osrmFoot,
    osrmCar: deps.osrm,
  };
  await app.register(async (scope) => searchRoutes(scope, stage5));
  await app.register(async (scope) => meRoutes(scope, stage5));
  // Stage 6: the student's half of the notification spine, and the SMS receipt webhook
  await app.register(async (scope) =>
    notificationRoutes(scope, {
      db: deps.db,
      vapidPublicKey: deps.vapidPublicKey,
      osrmFoot: deps.osrmFoot,
      osrmCar: deps.osrm,
      now: deps.now,
    }),
  );
  await app.register(async (scope) =>
    smsReceiptRoutes(scope, { db: deps.db, token: deps.smsReceiptToken }),
  );

  if (deps.redis && deps.keys && trackers) {
    const shared = {
      db: deps.db,
      redis: deps.redis,
      keys: deps.keys,
      trackers,
      trips: createTripDirectory(deps.db, deps.now),
      now: deps.now,
    };
    await app.register(async (scope) => ingestRoutes(scope, shared));

    // SSE (ADR-0001): one Redis tailer per process, fanned out to every stream it holds
    const hub = new EventHub(deps.redis, deps.keys, (m, e) => app.log.warn(e, m));
    const instanceId = deps.instanceId ?? "gateway";
    const redis = deps.redis;
    const keys = deps.keys;
    app.addHook("onReady", async () => {
      const n = await reclaimPhantoms(redis, keys, instanceId);
      if (n) app.log.info({ reclaimed: n }, "sse: deleted connection keys left by a previous run");
      await hub.start();
    });
    const etaSubscriber = redis.duplicate();
    app.addHook("onClose", async () => {
      await hub.stop();
      etaSubscriber.disconnect();
    });
    // Stage 8: the console's health page reads this instance's fan-out window
    await app.register(async (scope) =>
      adminObservabilityRoutes(scope, { ...deps, redis, keys, hub }),
    );
    await app.register(async (scope) =>
      streamRoutes(scope, {
        redis,
        keys,
        hub,
        etaSubscriber,
        instanceId,
        heartbeatS: deps.sse?.heartbeatS,
        connTtlS: deps.sse?.connTtlS,
        now: deps.now,
      }),
    );
    if (deps.surveyFiles) {
      const surveyFiles = deps.surveyFiles;
      await app.register(async (scope) => trackerRoutes(scope, { ...shared, surveyFiles }));
    }
  }
  return app;
}
