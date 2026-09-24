/**
 * The Redis key registry (SCHEMA §10). Every key in the system is built here and nowhere else
 * (invariant 15): a key string typed inline is a key nobody can find when it needs expiring,
 * renaming or clearing at 7:40 a.m.
 *
 * `keyspace(ns)` prefixes every key, so tests can run against a shared Redis without touching
 * each other (or a developer's live dev data). Production uses the empty namespace.
 */
export function keyspace(ns = "") {
  const k = (s: string) => ns + s;
  return {
    ns,
    /** HASH bus_id → FleetEntry JSON: the live fleet (ARCH §1, ADR-0002) */
    fleetLive: k("fleet:live"),
    /** STRING heartbeat marker, TTL 12 × cadence */
    busHeartbeat: (busId: string) => k(`bus:${busId}:hb`),
    /** STRING EWMA speed km/h (v_live, ARCH §5.5) */
    busEwma: (busId: string) => k(`bus:${busId}:ewma`),
    /** STRING last snapped vertex index — the windowed-search hint (ARCH §5.2) */
    busSnapIdx: (busId: string) => k(`bus:${busId}:snapidx`),
    /** STRING highest stop index reached — monotonic except on re-snap (ARCH §5.3) */
    tripSeq: (tripId: string) => k(`trip:${tripId}:seq`),
    /** HASH stop_id → {p50,p90,computedAt} (Stage 5) */
    tripEta: (tripId: string) => k(`trip:${tripId}:eta`),
    /** STRING TripGeoState JSON — the geo worker's per-trip memory between pings */
    tripGeo: (tripId: string) => k(`trip:${tripId}:geo`),
    /** STRING packed polyline + cumulative_dist_m + stops */
    routeGeom: (routeId: string) => k(`route:${routeId}:geom`),
    /** STRING OSRM free-flow km/h per 200 m segment of a route (v_osrm, ARCH §5.5; Stage 5) */
    routeOsrm: (routeId: string) => k(`route:${routeId}:osrm`),
    /** STREAM domain events for the notification spine (leave_now …): Stage 5 emits, 6 delivers */
    streamNotify: k("stream:notify"),
    /** PUB/SUB channel: ETA changes for the gateway's eta.update frames — never replayed */
    etaChannel: k("pubsub:eta"),
    /** PUB/SUB channel: per-user notification / ticket.update frames (Stage 6) — never replayed */
    notifyChannel: k("pubsub:notify"),
    /** STREAM raw validated pings; consumer groups `geo` and `persist` */
    streamPings: k("stream:pings"),
    /** STREAM pings the persister could not write even one at a time — for a human */
    streamPingsDead: k("stream:pings:dead"),
    /** STREAM broadcast-class domain events for SSE Last-Event-ID replay (Stage 3) */
    streamEvents: k("stream:events"),
    /** STRING the open signal_outages row for a bus that went DARK: {id, tripId} (Stage 3) */
    busOutage: (busId: string) => k(`bus:${busId}:outage`),
    /**
     * STRING one per live SSE stream, TTL 45 s refreshed by heartbeat (never a SET — ARCH §7).
     * The value is `{inst, focus}`: the gateway instance holding it (so a restarted instance can
     * reclaim its own phantoms at once) and the connection's focus (bbox + bus ids).
     */
    sseConn: (userId: string, connId: string) => k(`sse:conn:${userId}:${connId}`),
    sseConnMatch: (userId: string) => k(`sse:conn:${userId}:*`),
    sseConnAll: k("sse:conn:*"),
    /** STRING cached stop-search result (Stage 5) */
    searchStops: (hash: string) => k(`search:stops:${hash}`),
    /** STRING ingest replay cache: one per accepted signature, TTL 2 × skew window */
    ingestNonce: (signature: string) => k(`ingest:nonce:${signature}`),
    /** STRING per-device ingest request counter for one rate-limit window */
    ingestRate: (deviceUid: string, window: number) => k(`ratelimit:ingest:${deviceUid}:${window}`),
    /** namespace handed to @fastify/rate-limit, which appends its own route/ip suffix */
    httpRateLimitPrefix: k("ratelimit:http:"),
  };
}

export type Keys = ReturnType<typeof keyspace>;

/** The production keyspace. */
export const keys: Keys = keyspace();

/** TTLs in seconds (SCHEMA §10). */
export const TTL = {
  BUS_HEARTBEAT_CADENCE_MULTIPLE: 12,
  BUS_EWMA_S: 3600,
  BUS_SNAPIDX_S: 3600,
  TRIP_SEQ_S: 12 * 3600,
  TRIP_GEO_S: 12 * 3600,
  TRIP_ETA_S: 300,
  ROUTE_GEOM_S: 24 * 3600,
  ROUTE_OSRM_S: 24 * 3600,
  SSE_CONN_S: 45,
  SEARCH_S: 300,
  BUS_OUTAGE_S: 12 * 3600,
  /** twice the ±5 min skew window, so a signature cannot outlive its nonce */
  INGEST_NONCE_S: 600,
} as const;

export const STREAMS = {
  PINGS_MAXLEN: 100_000,
  EVENTS_MAXLEN: 50_000,
  DEAD_MAXLEN: 10_000,
  NOTIFY_MAXLEN: 10_000,
  /** on stream:events — per-stop ETAs computed from every accepted position */
  GROUP_ETA: "eta",
  GROUP_GEO: "geo",
  GROUP_PERSIST: "persist",
  /** on stream:events — writes trip_stop_events off the geo worker's path */
  GROUP_STOP_EVENTS: "stop-events",
  /** on stream:notify and stream:events — the notification spine (Stage 6) */
  GROUP_NOTIFY: "notify",
} as const;
