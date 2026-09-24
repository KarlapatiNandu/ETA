import { createHash } from "node:crypto";
import type { BusAtStop, StopResult, StopSearchResponse } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import { readFleet, TTL, type Keys, type Redis } from "@busmitra/redis";
import type { Geocoder } from "./geocoder.ts";

/**
 * Stop search — the "Dilsukhnagar" requirement (BUILD_PLAN Stage 5):
 *
 *   query → pg_trgm over name + aliases + area_name     (so "dilsuknagar" finds "Dilsukhnagar")
 *         → if the best similarity < 0.4, geocode the text with Photon (a locality, not a stop)
 *         → every stop within 2 km of the best stop or the geocoded place
 *         → rank: text matches by similarity, then nearby stops by distance
 *         → per stop: the buses that serve it, running / passed / scheduled / not running today
 *
 * The *matching* is cached for five minutes in Redis (`search:stops:{hash}`); the buses are
 * joined fresh on every request, because a five-minute-old ETA is not an ETA.
 */

export const SEARCH = {
  /** below this a text match is noise */
  TEXT_MIN: 0.3,
  /** below this the text is probably a place, not a stop: ask the geocoder */
  AREA_FALLBACK: 0.4,
  /** with a strong match, other text hits must score within this of it */
  TEXT_BAND: 0.3,
  RADIUS_M: 2000,
  LIMIT: 25,
} as const;

export interface SearchDeps {
  db: Queryable;
  redis?: Redis;
  keys?: Keys;
  geocoder?: Geocoder;
}

interface Hit {
  stopId: string;
  match: StopResult["match"];
  similarity: number | null;
  distanceM: number | null;
}

interface Matched {
  anchor: StopSearchResponse["anchor"];
  hits: Hit[];
}

const normalise = (q: string) => q.trim().toLowerCase().replace(/\s+/g, " ");

/** Stops that some published route serves: a stop nobody stops at is not a search result. */
const SERVED = `EXISTS (SELECT 1 FROM route_stops rs JOIN routes r ON r.id = rs.route_id
                         WHERE rs.stop_id = s.id AND r.published_at IS NOT NULL AND r.archived_at IS NULL)`;

export async function matchStops(deps: SearchDeps, rawQ: string): Promise<Matched> {
  const q = normalise(rawQ);
  const cacheKey = deps.keys?.searchStops(createHash("sha1").update(q).digest("hex").slice(0, 16));
  if (deps.redis && cacheKey) {
    const hit = await deps.redis.get(cacheKey).catch(() => null);
    if (hit) return JSON.parse(hit) as Matched;
  }

  const { rows } = await deps.db.query<{
    id: string;
    lat: number;
    lng: number;
    name: string;
    s_name: number;
    s_alias: number;
    s_area: number;
  }>(
    // each field scored on its spelling and on its phonetic fold (fold_place, migration 0006)
    `WITH q AS (SELECT $1::text AS raw, fold_place($1) AS f)
     SELECT s.id, ST_Y(s.location::geometry) AS lat, ST_X(s.location::geometry) AS lng, s.name,
            GREATEST(similarity(lower(s.name), q.raw), word_similarity(q.raw, lower(s.name)),
                     similarity(fold_place(s.name), q.f), word_similarity(q.f, fold_place(s.name))) AS s_name,
            COALESCE((SELECT max(GREATEST(similarity(lower(a), q.raw), word_similarity(q.raw, lower(a)),
                                          similarity(fold_place(a), q.f)))
                        FROM unnest(s.aliases) a), 0) AS s_alias,
            COALESCE(GREATEST(similarity(lower(s.area_name), q.raw), word_similarity(q.raw, lower(s.area_name)),
                              similarity(fold_place(s.area_name), q.f)), 0) AS s_area
       FROM stops s, q
      WHERE s.archived_at IS NULL AND ${SERVED}`,
    [q],
  );
  const scored = rows
    .map((r) => {
      const best = Math.max(Number(r.s_name), Number(r.s_alias), Number(r.s_area));
      const match: Hit["match"] =
        best === Number(r.s_name) ? "name" : best === Number(r.s_alias) ? "alias" : "area";
      return { r, best, match };
    })
    .filter((x) => x.best >= SEARCH.TEXT_MIN)
    .sort((a, b) => b.best - a.best || a.r.name.localeCompare(b.r.name));

  let anchor: Matched["anchor"] = null;
  const top = scored[0];
  if (top && top.best >= SEARCH.AREA_FALLBACK) {
    anchor = { label: top.r.name, lat: Number(top.r.lat), lng: Number(top.r.lng), source: "stop" };
  } else if (deps.geocoder) {
    const g = await deps.geocoder.geocode(rawQ.trim());
    if (g) anchor = { ...g, source: "geocoder" };
  }

  // with a strong match to anchor on, weak fuzzy hits are noise — the nearby stops are the answer
  // and a hit far below the best one ("kothi" → Kondapur, when Koti matched exactly) is noise too
  const floor = Math.max(SEARCH.AREA_FALLBACK, (top?.best ?? 0) - SEARCH.TEXT_BAND);
  const kept = anchor?.source === "stop" ? scored.filter((x) => x.best >= floor) : scored;
  const hits: Hit[] = kept.slice(0, SEARCH.LIMIT).map((x) => ({
    stopId: x.r.id,
    match: x.match,
    similarity: Math.round(x.best * 1000) / 1000,
    distanceM: null,
  }));
  if (anchor) {
    const near = await deps.db.query<{ id: string; d: number }>(
      `SELECT s.id, ST_Distance(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) AS d
         FROM stops s
        WHERE s.archived_at IS NULL AND ${SERVED}
          AND ST_DWithin(s.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography, $3)
        ORDER BY d`,
      [anchor.lng, anchor.lat, SEARCH.RADIUS_M],
    );
    const seen = new Map(hits.map((h) => [h.stopId, h]));
    for (const n of near.rows) {
      const d = Math.round(Number(n.d));
      const existing = seen.get(n.id);
      if (existing) existing.distanceM = d;
      else if (hits.length < SEARCH.LIMIT) {
        const h: Hit = { stopId: n.id, match: "nearby", similarity: null, distanceM: d };
        hits.push(h);
        seen.set(n.id, h);
      }
    }
  }
  const out: Matched = { anchor, hits };
  if (deps.redis && cacheKey) {
    await deps.redis.set(cacheKey, JSON.stringify(out), "EX", TTL.SEARCH_S).catch(() => undefined);
  }
  return out;
}

