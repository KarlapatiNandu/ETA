/**
 * The simulator CLI (BUILD_PLAN Stage 1). Needs the dev stack (`pnpm dev`) running.
 *
 *   pnpm sim seed                          # 8 routes on real roads, via the real pipeline
 *   pnpm sim run --buses 30 --minutes 60   # the Stage 2 one-hour ingest run, then verify
 *   pnpm sim run --buses 3 --minutes 12 --airplane 2:3:6   # bus 2 offline minutes 3–6
 *   pnpm sim replay tests/fixtures/traces/<file>.json      # a recorded trace, through the gateway
 *   pnpm sim watch --minutes 14 --cut SIM-03,SIM-07        # judge presence transitions (Stage 3)
 *   pnpm sim eta-report --since 2026-09-23T14:00Z [--bus SIM-]   # ETA accuracy per horizon (Stage 5)
 *   pnpm sim deadzone-check [--learn] [--seed N]   # learned zones vs injected ones (Stage 8)
 *
 * Flags: --seed N (default 1), --no-dead-zones, --no-faults, --stagger S (seconds between bus
 * starts, default 10), --out report.json, --gateway URL.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { z } from "zod";
import { coreEnv, EnvError, gatewayEnv, loadEnv, redisEnv } from "@busmitra/config";
import { createPgDb } from "@busmitra/db";
import { createOsrm } from "@busmitra/engine/osrm";
import { learnDeadZones } from "@busmitra/engine/deadzone";
import { listRoutes } from "@busmitra/engine/routes";
import { createRedis, keys } from "@busmitra/redis";
import { sendBatch } from "./client.ts";
import { replayTrace } from "./model.ts";
import { verifyDeadZones } from "./deadzone.ts";
import { etaReport } from "./eta-report.ts";
import { watchPresence } from "./presence-watch.ts";
import { provisionFleet, runFleet } from "./run.ts";
import { seedRoutes } from "./seed.ts";
import { verifyRun, waitForDrain } from "./verify.ts";

let env;
try {
  env = loadEnv(
    coreEnv
      .and(z.object({ DATABASE_URL: z.url(), OSRM_CAR_URL: z.url() }))
      .and(redisEnv)
      .and(gatewayEnv.pick({ TRACKER_SECRET_KEY: true, GATEWAY_PORT: true })),
  );
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    buses: { type: "string", default: "30" },
    minutes: { type: "string", default: "60" },
    seed: { type: "string", default: "1" },
    stagger: { type: "string", default: "10" },
    airplane: { type: "string", multiple: true, default: [] },
    "no-dead-zones": { type: "boolean", default: false },
    "no-faults": { type: "boolean", default: false },
    out: { type: "string" },
    gateway: { type: "string" },
    cut: { type: "string", default: "" },
    since: { type: "string" },
    learn: { type: "boolean", default: false },
    bus: { type: "string" },
  },
});
const gateway = values.gateway ?? `http://127.0.0.1:${env.GATEWAY_PORT}`;
const db = createPgDb(env.DATABASE_URL);
const redis = createRedis(env.REDIS_URL, "simulator");
const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);

try {
  const cmd = positionals[0];
  if (cmd === "seed") {
    const res = await seedRoutes(db, createOsrm(env.OSRM_CAR_URL), log);
    for (const r of res.filter((x) => x.skipped)) log(`${r.name}: ${r.skipped}`);
  } else if (cmd === "run") {
    const report = await runFleet(db, redis, keys, {
      gateway,
      buses: Number(values.buses),
      minutes: Number(values.minutes),
      seed: Number(values.seed),
      trackerKey: env.TRACKER_SECRET_KEY,
      deadZones: !values["no-dead-zones"],
      faults: !values["no-faults"],
      staggerS: Number(values.stagger),
      airplane: values.airplane.map((a) => {
        const [bus, fromMin, toMin] = a.split(":").map(Number);
        return { bus: bus!, fromMin: fromMin!, toMin: toMin! };
      }),
      log,
    });
    log(
      `sent ${report.fixesSent} fixes in ${report.batchesSent} batches (${report.duplicateBatchesSent} duplicates, ${report.flushBatchesSent} flushes); waiting for the persister`,
    );
    const drained = await waitForDrain(redis, keys);
    const verdict = await verifyRun(db, report);
    const { trips, ...summary } = report;
    const out = {
      summary: { ...summary, trips: trips.length, drained },
      verdict: { ...verdict, perTrip: undefined },
    };
    console.log(JSON.stringify(out, null, 2));
    if (values.out)
      writeFileSync(values.out, JSON.stringify({ ...out, perTrip: verdict.perTrip }, null, 2));
    process.exitCode = verdict.ok && drained ? 0 : 1;
  } else if (cmd === "eta-report") {
    const rows = await etaReport(db, {
      since: values.since ?? new Date(Date.now() - 24 * 3600_000).toISOString(),
      busPrefix: values.bus,
    });
    console.log(JSON.stringify(rows, null, 2));
    if (values.out) writeFileSync(values.out, JSON.stringify(rows, null, 2));
  } else if (cmd === "deadzone-check") {
    // run the nightly learner now (it is idempotent), then compare with what the runs injected
    if (values.learn) log(`learned: ${JSON.stringify(await learnDeadZones(db))}`);
    const verdict = await verifyDeadZones(db, { seed: Number(values.seed) });
    console.log(JSON.stringify(verdict, null, 2));
    if (values.out) writeFileSync(values.out, JSON.stringify(verdict, null, 2));
    process.exitCode = verdict.ok ? 0 : 1;
  } else if (cmd === "watch") {
    const verdict = await watchPresence(redis, keys, db, {
      minutes: Number(values.minutes),
      cutOff: values.cut.split(",").filter(Boolean),
      log,
    });
    console.log(JSON.stringify({ ...verdict, transitions: verdict.transitions }, null, 2));
    if (values.out) writeFileSync(values.out, JSON.stringify(verdict, null, 2));
    process.exitCode = verdict.ok ? 0 : 1;
  } else if (cmd === "replay" && positionals[1]) {
    const trace = JSON.parse(readFileSync(positionals[1], "utf8"));
    const route = (await listRoutes(db)).find((r) => r.published_at && !r.archived_at);
    if (!route) throw new Error("no published route — run `sim seed` first");
    const [bus] = await provisionFleet(db, env.TRACKER_SECRET_KEY, 1);
    const client = bus!.client(gateway);
    const trip = await client.call<{ trip_id: string }>("POST", "/v1/tracker/trips", {
      route_id: route.id,
    });
    const sim = replayTrace(trace, Date.now() + 1000);
    for (const b of sim.batches) {
      await new Promise((r) => setTimeout(r, Math.max(0, b.sendAt - Date.now())));
      const res = await sendBatch(client, {
        device_uid: client.deviceUid,
        trip_id: trip.json.trip_id,
        cadence_s: b.cadenceS,
        pings: b.pings,
      });
      log(`batch of ${b.pings.length}: ${res.delivered ? `accepted ${res.accepted}` : res.fatal}`);
    }
    await client.call("POST", `/v1/tracker/trips/${trip.json.trip_id}/end`, {});
  } else {
    console.error(
      "usage: sim seed | sim run [--buses N --minutes M ...] | sim replay <trace.json>",
    );
    process.exitCode = 2;
  }
} finally {
  await db.close();
  redis.disconnect();
}
