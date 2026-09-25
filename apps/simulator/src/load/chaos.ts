import { execFileSync } from "node:child_process";
import type { Db } from "@busmitra/db";
import { groupInfo, readFleet, type Keys, type Redis } from "@busmitra/redis";
import { runFleet, type RunReport } from "../run.ts";
import { verifyRun, waitForDrain } from "../verify.ts";
import { startPushSink } from "./push-sink.ts";
import { cleanLoadUsers, seedLoadUsers, type LoadUser } from "./seed.ts";
import { makeCerts, sleep, Stack, waitFor } from "./stack.ts";

/**
 * `pnpm sim chaos <drill>` — the five Stage 8 chaos drills (BUILD_PLAN: "kill Redis · kill
 * Postgres · kill a worker mid-fan-out · saturate OSRM · revoke a VAPID key"), each against real
 * processes and real containers, each ending in a measured verdict. The runbook for each is in
 * vault/runbooks/ and quotes these numbers. LOCAL ONLY, and `pnpm dev` must be stopped.
 */

export type Drill = "redis" | "postgres" | "worker" | "osrm" | "vapid";

export interface ChaosEnv {
  gatewayPort: number;
  trackerKey: string;
  jwtSecret: string;
  databaseUrl: string;
  vapidPublicKey?: string;
  osrmCarUrl: string;
  osrmFootUrl?: string;
  log: (m: string) => void;
}

const SINK_PORT = 4700;
const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "pipe" }).toString();

async function healthy(container: string, ms = 120_000) {
  await waitFor(
    `${container} healthy`,
    async () => docker("inspect", "-f", "{{.State.Health.Status}}", container).trim() === "healthy",
    ms,
  );
}

/** Newest fix time across the fleet, or null when fleet:live cannot be read. */
async function newestFix(redis: Redis, keys: Keys): Promise<number | null> {
  try {
    const f = await readFleet(redis, keys);
    return Math.max(0, ...Object.values(f).map((e) => Date.parse(e.ts)));
  } catch {
    return null;
  }
}

async function worstLag(redis: Redis, keys: Keys): Promise<number> {
  const groups = (
    await Promise.all(
      [keys.streamPings, keys.streamEvents, keys.streamNotify].map((s) => groupInfo(redis, s)),
    )
  ).flat();
  return Math.max(0, ...groups.map((g) => g.lag ?? 0));
}

/**
 * Drive a small fleet for `minutes`, run `fault` part-way, then prove no fix was lost or
 * duplicated (the Stage 2 verifier: every fix sent is in `positions` exactly once).
 */
async function withFleet(
  db: Db,
  redis: Redis,
  keys: Keys,
  env: ChaosEnv,
  stack: Stack,
  minutes: number,
  fault: () => Promise<Record<string, unknown>>,
) {
  const fleet = runFleet(db, redis, keys, {
    gateway: stack.gateway,
    buses: 6,
    minutes,
    seed: 11,
    trackerKey: env.trackerKey,
    deadZones: false,
    faults: false,
    staggerS: 2,
    airplane: [],
    // a phone buffers for as long as it has to; so does the simulated one here
    maxAttempts: 40,
    log: (m) => env.log(`fleet: ${m}`),
  });
  await sleep(60_000); // a minute of normal running first
  const during = await fault();
  const report: RunReport = await fleet;
  const drained = await waitForDrain(redis, keys, 180_000);
  const v = await verifyRun(db, report);
  return {
    during,
    fixesSent: report.fixesSent,
    failedBatches: report.failedBatches,
    drained,
    persisted: v.persisted,
    missing: v.missing,
    duplicated: v.duplicated,
    lostOrDuplicated: v.missing + v.duplicated,
  };
}