/** Stop rows plus the buses that serve them, joined fresh against today's trips and Redis. */
export async function describeStops(
  deps: SearchDeps,
  hits: readonly Pick<Hit, "stopId" | "match" | "similarity" | "distanceM">[],
): Promise<StopResult[]> {
  if (!hits.length) return [];
  const ids = hits.map((h) => h.stopId);
  const stops = await deps.db.query<{
    id: string;
    name: string;
    area_name: string | null;
    landmark: string | null;
    lat: number;
    lng: number;
  }>(
    `SELECT id, name, area_name, landmark, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
       FROM stops WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const served = await deps.db.query<{
    stop_id: string;
    route_id: string;
    route_name: string;
    lineage_id: string;
    seq: number;
    stop_index: number;
    scheduled_offset_s: number | null;
  }>(
    `SELECT rs.stop_id, r.id AS route_id, r.name AS route_name, r.lineage_id, rs.seq,
            (SELECT count(*)::int FROM route_stops x WHERE x.route_id = r.id AND x.seq < rs.seq) AS stop_index,
            rs.scheduled_offset_s
       FROM route_stops rs JOIN routes r ON r.id = rs.route_id
      WHERE rs.stop_id = ANY($1::uuid[]) AND r.published_at IS NOT NULL AND r.archived_at IS NULL`,
    [ids],
  );
  const lineages = [...new Set(served.rows.map((r) => r.lineage_id))];
  const trips = lineages.length
    ? await deps.db.query<{
        id: string;
        bus_id: string;
        bus_number: string;
        route_id: string;
        lineage_id: string;
        status: string;
        scheduled_start_at: Date | null;
      }>(
        `SELECT t.id, t.bus_id, b.bus_number, t.route_id, r.lineage_id, t.status, t.scheduled_start_at
           FROM trips t JOIN buses b ON b.id = t.bus_id JOIN routes r ON r.id = t.route_id
          WHERE t.service_date = operating_date() AND r.lineage_id = ANY($1::uuid[])
            AND t.status <> 'cancelled'
          ORDER BY t.started_at DESC NULLS LAST`,
        [lineages],
      )
    : { rows: [] };
  const assigned = lineages.length
    ? await deps.db.query<{ id: string; bus_number: string; lineage_id: string }>(
        `SELECT b.id, b.bus_number, r.lineage_id FROM buses b JOIN routes r ON r.id = b.default_route_id
          WHERE b.archived_at IS NULL AND b.status <> 'retired' AND r.lineage_id = ANY($1::uuid[])`,
        [lineages],
      )
    : { rows: [] };
  const fleet =
    deps.redis && deps.keys ? await readFleet(deps.redis, deps.keys).catch(() => ({})) : {};

  const etaFor = async (tripId: string, stopId: string) => {
    if (!deps.redis || !deps.keys) return null;
    const raw = await deps.redis.hget(deps.keys.tripEta(tripId), stopId).catch(() => null);
    return raw
      ? (JSON.parse(raw) as {
          p50: number;
          p90: number;
          confidence: "high" | "medium" | "low";
          at: string;
        })
      : null;
  };

  const rank: Record<BusAtStop["status"], number> = {
    running: 0,
    scheduled: 1,
    passed: 2,
    not_running: 3,
  };
  const out: StopResult[] = [];
  for (const h of hits) {
    const s = stops.rows.find((x) => x.id === h.stopId);
    if (!s) continue;
    const byBus = new Map<string, BusAtStop>();
    const offer = (b: BusAtStop) => {
      const cur = byBus.get(b.busId);
      if (!cur || rank[b.status] < rank[cur.status]) byBus.set(b.busId, b);
    };
    for (const sv of served.rows.filter((x) => x.stop_id === s.id)) {
      for (const t of trips.rows.filter((x) => x.lineage_id === sv.lineage_id)) {
        const base = {
          busId: t.bus_id,
          number: t.bus_number,
          routeId: sv.route_id,
          routeName: sv.route_name,
          tripId: t.id,
          seq: sv.seq,
        };
        const live = (
          fleet as Record<
            string,
            { tripId: string | null; seq: number; state: BusAtStop["presence"] }
          >
        )[t.bus_id];
        if (t.status === "running" || t.status === "dark") {
          const onTrip = live && live.tripId === t.id;
          if (onTrip && live.seq >= sv.stop_index) {
            offer({
              ...base,
              status: "passed",
              eta: null,
              presence: live.state,
              scheduledAt: null,
            });
            continue;
          }
          // an ETA is only for the stop on the version this trip actually runs
          const eta =
            t.route_id === sv.route_id && onTrip && live.state !== "DARK"
              ? await etaFor(t.id, s.id)
              : null;
          offer({
            ...base,
            status: "running",
            eta,
            presence: onTrip ? live.state : null,
            scheduledAt: null,
          });
        } else if (t.status === "completed") {
          offer({ ...base, status: "passed", eta: null, presence: null, scheduledAt: null });
        } else if (t.status === "scheduled") {
          const at =
            t.scheduled_start_at && sv.scheduled_offset_s !== null
              ? new Date(
                  new Date(t.scheduled_start_at).getTime() + sv.scheduled_offset_s * 1000,
                ).toISOString()
              : t.scheduled_start_at
                ? new Date(t.scheduled_start_at).toISOString()
                : null;
          offer({ ...base, status: "scheduled", eta: null, presence: null, scheduledAt: at });
        }
      }
      for (const b of assigned.rows.filter((x) => x.lineage_id === sv.lineage_id)) {
        if (byBus.has(b.id)) continue;
        offer({
          busId: b.id,
          number: b.bus_number,
          routeId: sv.route_id,
          routeName: sv.route_name,
          tripId: null,
          seq: sv.seq,
          status: "not_running",
          eta: null,
          presence: null,
          scheduledAt: null,
        });
      }
    }
    const buses = [...byBus.values()].sort(
      (a, b) =>
        rank[a.status] - rank[b.status] ||
        (a.eta?.p50 ?? Infinity) - (b.eta?.p50 ?? Infinity) ||
        (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? "") ||
        a.number.localeCompare(b.number, undefined, { numeric: true }),
    );
    out.push({
      stopId: s.id,
      name: s.name,
      areaName: s.area_name,
      landmark: s.landmark,
      lat: Number(s.lat),
      lng: Number(s.lng),
      match: h.match,
      similarity: h.similarity,
      distanceM: h.distanceM,
      buses,
    });
  }
  return out;
}

export async function searchStops(deps: SearchDeps, q: string): Promise<StopSearchResponse> {
  const m = await matchStops(deps, q);
  return { query: q, anchor: m.anchor, results: await describeStops(deps, m.hits) };
}
