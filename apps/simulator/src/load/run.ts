import { spawn } from "node:child_process";
import { createWriteStream, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "@busmitra/db";
import { groupInfo, type Keys, type Redis } from "@busmitra/redis";
import { runFleet } from "../run.ts";
import { startPushSink } from "./push-sink.ts";
import { cleanLoadUsers, seedLoadUsers } from "./seed.ts";
import { makeCerts, ROOT, RUN_DIR, sleep, Stack } from "./stack.ts";

/**
 * `pnpm sim load` — the Stage 8 load run (BUILD_PLAN: "k6: 600 SSE + 30 ingest + T0 broadcast;
 * 1,000 headroom"). One command, one controlled stack:
 *
 *   1. a throwaway CA and an HTTPS push sink standing in for FCM (realistic latency)
 *   2. N synthetic students, each with a token and a push subscription at the sink
 *   3. its own gateway and engine (so the engine trusts the sink's CA, and telemetry is on when
 *      asked) — `pnpm dev` must be stopped first: two engines would split every consumer group
 *   4. the simulator's 30 buses through the real ingest path, faults and dead zones included
 *   5. k6 in Docker holding N SSE streams, measuring frame age on arrival
 *   6. one T0 announcement to everyone, part-way through
 *   7. consumer lag sampled every 2 s, the whole time
 *
 * then a report: frame-age percentiles, T0 delivery (SSE frames, pushes at the sink, rows in the
 * notification center), duplicates, lag growth. LOCAL ONLY.
 */

export interface LoadOptions {
  clients: number;
  minutes: number;
  buses: number;
  seed: number;
  gatewayPort: number;
  trackerKey: string;
  jwtSecret: string;
  databaseUrl: string;
  /** export OTel to this OTLP endpoint (the local Grafana stack) */
  otlp?: string;
  keepUsers?: boolean;
  log: (m: string) => void;
}

const SINK_PORT = 4700;
const RAMP_S = 60;

export interface LagSample {
  t: number;
  worst: number;
  byGroup: Record<string, number>;
}

export async function runLoad(db: Db, redis: Redis, keys: Keys, o: LoadOptions) {
  const dbHost = new URL(o.databaseUrl).hostname;
  if (!["127.0.0.1", "localhost"].includes(dbHost)) {
    throw new Error("load: refusing to seed synthetic users into a non-local database");
  }
  const certs = makeCerts();
  const stack = new Stack({
    gatewayPort: o.gatewayPort,
    env: {
      NODE_EXTRA_CA_CERTS: certs.ca,
      ...(o.otlp
        ? { OTEL_EXPORTER_OTLP_ENDPOINT: o.otlp, OTEL_METRIC_EXPORT_INTERVAL: "5000" }
        : {}),
    },
  });
  const gw = stack.gateway;
  await Stack.assertFree(gw);
  const sink = startPushSink({ port: SINK_PORT, keyFile: certs.key, certFile: certs.cert });

  try {
    o.log(`load: seeding ${o.clients} students`);
    const { users, admin } = await seedLoadUsers(db, {
      n: o.clients,
      sinkUrl: `https://127.0.0.1:${SINK_PORT}`,
      jwtSecret: o.jwtSecret,
    });
    writeFileSync(
      join(RUN_DIR, "tokens.json"),
      JSON.stringify(users.map((u) => ({ token: u.token }))),
    );

    await stack.startGateway();
    await stack.startEngine();
    o.log("load: stack up");

    // the fleet runs for the whole test, starting a minute before the students
    const totalMin = Math.ceil(RAMP_S / 60) + o.minutes + 2;
    const fleet = runFleet(db, redis, keys, {
      gateway: gw,
      buses: o.buses,
      minutes: totalMin,
      seed: o.seed,
      trackerKey: o.trackerKey,
      deadZones: true,
      faults: true,
      staggerS: 2,
      airplane: [],
      log: (m) => o.log(`fleet: ${m}`),
    });
    await sleep(45_000); // buses on the road before anyone opens the app

    const lag: LagSample[] = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const groups = (
          await Promise.all(
            [keys.streamPings, keys.streamEvents, keys.streamNotify].map((s) =>
              groupInfo(redis, s),
            ),
          )
        ).flat();
        const byGroup = Object.fromEntries(
          groups.map((g) => [`${g.stream.slice(keys.ns.length)}/${g.group}`, g.lag ?? 0]),
        );
        lag.push({ t: Date.now(), worst: Math.max(0, ...Object.values(byGroup)), byGroup });
        await sleep(2000);
      }
    })();

    o.log(`load: k6 — ${o.clients} streams for ${o.minutes} min`);
    const k6Started = Date.now();
    const k6 = spawn(
      "docker",
      [
        "run",
        "--rm",
        "--add-host=host.docker.internal:host-gateway",
        "-v",
        `${join(ROOT, "tests/load")}:/scripts`,
        "-e",
        `GATEWAY=http://host.docker.internal:${o.gatewayPort}`,
        "-e",
        `CLIENTS=${o.clients}`,
        "-e",
        `DURATION_S=${o.minutes * 60}`,
        "-e",
        `RAMP_S=${RAMP_S}`,
        "busmitra-k6",
        "run",
        "--quiet",
        "--summary-export",
        `/scripts/.run/k6-summary-${o.clients}.json`,
        "/scripts/sse.js",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const k6Log = createWriteStream(join(RUN_DIR, `k6-${o.clients}.log`));
    k6.stdout.pipe(k6Log);
    k6.stderr.pipe(k6Log);
    const k6Done = new Promise<number>((ok) => k6.on("exit", (c) => ok(c ?? -1)));

    // the T0: once everyone has connected, a third of the way into the steady state
    await sleep(Math.max(0, k6Started + (RAMP_S + 20 + (o.minutes * 60) / 3) * 1000 - Date.now()));
    const auth = { "content-type": "application/json", authorization: `Bearer ${admin.token}` };
    // addressed to the load students by roll number, so no real account (a developer's own
    // browser subscription from the Stage 6 run) is pushed or texted by a load test
    const audience = { audience: "custom", roll_nos: users.map((u) => u.roll) };
    const count = (
      (await (
        await fetch(`${gw}/v1/admin/audience`, {
          method: "POST",
          headers: auth,
          body: JSON.stringify(audience),
        })
      ).json()) as { count: number }
    ).count;
    const t0SentAt = Date.now();
    const pub = await fetch(`${gw}/v1/admin/announcements`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        tier: 0,
        title: "LOADTEST-T0 all buses delayed",
        body_md: "Load test broadcast — safe to ignore.",
        ...audience,
        confirm_count: count,
        confirm_text: String(count),
      }),
    });
    if (pub.status !== 201) throw new Error(`load: T0 refused ${pub.status} ${await pub.text()}`);
    const announcementId = ((await pub.json()) as { id: string }).id;
    o.log(`load: T0 sent to ${count} students`);
    // everyone is connected now: how many streams the gateway holds
    const atT0 = (await (
      await fetch(`${gw}/v1/admin/observability`, { headers: auth })
    ).json()) as { live: { streams: { total: number } } };

    // the gateway's own fan-out window (5 min, on the fixes' clock) just before the students leave
    await sleep(Math.max(0, k6Started + (RAMP_S + o.minutes * 60 - 15) * 1000 - Date.now()));
    const gatewayView = (await (
      await fetch(`${gw}/v1/admin/observability`, { headers: auth })
    ).json()) as {
      live: { pingToFrame: unknown; streams: unknown };
      alerts: { id: string; firing: boolean }[];
    };

    const k6Exit = await k6Done;
    sampling = false;
    await sampler;
    await fleet.catch((e) => o.log(`fleet: ${(e as Error).message}`));

    // ── what arrived ─────────────────────────────────────────────────────────
    const loadIds = new Set(users.map((u) => u.id));
    const pushes = Object.entries(sink.stats.perEndpoint).filter(([id]) => loadIds.has(id));
    const pushTimes = pushes
      .map(([id]) => sink.stats.firstAt[id]! - t0SentAt)
      .sort((a, b) => a - b);
    const center = await db.query<{
      recipients: number;
      attempted: number;
      pushed: number;
    }>(
      `SELECT count(*)::int AS recipients, count(r.sent_at)::int AS attempted,
              count(*) FILTER (WHERE r.channel = 'push')::int AS pushed
         FROM announcements a JOIN notifications n ON n.id = a.notification_id
         JOIN notification_recipients r ON r.notification_id = n.id
        WHERE a.id = $1`,
      [announcementId],
    );
    const summary = JSON.parse(
      readFileSync(join(RUN_DIR, `k6-summary-${o.clients}.json`), "utf8"),
    ) as { metrics: Record<string, Record<string, number>> };
    const m = summary.metrics;
    const third = Math.floor(lag.length / 3);
    const mean = (xs: LagSample[]) => xs.reduce((s, x) => s + x.worst, 0) / Math.max(1, xs.length);
    const pct = (xs: number[], p: number) =>
      xs[Math.min(xs.length - 1, Math.ceil(p * xs.length) - 1)];

    return {
      at: new Date(k6Started).toISOString(),
      clients: o.clients,
      minutes: o.minutes,
      buses: o.buses,
      k6Exit,
      streams: {
        opened: m.stream_opened?.value ?? null,
        errors: m.stream_errors?.count ?? 0,
        frames: m.frames?.count ?? 0,
      },
      // authoritative: measured by the gateway on the same clock as the fixes
      gatewayPingToFrameS: gatewayView.live.pingToFrame,
      streamsAtT0: atT0.live.streams.total,
      alertsFiring: gatewayView.alerts.filter((a) => a.firing).map((a) => a.id),
      // cross-check: measured in k6, corrected by the stream.ready clock offset (±1 s)
      clientFrameAgeMs: m.frame_age_ms ?? null,
      t0: {
        audience: count,
        loadStudents: o.clients,
        sseFramesReceived: m.t0_received?.count ?? 0,
        // the frame's arrival (gateway clock, via the stream.ready offset) after the POST was sent
        sseFrameAfterSendMs: m.t0_at_ms
          ? {
              p50: Math.round(m.t0_at_ms.med! - t0SentAt),
              p95: Math.round(m.t0_at_ms["p(95)"]! - t0SentAt),
              max: Math.round(m.t0_at_ms.max! - t0SentAt),
            }
          : null,
        pushesAtSink: pushes.length,
        duplicatePushes: pushes.filter(([, n]) => n > 1).length,
        pushAfterSendMs: {
          p50: pct(pushTimes, 0.5) ?? null,
          p95: pct(pushTimes, 0.95) ?? null,
          last: pushTimes.at(-1) ?? null,
        },
        notificationCenter: center.rows[0] ?? null,
      },
      lag: {
        samples: lag.length,
        max: Math.max(0, ...lag.map((l) => l.worst)),
        firstThirdMean: Math.round(mean(lag.slice(0, third))),
        lastThirdMean: Math.round(mean(lag.slice(-third))),
        final: lag.at(-1)?.byGroup ?? {},
      },
    };
  } finally {
    await stack.stop();
    await sink.close();
    await sleep(1500);
    if (!o.keepUsers) await cleanLoadUsers(db).catch(() => undefined);
  }
}
