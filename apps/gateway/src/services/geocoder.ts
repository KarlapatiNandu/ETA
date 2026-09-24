/**
 * Area lookup for stop search (BUILD_PLAN Stage 5, ARCH §2.1): self-hosted Photon, so
 * "Dilsukhnagar" resolves to a *place* even when no stop is called that. Clipped to the
 * Hyderabad bounding box — a student searching "Uppal" means this Uppal.
 */

export interface GeocodeHit {
  label: string;
  lat: number;
  lng: number;
}

export interface Geocoder {
  geocode(q: string): Promise<GeocodeHit | null>;
}

/** [west, south, east, north] — matches infra/hyderabad.env's extract */
export const HYDERABAD_BBOX = [78.2, 17.2, 78.75, 17.65] as const;

export function createPhotonGeocoder(baseUrl: string, timeoutMs = 2500): Geocoder {
  return {
    async geocode(q) {
      const params = new URLSearchParams({ q, limit: "1", bbox: HYDERABAD_BBOX.join(",") });
      try {
        const res = await fetch(`${baseUrl}/api?${params}`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as {
          features?: {
            properties?: { name?: string };
            geometry?: { coordinates?: [number, number] };
          }[];
        };
        const f = body.features?.[0];
        const c = f?.geometry?.coordinates;
        if (!c) return null;
        return { label: f?.properties?.name ?? q, lat: c[1], lng: c[0] };
      } catch {
        // the geocoder is a fallback: down means "no area match", never a failed search
        return null;
      }
    },
  };
}
