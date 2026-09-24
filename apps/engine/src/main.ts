import { hostname } from "node:os";
import { z } from "zod";
import { coreEnv, EnvError, loadEnv, notifyEnv, redisEnv, smsEnv } from "@busmitra/config";
import { createPgDb } from "@busmitra/db";
import { createConsoleSms, createMsg91Sms, createWebPush } from "@busmitra/notify";
import { createRedis, keys } from "@busmitra/redis";
import { startTelemetry } from "@busmitra/telemetry";
import { registerEngineGauges } from "./lib/health.ts";
import { rehydrateFleet } from "./lib/rehydrate.ts";
import { RouteCache } from "./lib/route-cache.ts";
import { HistoryCache } from "./lib/speed-model.ts";
import { runEvery } from "./lib/ticker.ts";
import { createOsrm } from "./osrm.ts";
import { dispatchDueAnnouncements, DISPATCH_EVERY_MS } from "./workers/announcements.ts";
import { DEADZONE, learnDeadZones, nightlyDue } from "./workers/deadzone.ts";
import { runEtaWorker } from "./workers/eta.ts";
import { runGeoWorker } from "./workers/geo.ts";
import { runLeaveNow } from "./workers/leave-now.ts";
import { runNotify } from "./workers/notify.ts";
import { runPersister } from "./workers/persister.ts";
import { runPresence } from "./workers/presence.ts";
import { materialiseEventDayTrips, SCHEDULE_EVERY_MS } from "./workers/schedule.ts";
import { runStopEvents } from "./workers/stop-events.ts";
import { syncSignalTickets, TICKETS_EVERY_MS } from "./workers/tickets.ts";

/**
 * The engine process (ARCH §3): stream consumers that no request ever waits on. A separate
 * process and failure domain from the gateway, so a slow ETA or a Postgres outage cannot add a
 * millisecond to an ingest ack.
 */

let env;
try {
  env = loadEnv(
    coreEnv
      .and(z.object({ DATABASE_URL: z.url(), OSRM_CAR_URL: z.url().optional() }))
      .and(redisEnv)
      .and(smsEnv)
      .and(notifyEnv),
  );
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

// Stage 8: before anything records a metric (a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT is set)
const telemetry = await startTelemetry({ service: "busmitra-engine" });

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const db = createPgDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL, "engine");
const routes = new RouteCache(db, redis, keys);
const stop = new AbortController();
if (telemetry.enabled) registerEngineGauges({ redis, keys });
const id = `${hostname()}-${process.pid}`;

// ADR-0002: an empty Redis must not blank the map — refill it from the last 5 min of positions
try {
  const n = await rehydrateFleet(db, redis, keys, routes);
  if (n) log("engine: fleet rehydrated from positions", { buses: n });
} catch (err) {
  // Postgres down at boot: the live path does not need it, so start anyway
  log("engine: rehydrate skipped", { error: (err as Error).message });
}

// each blocking consumer gets its own connection: XREADGROUP BLOCK holds the socket
const workers = [
  runGeoWorker({
    redis,
    keys,
    routes,
    log,
    stream: createRedis(env.REDIS_URL, "geo"),
    consumer: `geo-${id}`,
    signal: stop.signal,
  }),
  runPersister({
    db,
    redis,
    keys,
    routes,
    log,
    stream: createRedis(env.REDIS_URL, "persist"),
    consumer: `persist-${id}`,
    signal: stop.signal,
  }),
  runStopEvents({
    db,
    redis,
    keys,
    log,
    stream: createRedis(env.REDIS_URL, "stop-events"),
    consumer: `stop-events-${id}`,
    signal: stop.signal,
  }),
  // one sweeper is the design; a second is harmless (every write is a compare-and-set)
  runPresence({ db, redis, keys, routes, log, signal: stop.signal }),
  // Stage 5: per-stop ETAs from every position, and the leave-now evaluator on top of them
  runEtaWorker({
    db,
    redis,
    keys,
    routes,
    log,
    history: new HistoryCache(db),
    // OSRM free-flow speeds are one input of three; without OSRM the blend still works (§11)
    osrm: env.OSRM_CAR_URL ? createOsrm(env.OSRM_CAR_URL, { timeoutMs: 15_000 }) : undefined,
    stream: createRedis(env.REDIS_URL, "eta"),
    consumer: `eta-${id}`,
    signal: stop.signal,
  }),
  runLeaveNow({ db, redis, keys, log, signal: stop.signal }),
  // Stage 6: the notification spine — record, then deliver (push, SMS fallback for T0/T1)
  runNotify({
    db,
    redis,
    keys,
    log,
    push:
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? createWebPush({
            publicKey: env.VAPID_PUBLIC_KEY,
            privateKey: env.VAPID_PRIVATE_KEY,
            subject: env.VAPID_SUBJECT,
          })
        : null,
    sms:
      env.SMS_PROVIDER === "msg91"
        ? createMsg91Sms({
            authKey: env.MSG91_AUTH_KEY,
            templateIds: {
              otp: env.MSG91_TEMPLATE_OTP,
              t0_alert: env.MSG91_TEMPLATE_T0,
              t1_alert: env.MSG91_TEMPLATE_T1,
            },
          })
        : createConsoleSms((line) => log("sms (console)", { line })),
    notifyStream: createRedis(env.REDIS_URL, "notify"),
    eventsStream: createRedis(env.REDIS_URL, "notify-events"),
    consumer: `notify-${id}`,
    signal: stop.signal,
  }),
  // Stage 7: the admin console's background half — each is a compare-and-set, so two engines
  // are harmless
  runEvery(
    "announcements",
    DISPATCH_EVERY_MS,
    async () => {
      const sent = await dispatchDueAnnouncements({ db, redis, keys });
      if (sent.length) log("announcements: published scheduled", { ids: sent });
    },
    { signal: stop.signal, log },
  ),
  runEvery(
    "tickets",
    TICKETS_EVERY_MS,
    async () => {
      const r = await syncSignalTickets(db);
      if (r.opened.length || r.resolved.length) log("tickets: signal-loss sync", r);
    },
    { signal: stop.signal, log },
  ),
  runEvery(
    "schedule",
    SCHEDULE_EVERY_MS,
    async () => {
      const r = await materialiseEventDayTrips(db);
      if (r.scheduled || r.abandoned) log("schedule: event-day trips", r);
    },
    { signal: stop.signal, log },
  ),
  // Stage 8: nightly dead-zone learning. Checked every 5 min; a run is idempotent, so an engine
  // restarted after 02:30 IST simply runs it once more that day
  (() => {
    let lastDay: string | null = null;
    return runEvery(
      "deadzone",
      DEADZONE.CHECK_EVERY_MS,
      async () => {
        const due = nightlyDue(Date.now(), lastDay);
        if (!due.due) return;
        const r = await learnDeadZones(db);
        lastDay = due.day;
        log("deadzone: learned", {
          outages: r.outages,
          zones: r.clusters,
          inserted: r.inserted.length,
          updated: r.updated.length,
          retired: r.retired.length,
        });
      },
      { signal: stop.signal, log },
    );
  })(),
];
log("engine: started", { consumer: id });

const shutdown = async (signal: string) => {
  log("engine: stopping", { signal });
  stop.abort();
  // unacked entries stay pending and are re-read on the next start — nothing is lost
  await Promise.race([Promise.allSettled(workers), new Promise((r) => setTimeout(r, 5000))]);
  await db.close();
  redis.disconnect();
  await telemetry.shutdown().catch(() => undefined);
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