export async function runDrill(
  drill: Drill,
  db: Db,
  redis: Redis,
  keys: Keys,
  env: ChaosEnv,
): Promise<Record<string, unknown>> {
  if (!["127.0.0.1", "localhost"].includes(new URL(env.databaseUrl).hostname)) {
    throw new Error("chaos: local stack only");
  }
  const certs = makeCerts();
  const stack = new Stack({
    gatewayPort: env.gatewayPort,
    env: { NODE_EXTRA_CA_CERTS: certs.ca },
  });
  await Stack.assertFree(stack.gateway);
  const sink = startPushSink({
    port: SINK_PORT,
    keyFile: certs.key,
    certFile: certs.cert,
    expectKey: env.vapidPublicKey,
  });
  await stack.startGateway();
  await stack.startEngine();
  const log = env.log;
  try {
    switch (drill) {
      // ── 1. Redis dies for 30 s ────────────────────────────────────────────
      case "redis":
        return await withFleet(db, redis, keys, env, stack, 4, async () => {
          const before = await newestFix(redis, keys);
          log("chaos: docker stop redis");
          const t0 = Date.now();
          docker("stop", "busmitra-redis-1");
          const probes = { gatewayUp: 0, gatewayDown: 0 };
          while (Date.now() - t0 < 30_000) {
            const ok = await fetch(`${stack.gateway}/healthz`).then(
              (r) => r.ok,
              () => false,
            );
            if (ok) probes.gatewayUp++;
            else probes.gatewayDown++;
            await sleep(1000);
          }
          docker("start", "busmitra-redis-1");
          await healthy("busmitra-redis-1");
          const restarted = Date.now();
          await waitFor(
            "live positions advancing again",
            async () => {
              const n = await newestFix(redis, keys);
              return n !== null && before !== null && n > restarted - 10_000;
            },
            120_000,
          );
          return {
            outageS: Math.round((restarted - t0) / 1000),
            gatewayProbes: probes,
            liveAgainAfterS: Math.round((Date.now() - restarted) / 100) / 10,
            gatewayStillRunning: await fetch(`${stack.gateway}/healthz`).then(
              (r) => r.ok,
              () => false,
            ),
          };
        });

      // ── 2. Postgres dies for 60 s ─────────────────────────────────────────
      case "postgres":
        return await withFleet(db, redis, keys, env, stack, 4, async () => {
          log("chaos: docker stop supabase_db");
          const t0 = Date.now();
          docker("stop", "supabase_db_busmitra");
          // the live map must not notice: fleet:live keeps moving, fixes stay seconds old
          const ages: number[] = [];
          while (Date.now() - t0 < 60_000) {
            const n = await newestFix(redis, keys);
            if (n) ages.push(Math.round((Date.now() - n) / 1000));
            await sleep(2000);
          }
          const lagAtRestore = await worstLag(redis, keys);
          docker("start", "supabase_db_busmitra");
          await healthy("supabase_db_busmitra");
          const restored = Date.now();
          await waitForDrain(redis, keys, 180_000);
          return {
            outageS: Math.round((restored - t0) / 1000),
            liveFixAgeDuringOutageS: { max: Math.max(...ages), samples: ages.length },
            persisterLagAtRestore: lagAtRestore,
            drainedAfterS: Math.round((Date.now() - restored) / 1000),
          };
        });

      // ── 3. the notify worker is SIGKILLed mid-fan-out ─────────────────────
      case "worker": {
        const n = 300;
        const { users, admin } = await seedLoadUsers(db, {
          n,
          sinkUrl: `https://127.0.0.1:${SINK_PORT}`,
          jwtSecret: env.jwtSecret,
        });
        const sentAt = Date.now();
        const id = await announce(stack.gateway, admin, users, 0, "CHAOS-T0 worker drill");
        await waitFor("first pushes", async () => sink.stats.received >= 40, 30_000);
        const atKill = sink.stats.received;
        log(`chaos: SIGKILL engine after ${atKill} pushes`);
        await stack.kill("engine", "SIGKILL");
        await sleep(2000);
        await stack.startEngine();
        await sleep(20_000); // plenty for the restarted worker to finish anything it can
        const ids = new Set(users.map((u) => u.id));
        const per = Object.entries(sink.stats.perEndpoint).filter(([k]) => ids.has(k));
        const rows = await db.query<{
          recipients: number;
          claimed: number;
          finished: number;
          open: number;
        }>(
          `SELECT count(*)::int AS recipients, count(r.sent_at)::int AS claimed,
                  count(r.channel)::int AS finished,
                  count(*) FILTER (WHERE r.sent_at IS NOT NULL AND r.channel IS NULL)::int AS open
             FROM announcements a JOIN notification_recipients r ON r.notification_id = a.notification_id
            WHERE a.id = $1`,
          [id],
        );
        return {
          students: n,
          pushesBeforeKill: atKill,
          pushesDelivered: per.length,
          duplicates: per.filter(([, c]) => c > 1).length,
          lostBuzzes: n - per.length,
          notificationCenter: rows.rows[0],
          lastPushAfterS:
            Math.round((Math.max(...per.map(([k]) => sink.stats.firstAt[k]!)) - sentAt) / 100) / 10,
        };
      }

      // ── 4. OSRM saturated for 60 s ────────────────────────────────────────
      case "osrm":
        return await withFleet(db, redis, keys, env, stack, 4, async () => {
          const stop = await db.query<{ id: string }>(
            `SELECT s.id FROM stops s JOIN route_stops rs ON rs.stop_id = s.id
               JOIN routes r ON r.id = rs.route_id
              WHERE r.published_at IS NOT NULL AND r.archived_at IS NULL LIMIT 1`,
          );
          const student = (
            await seedLoadUsers(db, {
              n: 1,
              sinkUrl: "https://127.0.0.1:1",
              jwtSecret: env.jwtSecret,
            })
          ).users[0]!;
          await db.query(
            `UPDATE profiles SET home_location = ST_SetSRID(ST_MakePoint(78.50, 17.40), 4326)::geography WHERE id = $1`,
            [student.id],
          );
          const stopUrl = `${stack.gateway}/v1/stops/${stop.rows[0]!.id}`;
          // each probe moves the home pin, which empties walk_eta_cache (0006 trigger): the stop
          // page must ask OSRM foot afresh every time, so the flood is on the path being timed
          let nudge = 0;
          const timed = async () => {
            nudge++;
            await db.query(
              `UPDATE profiles SET home_location =
                 ST_SetSRID(ST_MakePoint(78.50 + $2 * 0.002, 17.40), 4326)::geography WHERE id = $1`,
              [student.id, nudge % 50],
            );
            const t = Date.now();
            const r = await fetch(stopUrl, {
              headers: { authorization: `Bearer ${student.token}` },
            });
            const body = (await r.json().catch(() => ({}))) as { walk?: unknown };
            return { ms: Date.now() - t, status: r.status, walk: !!body.walk };
          };
          const baseline = await timed();
          // flat out: long car routes with alternatives, and long walks, 96 clients each
          log("chaos: flooding OSRM car + foot");
          let flooding = true;
          let floodReqs = 0;
          const hammer = (url: string) => async () => {
            while (flooding) {
              await fetch(url).then(
                (r) => r.arrayBuffer(),
                () => undefined,
              );
              floodReqs++;
            }
          };
          const carUrl = `${env.osrmCarUrl}/route/v1/driving/78.30,17.30;78.65,17.55?overview=full&steps=true&alternatives=3`;
          const footUrl = env.osrmFootUrl
            ? `${env.osrmFootUrl}/route/v1/foot/78.32,17.31;78.62,17.52?overview=full&steps=true&alternatives=3`
            : null;
          const flood = [
            ...Array.from({ length: 96 }, () => hammer(carUrl)),
            ...(footUrl ? Array.from({ length: 96 }, () => hammer(footUrl)) : []),
          ].map((f) => f());
          await sleep(3000); // let the queues build
          const during: { ms: number; status: number; walk: boolean }[] = [];
          const hz: number[] = [];
          const t0 = Date.now();
          while (Date.now() - t0 < 60_000) {
            during.push(await timed());
            const h = Date.now();
            await fetch(`${stack.gateway}/healthz`);
            hz.push(Date.now() - h);
            await sleep(2000);
          }
          const lagDuring = await worstLag(redis, keys);
          flooding = false;
          await Promise.all(flood);
          const after = await timed();
          const ms = during.map((d) => d.ms).sort((x, y) => x - y);
          return {
            floodRequests: floodReqs,
            stopPageBaseline: baseline,
            stopPageDuring: {
              probes: during.length,
              p50Ms: ms[Math.floor(ms.length / 2)],
              maxMs: ms.at(-1),
              statuses: [...new Set(during.map((d) => d.status))],
              withWalkingTime: during.filter((d) => d.walk).length,
            },
            stopPageAfter: after,
            gatewayHealthzMaxMs: Math.max(...hz),
            consumerLagDuring: lagDuring,
          };
        });

      // ── 5. the VAPID key is revoked (rotated after a leak) ────────────────
      case "vapid": {
        if (!env.vapidPublicKey) throw new Error("chaos vapid: set VAPID_PUBLIC_KEY in .env");
        const n = 50;
        const { users, admin } = await seedLoadUsers(db, {
          n,
          sinkUrl: `https://127.0.0.1:${SINK_PORT}`,
          jwtSecret: env.jwtSecret,
        });
        // the engine restarts with a new pair; every existing subscription was made with the old
        const fresh = JSON.parse(
          execFileSync(
            process.execPath,
            [
              "-e",
              "const w=require('web-push');console.log(JSON.stringify(w.generateVAPIDKeys()))",
            ],
            {
              cwd: new URL("../../../../packages/notify", import.meta.url).pathname,
            },
          ).toString(),
        ) as { publicKey: string; privateKey: string };
        log("chaos: engine restarted with a rotated VAPID key");
        await stack.kill("engine", "SIGTERM");
        await stack.startEngine({
          VAPID_PUBLIC_KEY: fresh.publicKey,
          VAPID_PRIVATE_KEY: fresh.privateKey,
        });
        const id = await announce(stack.gateway, admin, users, 1, "CHAOS-T1 vapid drill");
        await waitFor(
          "delivery finished",
          async () => {
            // every student recorded, and every transport attempt finished
            const r = await db.query<{ n: number; open: number }>(
              `SELECT count(*)::int AS n, count(*) FILTER (WHERE r.channel IS NULL)::int AS open
               FROM announcements a JOIN notification_recipients r ON r.notification_id = a.notification_id
              WHERE a.id = $1`,
              [id],
            );
            return r.rows[0]!.n === n && r.rows[0]!.open === 0;
          },
          60_000,
        );
        const rows = await db.query<{ channel: string; n: number }>(
          `SELECT r.channel::text AS channel, count(*)::int AS n
             FROM announcements a JOIN notification_recipients r ON r.notification_id = a.notification_id
            WHERE a.id = $1 GROUP BY 1`,
          [id],
        );
        const health = (await (
          await fetch(`${stack.gateway}/v1/admin/observability`, {
            headers: { authorization: `Bearer ${admin.token}` },
          })
        ).json()) as { alerts: { id: string; firing: boolean; summary: string }[] };
        const push = health.alerts.find((a) => a.id === "push_failures")!;
        // recovery: the old key back (the right answer when the rotation was a mistake)
        await stack.kill("engine", "SIGTERM");
        await stack.startEngine();
        return {
          students: n,
          refusedBySink: sink.stats.refused,
          channels: Object.fromEntries(rows.rows.map((r) => [r.channel, r.n])),
          notificationCenterRows: rows.rows.reduce((s, r) => s + r.n, 0),
          pushFailureAlert: push,
        };
      }
    }
  } finally {
    await stack.stop();
    await sink.close();
    await cleanLoadUsers(db).catch(() => undefined);
  }
}

async function announce(
  gateway: string,
  admin: LoadUser,
  users: LoadUser[],
  tier: number,
  title: string,
): Promise<string> {
  const headers = { "content-type": "application/json", authorization: `Bearer ${admin.token}` };
  const roll_nos = users.map((u) => u.roll);
  const res = await fetch(`${gateway}/v1/admin/announcements`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      tier,
      title,
      body_md: "Chaos drill — safe to ignore.",
      audience: "custom",
      roll_nos,
      confirm_count: users.length,
      ...(tier === 0 ? { confirm_text: String(users.length) } : {}),
    }),
  });
  if (res.status !== 201) throw new Error(`announce ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}
