"use client";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl, { type GeoJSONSource } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { publicEnv } from "@/lib/env";

export interface DeadZone {
  id: string;
  label: string | null;
  sample_count: number;
  avg_outage_s: number;
  p90_outage_s: number;
  confidence: number;
  outages_14d: number;
  polygon: { type: "Polygon"; coordinates: [number, number][][] };
}

/**
 * The learned dead zones on the map (BUILD_PLAN Stage 8 "admin overlay of learned zones").
 * Amber, not red: a known dead zone is expected and explained — the bus is fine, the network
 * is not (ARCH §5.7). Hover shows what the student is told.
 */
export function DeadZoneMap({ zones }: { zones: DeadZone[] }) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const zonesRef = useRef(zones);
  zonesRef.current = zones;

  useEffect(() => {
    if (!el.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: `/api/map-style?tiles=${encodeURIComponent(publicEnv.tilesUrl)}`,
      center: [78.45, 17.4],
      zoom: 10.5,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    map.on("load", () => {
      map.addSource("zones", { type: "geojson", data: collection(zonesRef.current) });
      map.addLayer({
        id: "zones-fill",
        type: "fill",
        source: "zones",
        paint: { "fill-color": "#f5a524", "fill-opacity": ["*", 0.45, ["get", "confidence"]] },
      });
      map.addLayer({
        id: "zones-line",
        type: "line",
        source: "zones",
        paint: { "line-color": "#f5a524", "line-width": 2 },
      });
      fit(map, zonesRef.current);
      const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      map.on("mousemove", "zones-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const p = f.properties as Record<string, string | number>;
        map.getCanvas().style.cursor = "pointer";
        popup
          .setLngLat(e.lngLat)
          .setText(
            `${p.label || "Unnamed zone"} — ${p.sample_count} outages, usually clears in ~${p.avg_outage_s} s (p90 ${p.p90_outage_s} s), confidence ${Math.round(Number(p.confidence) * 100)}%`,
          )
          .addTo(map);
      });
      map.on("mouseleave", "zones-fill", () => {
        map.getCanvas().style.cursor = "";
        popup.remove();
      });
    });
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const src = map?.getSource("zones") as GeoJSONSource | undefined;
    if (src) src.setData(collection(zones));
  }, [zones]);

  return (
    <div ref={el} className="h-80 w-full overflow-hidden rounded-xl" data-testid="dead-zone-map" />
  );
}

function collection(zones: DeadZone[]) {
  return {
    type: "FeatureCollection" as const,
    features: zones.map((z) => ({
      type: "Feature" as const,
      properties: {
        id: z.id,
        label: z.label ?? "",
        sample_count: z.sample_count,
        avg_outage_s: z.avg_outage_s,
        p90_outage_s: z.p90_outage_s,
        confidence: Number(z.confidence),
      },
      geometry: z.polygon,
    })),
  };
}

function fit(map: maplibregl.Map, zones: DeadZone[]) {
  const pts = zones.flatMap((z) => z.polygon.coordinates[0] ?? []);
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
  for (const p of pts) b.extend(p);
  map.fitBounds(b, { padding: 60, maxZoom: 15, duration: 0 });
}
