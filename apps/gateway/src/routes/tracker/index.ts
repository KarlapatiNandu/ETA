import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  SurveyUpload,
  TripStart,
  type StreamTripEnd,
  type SurveyAccepted,
  type TrackerMe,
  type TripStarted,
} from "@busmitra/contracts";
import type { Db } from "@busmitra/db";
import { appendEntries, ringNotify, STREAMS, type Keys, type Redis } from "@busmitra/redis";
import { traceparentOfSpan } from "@busmitra/telemetry";
import { deviceAuth } from "../../plugins/device-auth.ts";
import type { FileStore } from "../../services/files.ts";
import type { TrackerDirectory } from "../../services/trackers.ts";
import { endTrip, startTrip, type TripDirectory } from "../../services/trips.ts";

export interface TrackerRouteDeps {
  db: Db;
  trackers: TrackerDirectory;
  trips: TripDirectory;
  redis: Redis;
  keys: Keys;
  surveyFiles: FileStore;
  now?: () => number;
}

/**
 * The driver app's control plane (Stages 1–2), signed exactly like ingest. These are ordinary
 * database reads and writes — unlike /v1/ingest they are rare (a handful per trip) and a
 * driver who cannot start a trip while Postgres is down gets a clear error, not silent loss.
 */
export async function trackerRoutes(app: FastifyInstance, deps: TrackerRouteDeps) {
  deviceAuth(app, deps, { bodyLimit: 5 * 1024 * 1024 });
  const needBus = (busId: string | null) => {
    if (!busId) {
      throw Object.assign(new Error("This phone is not paired to a bus yet."), { statusCode: 409 });
    }
    return busId;
  };

  app.get("/v1/tracker/me", async (req): Promise<TrackerMe> => {
    const d = req.device;
    const bus = d.busId
      ? (
          await deps.db.query<{ id: string; bus_number: string; default_route_id: string | null }>(
            `SELECT id, bus_number, default_route_id FROM buses WHERE id = $1`,
            [d.busId],
          )
        ).rows[0]
      : undefined;
    const routes = await deps.db.query<TrackerMe["routes"][number]>(
      `SELECT id, name, direction::text AS direction, version FROM routes
        WHERE published_at IS NOT NULL AND archived_at IS NULL
        ORDER BY (id = $1) DESC, name, direction`,
      [bus?.default_route_id ?? null],
    );
    const live = d.busId
      ? (
          await deps.db.query<{ id: string; route_id: string; started_at: Date | null }>(
            `SELECT id, route_id, started_at FROM trips
              WHERE bus_id = $1 AND status IN ('scheduled','running','dark')`,
            [d.busId],
          )
        ).rows[0]
      : undefined;
    return {
      device_uid: d.deviceUid,
      bus: bus ? { id: bus.id, bus_number: bus.bus_number } : null,
      routes: routes.rows.map((r) => ({ ...r, version: Number(r.version) })),
      default_route_id: bus?.default_route_id ?? null,
      live_trip: live
        ? {
            id: live.id,
            route_id: live.route_id,
            started_at: new Date(live.started_at ?? Date.now()).toISOString(),
          }
        : null,
      server_time: new Date((deps.now ?? Date.now)()).toISOString(),
    };
  });

  const emitEnd = async (end: Omit<StreamTripEnd, "kind">) => {
    // ordered with the pings, so the geo worker sees the end after the trip's last fix
    await appendEntries(
      deps.redis,
      deps.keys.streamPings,
      [{ kind: "trip_end", ...end }],
      STREAMS.PINGS_MAXLEN,
    );
    deps.trips.forget(end.trip_id);
  };

  app.post("/v1/tracker/trips", async (req): Promise<TripStarted> => {
    const { route_id } = TripStart.parse(req.body);
    const busId = needBus(req.device.busId);
    const started = await startTrip(deps.db, busId, route_id);
    if (started.closed) {
      await emitEnd({
        trip_id: started.closed.tripId,
        bus_id: busId,
        route_id: started.closed.routeId,
        at: new Date().toISOString(),
      });
    }
    deps.trips.forget(started.tripId);
    if (!started.resumed) {
      // favourites are told the bus has started (Stage 6). Best effort: the trip has started
      // whether or not the doorbell rings, and a force-quit-and-reopen resumes silently
      await ringNotify(
        deps.redis,
        deps.keys,
        [{ type: "trip_start", tripId: started.tripId, busId, at: started.startedAt }],
        req.span ? traceparentOfSpan(req.span) : undefined,
      ).catch((err) => req.log.error({ err }, "trip_start doorbell failed"));
    }
    return {
      trip_id: started.tripId,
      route_id: started.routeId,
      resumed: started.resumed,
      started_at: started.startedAt,
    };
  });

  app.post("/v1/tracker/trips/:id/end", async (req) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const busId = needBus(req.device.busId);
    const ended = await endTrip(deps.db, busId, id);
    if (!ended.alreadyEnded) {
      await emitEnd({ trip_id: id, bus_id: busId, route_id: ended.routeId, at: ended.endedAt });
    }
    return { trip_id: id, status: "completed", ended_at: ended.endedAt };
  });

  /** Survey mode: the raw 1 Hz trace goes to storage untouched; matching is an admin action. */
  app.post("/v1/survey", async (req, reply): Promise<SurveyAccepted | void> => {
    const body = SurveyUpload.parse(req.body);
    const times = body.points.map((p) => Date.parse(p.t));
    const path = `surveys/${randomUUID()}.json`;
    await deps.surveyFiles.put(path, JSON.stringify(body), "application/json");
    const { rows } = await deps.db.query<{ id: string }>(
      `INSERT INTO route_surveys (tracker_id, bus_id, label, started_at, ended_at, point_count, file_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        req.device.trackerId,
        req.device.busId,
        body.label ?? null,
        new Date(Math.min(...times)).toISOString(),
        new Date(Math.max(...times)).toISOString(),
        body.points.length,
        path,
      ],
    );
    reply.code(201);
    return { survey_id: rows[0]!.id, point_count: body.points.length };
  });
}
