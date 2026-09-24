import type { LatLng } from "@busmitra/geo";

/**
 * The slice of OSRM (self-hosted, ARCH §2.1) the engine uses. The pure decisions around each
 * call — chunking, stitching — live in @busmitra/geo; this file only speaks HTTP.
 */

export interface OsrmMatch {
  /** matched geometries in travel order (OSRM splits a trace it cannot match continuously) */
  matchings: LatLng[][];
  /** per input coordinate: where it was snapped, or null if it was dropped as an outlier */
  tracepoints: (LatLng | null)[];
}

export interface OsrmRoute {
  line: LatLng[];
  distanceM: number;
  durationS: number;
  /** each input waypoint, snapped onto the road network */
  waypoints: LatLng[];
  /** one per consecutive waypoint pair: free-flow distance and duration (Stage 5 v_osrm) */
  legs: { distanceM: number; durationS: number }[];
}

export interface Osrm {
  match(points: readonly (LatLng & { t?: number; radiusM?: number })[]): Promise<OsrmMatch>;
  route(waypoints: readonly LatLng[]): Promise<OsrmRoute>;
}

export class OsrmError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OsrmError";
    this.code = code;
  }
}

type Coord = [number, number];
const toLatLng = ([lng, lat]: Coord): LatLng => ({ lat, lng });
const fmt = (p: LatLng) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`;

export function createOsrm(
  baseUrl: string,
  opts: { profile?: string; timeoutMs?: number; retries?: number } = {},
): Osrm {
  const profile = opts.profile ?? "driving";
  const retries = opts.retries ?? 2;
  /**
   * OSRM closes idle keep-alive connections, and Node's pool only discovers that by trying: the
   * first request after a pause fails with `UND_ERR_SOCKET` ("other side closed"). These are
   * idempotent GETs and no response was read, so retrying cannot duplicate anything — while
   * *not* retrying aborts a survey match that has already made thirty successful calls.
   */
  const get = async (path: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(`${baseUrl}${path}`, {
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
        });
        const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
        return { ok: res.ok, body };
      } catch (err) {
        // our own timeout is not a transport hiccup; give up on it
        if ((err as { name?: string })?.name === "AbortError" || attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  };

  return {
    async match(points) {
      const coords = points.map(fmt).join(";");
      const params = new URLSearchParams({
        geometries: "geojson",
        overview: "full",
        // simplified traces have long time gaps between kept points by design; do not split on them
        gaps: "ignore",
        tidy: "false",
        radiuses: points.map((p) => Math.round(p.radiusM ?? 25)).join(";"),
      });
      if (points.every((p) => p.t !== undefined)) {
        // OSRM wants strictly increasing integer seconds
        let last = -Infinity;
        const ts = points.map((p) => {
          last = Math.max(last + 1, Math.floor(p.t! / 1000));
          return last;
        });
        params.set("timestamps", ts.join(";"));
      }
      const { ok, body } = await get(`/match/v1/${profile}/${coords}?${params}`);
      const b = body as {
        code?: string;
        message?: string;
        matchings?: { geometry: { coordinates: Coord[] } }[];
        tracepoints?: ({ location: Coord } | null)[];
      };
      if (b.code === "NoMatch" || b.code === "NoSegment") {
        return { matchings: [], tracepoints: points.map(() => null) };
      }
      if (!ok || b.code !== "Ok")
        throw new OsrmError(b.code ?? "HTTP", b.message ?? "match failed");
      return {
        matchings: (b.matchings ?? []).map((m) => m.geometry.coordinates.map(toLatLng)),
        tracepoints: (b.tracepoints ?? []).map((tp) => (tp ? toLatLng(tp.location) : null)),
      };
    },

    async route(waypoints) {
      const params = new URLSearchParams({
        geometries: "geojson",
        overview: "full",
        steps: "false",
      });
      const { ok, body } = await get(
        `/route/v1/${profile}/${waypoints.map(fmt).join(";")}?${params}`,
      );
      const b = body as {
        code?: string;
        message?: string;
        routes?: {
          geometry: { coordinates: Coord[] };
          distance: number;
          duration: number;
          legs?: { distance: number; duration: number }[];
        }[];
        waypoints?: { location: Coord }[];
      };
      if (!ok || b.code !== "Ok" || !b.routes?.[0]) {
        throw new OsrmError(b.code ?? "HTTP", b.message ?? "route failed");
      }
      return {
        line: b.routes[0].geometry.coordinates.map(toLatLng),
        distanceM: b.routes[0].distance,
        durationS: b.routes[0].duration,
        waypoints: (b.waypoints ?? []).map((w) => toLatLng(w.location)),
        legs: (b.routes[0].legs ?? []).map((l) => ({
          distanceM: l.distance,
          durationS: l.duration,
        })),
      };
    },
  };
}
