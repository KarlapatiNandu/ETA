import { withContext, type Db } from "@busmitra/db";
import { listRoutes, loadRoute, type LoadedRoute } from "@busmitra/engine/routes";
import { provisionTracker } from "@busmitra/gateway/trackers";
import { readFleet, type Keys, type Redis } from "@busmitra/redis";
import { callWithRetry, sendBatch, trackerClient, type TrackerClient } from "./client.ts";
import { deadZonesFor, routeZoneSeed } from "./deadzone.ts";
import { simulateTrip, type SimOptions } from "./model.ts";

/**
 * N buses, real time, through the real gateway (BUILD_PLAN Stage 1 exit "simulator drives 30
 * buses on real routes with injected noise and dead zones", and Stage 2's one-hour ingest run).
 *
 * Every distinct fix is recorded in a manifest with the time it was first sent, so the
 * verifier can prove afterwards that `positions` holds exactly those rows — none dropped,
 * none duplicated — and that the ones flushed late are flagged as backfill.
 */

export interface RunOptions {
  gateway: string;
  buses: number;
  minutes: number;
  seed: number;
  trackerKey: string;
  deadZones: boolean;
  faults: boolean;
  /** airplane mode: bus index (1-based) offline from minute a to minute b of its first trip */
  airplane: { bus: number; fromMin: number; toMin: number }[];
  /** seconds between bus starts */
  staggerS: number;
  log: (msg: string) => void;
}

export interface TripManifest {
  bus: string;
  busId: string;
  tripId: string;
  route: string;
  /** recorded_at → first send time (epoch ms) */
  fixes: Record<string, number>;
}

export interface RunReport {
  startedAt: string;
  endedAt: string;
  buses: number;
  trips: TripManifest[];
  batchesSent: number;
  duplicateBatchesSent: number;
  flushBatchesSent: number;
  fixesSent: number;
  accepted: number;
  rejected: number;
  retries: number;
  failedBatches: string[];
  /** fleet:live entries that moved backwards in time while being watched (must be 0) */
  fleetRegressions: number;
  fleetSamples: number;
}

const sleepUntil = (at: number) => new Promise((r) => setTimeout(r, Math.max(0, at - Date.now())));

export async function provisionFleet(db: Db, key: string, n: number) {
  const ctx = { actorId: null, ip: null, userAgent: "simulator" };
  const fleet: { bus: string; busId: string; client: (gw: string) => TrackerClient }[] = [];
  for (let i = 1; i <= n; i++) {
    const bus = `SIM-${String(i).padStart(2, "0")}`;
    const uid = `sim-${String(i).padStart(2, "0")}`;
    const t = await withContext(db, ctx, (q) =>
      provisionTracker(q, key, { busNumber: bus, deviceUid: uid }),
    );
    fleet.push({ bus, busId: t.busId, client: (gw) => trackerClient(gw, uid, t.secret) });
  }
  return fleet;
}

