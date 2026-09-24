import type { FastifyInstance } from "fastify";
import { ALERTS } from "@busmitra/config";
import { pipelineHealth } from "@busmitra/engine/health";
import type { Keys, Redis } from "@busmitra/redis";
import type { AppDeps } from "../../../app.ts";
import { requireAdmin } from "../../../plugins/auth.ts";
import { LATENCY_WINDOW_MS, type EventHub } from "../../stream/hub.ts";

/**
 * GET /v1/admin/observability — the console's view of the system's health (BUILD_PLAN Stage 8
 * "admin observability page"): the same numbers the Grafana dashboards chart, and the same
 * alert rules (`ALERTS`), computed on request so the TD needs no Grafana account to see them.
 *
 * Live figures come from Redis and this gateway's own fan-out window; history comes from the
 * aggregate-only `obs_*` views (0009) — no student row is read. The dead-zone polygons are the
 * map overlay.
 */

export interface Alert {
  id: "latency" | "consumer_lag" | "push_failures" | "dark_bus" | "dead_letters";
  firing: boolean;
  summary: string;
}

export async function adminObservabilityRoutes(
  app: FastifyInstance,
  deps: AppDeps & { redis: Redis; keys: Keys; hub: EventHub },
) {
  app.addHook("preHandler", requireAdmin(deps));

  app.get("/v1/admin/observability", async () => {
    const now = (deps.now ?? Date.now)();
    const [pipeline, streams, eta, etaToday, delivery, zones, outages] = await Promise.all([
      pipelineHealth(deps.redis, deps.keys, now),
      countKeys(deps.redis, deps.keys.sseConnAll),
      deps.db.query<{ route_name: string; horizon_s: number; n: number; mae_s: number }>(
        `SELECT route_name, horizon_s, sum(n)::int AS n,
                round(sum(mae_s * n)::numeric / nullif(sum(n), 0))::int AS mae_s
           FROM obs_eta_accuracy WHERE hour > now() - interval '7 days'
          GROUP BY 1, 2 ORDER BY 1, 2 DESC`,
      ),
      deps.db.query<{ hour: Date; n: number; mae_s: number }>(
        `SELECT hour, sum(n)::int AS n, round(sum(mae_s * n)::numeric / nullif(sum(n), 0))::int AS mae_s
           FROM obs_eta_accuracy
          WHERE horizon_s = 600 AND hour > now() - interval '24 hours'
          GROUP BY 1 ORDER BY 1`,
      ),
      deps.db.query<{
        channel: string;
        recipients: number;
        delivered: number;
        failed: number;
        pending: number;
      }>(
        `SELECT channel, sum(recipients)::int AS recipients, sum(delivered)::int AS delivered,
                sum(failed)::int AS failed, sum(pending)::int AS pending
           FROM obs_notification_delivery WHERE hour > now() - interval '24 hours'
          GROUP BY 1 ORDER BY 2 DESC`,
      ),
      deps.db.query(
        `SELECT id, label, sample_count, avg_outage_s, p90_outage_s, confidence, last_observed_at,
                learned_at, outages_14d, polygon
           FROM obs_dead_zones WHERE retired_at IS NULL ORDER BY sample_count DESC`,
      ),
      deps.db.query<{ in_known_zone: boolean; outages: number; avg_s: number | null }>(
        `SELECT in_known_zone, sum(outages)::int AS outages,
                round(sum(avg_s * outages)::numeric / nullif(sum(outages), 0))::int AS avg_s
           FROM obs_signal_outages WHERE day > now() - interval '14 days' AND recovered
          GROUP BY 1`,
      ),
    ]);
    // push refusals in the last hour, from the recipients' own record of what happened: a push
    // failure is noted in failure_reason even when SMS then carried the alert
    const push = await deps.db.query<{ ok: number; refused: number }>(
      `SELECT count(*) FILTER (WHERE channel = 'push')::int AS ok,
              count(*) FILTER (WHERE channel <> 'push' AND failure_reason ~ '(^|; )push [0-9n]')::int AS refused
         FROM notification_recipients
        WHERE sent_at > now() - interval '1 hour'`,
    );
    const latency = deps.hub.pingToFrame.snapshot(now);
    const pushOk = push.rows[0]?.ok ?? 0;
    const pushRefused = push.rows[0]?.refused ?? 0;
    const pushRate = pushOk + pushRefused ? pushRefused / (pushOk + pushRefused) : null;
    const worstLag = pipeline.groups.reduce((m, g) => Math.max(m, g.lag ?? 0), 0);

    const alerts: Alert[] = [
      {
        id: "latency",
        // the window is five minutes, so its p95 is the sustained figure the rule asks for
        firing: latency.n >= 20 && (latency.p95 ?? 0) > ALERTS.PING_TO_FRAME_P95_S,
        summary: `p95 fix → frame ${latency.p95?.toFixed(1) ?? "—"} s over ${LATENCY_WINDOW_MS / 60_000} min (limit ${ALERTS.PING_TO_FRAME_P95_S} s)`,
      },
      {
        id: "consumer_lag",
        firing: worstLag > ALERTS.CONSUMER_LAG,
        summary: `worst consumer lag ${worstLag} (limit ${ALERTS.CONSUMER_LAG})`,
      },
      {
        id: "push_failures",
        firing: pushOk + pushRefused >= 20 && (pushRate ?? 0) > ALERTS.PUSH_FAILURE_RATE,
        summary:
          pushRate === null
            ? "no push sent in the last hour"
            : `${Math.round(pushRate * 100)}% of pushes refused in the last hour (limit ${ALERTS.PUSH_FAILURE_RATE * 100}%)`,
      },
      {
        id: "dark_bus",
        firing: pipeline.fleet.darkTooLong.length > 0,
        summary: `${pipeline.fleet.darkTooLong.length} bus(es) silent ${ALERTS.DARK_S / 60}+ min on an open trip`,
      },
      {
        id: "dead_letters",
        firing: pipeline.deadLetters > ALERTS.DEAD_LETTERS,
        summary: `${pipeline.deadLetters} ping(s) the persister could not write`,
      },
    ];

    return {
      serverTime: new Date(now).toISOString(),
      alerts,
      live: {
        pingToFrame: { ...latency, windowS: LATENCY_WINDOW_MS / 1000 },
        streams: { total: streams, thisInstance: deps.hub.size },
        groups: pipeline.groups,
        deadLetters: pipeline.deadLetters,
        fleet: pipeline.fleet,
      },
      eta: { byRoute: eta.rows, today: etaToday.rows },
      delivery: { last24h: delivery.rows, pushLastHour: { ok: pushOk, refused: pushRefused } },
      deadZones: { zones: zones.rows, outages14d: outages.rows },
    };
  });
}

/** Count keys matching a registry pattern (SCAN, never KEYS: it must not block Redis). */
async function countKeys(redis: Redis, match: string): Promise<number> {
  let cursor = "0";
  let n = 0;
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", match, "COUNT", 1000);
    cursor = next;
    n += batch.length;
  } while (cursor !== "0");
  return n;
}