export async function runFleet(
  db: Db,
  redis: Redis,
  keys: Keys,
  o: RunOptions,
): Promise<RunReport> {
  const published = (await listRoutes(db)).filter(
    (r) => r.published_at && !r.archived_at && r.stop_count >= 2,
  );
  if (!published.length) throw new Error("no published routes — run `sim seed` first");
  const routes = (await Promise.all(published.map((r) => loadRoute(db, r.id)))).filter(
    (r): r is LoadedRoute => r !== null,
  );
  const names = new Map(published.map((r) => [r.id, r.name]));
  const fleet = await provisionFleet(db, o.trackerKey, o.buses);
  // close any trip a previous run left open on these buses, so every trip in this run is new
  // and the verifier compares like with like
  const closed = await db.query(
    `UPDATE trips SET status = 'completed', ended_at = now()
      WHERE bus_id = ANY($1) AND status IN ('scheduled', 'running', 'dark') RETURNING id`,
    [fleet.map((f) => f.busId)],
  );
  if (closed.rows.length) o.log(`closed ${closed.rows.length} trip(s) left open by an earlier run`);
  const start = Date.now() + 2000;
  const end = start + o.minutes * 60_000;
  const report: RunReport = {
    startedAt: new Date(start).toISOString(),
    endedAt: "",
    buses: o.buses,
    trips: [],
    batchesSent: 0,
    duplicateBatchesSent: 0,
    flushBatchesSent: 0,
    fixesSent: 0,
    accepted: 0,
    rejected: 0,
    retries: 0,
    failedBatches: [],
    fleetRegressions: 0,
    fleetSamples: 0,
  };
  o.log(`sim: ${o.buses} buses on ${routes.length} routes for ${o.minutes} min`);

  // watch fleet:live the whole time: a backfill must never move a bus's entry back in time
  let watching = true;
  const busIds = new Set(fleet.map((f) => f.busId));
  const watcher = (async () => {
    const lastTs = new Map<string, string>();
    while (watching) {
      const live = await readFleet(redis, keys).catch(() => ({}));
      for (const [busId, e] of Object.entries(live)) {
        if (!busIds.has(busId)) continue;
        report.fleetSamples++;
        const prev = lastTs.get(busId);
        if (prev && e.ts < prev) report.fleetRegressions++;
        if (!prev || e.ts > prev) lastTs.set(busId, e.ts);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  })();

  const drive = async (i: number) => {
    const { bus, busId } = fleet[i]!;
    const client = fleet[i]!.client(o.gateway);
    const route = routes[i % routes.length]!;
    let tripNo = 0;
    await sleepUntil(start + i * o.staggerS * 1000);
    while (Date.now() < end - 60_000) {
      tripNo++;
      const started = await callWithRetry<{ trip_id: string; error?: string }>(
        client,
        "POST",
        "/v1/tracker/trips",
        { route_id: route.id },
      );
      if (!started || started.status !== 200) {
        report.failedBatches.push(
          `${bus}: trip start ${started?.status ?? "unreachable"} ${started?.json.error ?? ""}`,
        );
        return;
      }
      const tripId = started.json.trip_id;
      const t0 = Date.now() + 1000;
      const air = o.airplane
        .filter((a) => a.bus === i + 1 && tripNo === 1)
        .map((a) => [a.fromMin * 60_000, a.toMin * 60_000] as [number, number]);
      const opts: SimOptions = {
        seed: o.seed * 7919 + i * 131 + tripNo,
        t0,
        stops: route.stops.map((s) => s.offset),
        // a route's zones are places: every bus on the route goes quiet at the same spots,
        // so the Stage 8 learner has something that recurs
        deadZones: o.deadZones
          ? deadZonesFor(route.route, routeZoneSeed(route.lineageId, o.seed))
          : [],
        offline: air,
        dupRate: o.faults ? 0.02 : 0,
        reorderRate: o.faults ? 0.02 : 0,
        offRoute:
          o.faults && i % 7 === 3
            ? [{ atS: route.route.total * 0.5, durationS: 45, offsetM: 180 }]
            : [],
      };
      const sim = simulateTrip(route.route, opts);
      const manifest: TripManifest = {
        bus,
        busId,
        tripId,
        route: names.get(route.id) ?? route.id,
        fixes: {},
      };
      report.trips.push(manifest);
      for (const b of sim.batches) {
        if (b.sendAt > end) break; // the run is over; unsent fixes are not expected anywhere
        await sleepUntil(b.sendAt);
        const out = await sendBatch(client, {
          device_uid: client.deviceUid,
          trip_id: tripId,
          cadence_s: b.cadenceS,
          pings: b.pings,
        });
        report.batchesSent++;
        if (b.kind === "duplicate") report.duplicateBatchesSent++;
        if (b.kind === "flush") report.flushBatchesSent++;
        report.retries += out.attempts - 1;
        report.accepted += out.accepted;
        report.rejected += out.rejected.length;
        if (!out.delivered) {
          report.failedBatches.push(`${bus} ${b.pings[0]!.recorded_at}: ${out.fatal}`);
          continue;
        }
        const sentAt = Date.now();
        for (const p of b.pings) {
          if (!(p.recorded_at in manifest.fixes)) {
            manifest.fixes[p.recorded_at] = sentAt;
            report.fixesSent++;
          }
        }
      }
      await callWithRetry(client, "POST", `/v1/tracker/trips/${tripId}/end`, {});
      await new Promise((r) => setTimeout(r, 20_000)); // turnaround before the next run
    }
  };

  // one bus's trouble is recorded, never fatal to the run
  await Promise.all(
    fleet.map((_, i) =>
      drive(i).catch((err) =>
        report.failedBatches.push(`${fleet[i]!.bus}: ${(err as Error).message}`),
      ),
    ),
  );
  watching = false;
  await watcher;
  report.endedAt = new Date().toISOString();
  return report;
}
