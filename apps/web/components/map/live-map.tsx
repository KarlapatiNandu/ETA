"use client";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Network, NetworkRoute } from "@busmitra/contracts";
import { buildRoute, type Route } from "@busmitra/geo";
import { formatAge, formatClock, PRESENCE_STYLE } from "@busmitra/ui";
import { publicEnv } from "@/lib/env";
import { displayAt, retarget, type Track } from "@/lib/map/interpolate";
import { serverNow, useFleet } from "@/lib/store/fleet";
import type { BusView } from "@/lib/store/fleet-reducer";

/**
 * The student live map (BUILD_PLAN Stage 3): MapLibre on our own tiles, route polylines, stops,
 * bus markers coloured *and shaped* by presence, dead-reckoned between fixes (ARCH §4).
 *
 * Truth lives in the Zustand store; this component only draws it. Markers move in a
 * requestAnimationFrame loop outside React, so 30 gliding buses never re-render the tree.
 *
 * Honest degradation (ARCH §11): an amber bus says how long ago it was last seen, a red one
 * says since when (or which known dead zone it is in), and an ENDED bus is simply gone.
 */

const ATTRIBUTION = "© OpenMapTiles © OpenStreetMap contributors";

interface Drawn {
  marker: maplibregl.Marker;
  el: HTMLDivElement;
  note: HTMLDivElement;
  track: Track;
  /** the bus view this track was built from — retarget only when it changes */
  from: BusView;
  /** local ms of the position frame not yet painted (latency measurement) */
  unpainted: number | null;
}

declare global {
  interface Window {
    /** ?measure: ping-to-pixel samples in ms, read by the Stage 3 latency harness */
    __bmLatency?: { ms: number; bus: string; t: number }[];
  }
}

function noteFor(b: BusView, now: number): string {
  if (b.state === "DEGRADED") return `last seen ${formatAge((now - Date.parse(b.ts)) / 1000)} ago`;
  if (b.state === "DARK") {
    if (b.deadZone) return `dead zone · usually ~${formatAge(b.deadZone.avgOutageS)}`;
    return `no signal since ${formatClock(b.ts)}`;
  }
  if (b.flag === "off_route") return "off its usual route";
  return "";
}

function routeFeatures(routes: NetworkRoute[], highlight: string | null) {
  return {
    type: "FeatureCollection" as const,
    features: routes.map((r) => ({
      type: "Feature" as const,
      properties: { id: r.id, on: r.id === highlight ? 1 : 0 },
      geometry: { type: "LineString" as const, coordinates: r.coords },
    })),
  };
}

function stopFeatures(routes: NetworkRoute[]) {
  const seen = new Set<string>();
  const features = [];
  for (const r of routes)
    for (const s of r.stops) {
      if (seen.has(s.stopId)) continue;
      seen.add(s.stopId);
      features.push({
        type: "Feature" as const,
        properties: { id: s.stopId, name: s.name },
        geometry: { type: "Point" as const, coordinates: [s.lng, s.lat] },
      });
    }
  return { type: "FeatureCollection" as const, features };
}

export function LiveMap({
  network,
  selected,
  onSelect,
  onViewport,
  className,
}: {
  network: Network | null;
  selected: string | null;
  onSelect: (busId: string | null) => void;
  onViewport?: (bbox: [number, number, number, number]) => void;
  className?: string;
}) {
  const el = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const drawn = useRef(new Map<string, Drawn>());
  const [ready, setReady] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onViewportRef = useRef(onViewport);
  onViewportRef.current = onViewport;

  const geoms = useMemo(() => {
    const m = new Map<string, Route>();
    for (const r of network?.routes ?? [])
      m.set(
        r.id,
        buildRoute(
          r.coords.map(([lng, lat]) => ({ lat, lng })),
          r.cum.length === r.coords.length ? r.cum : undefined,
        ),
      );
    return m;
  }, [network]);
  const geomsRef = useRef(geoms);
  geomsRef.current = geoms;

  // ── the map itself (created once; the container must exist before this runs)
  useEffect(() => {
    if (!el.current) return;
    const map = new maplibregl.Map({
      container: el.current,
      style: `/api/map-style?tiles=${encodeURIComponent(publicEnv.tilesUrl)}`,
      center: [78.4867, 17.385],
      zoom: 11,
      attributionControl: false,
    });
    map.addControl(
      new maplibregl.AttributionControl({ compact: false, customAttribution: ATTRIBUTION }),
    );
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => {
      map.addSource("routes", { type: "geojson", data: routeFeatures([], null) });
      map.addSource("stops", { type: "geojson", data: stopFeatures([]) });
      map.addLayer({
        id: "routes",
        type: "line",
        source: "routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          // the --bm-route token; MapLibre paint cannot read CSS variables
          "line-color": "#3b82f6",
          "line-opacity": ["case", ["==", ["get", "on"], 1], 1, 0.45],
          "line-width": ["case", ["==", ["get", "on"], 1], 5, 2.5],
        },
      });
      map.addLayer({
        id: "stops",
        type: "circle",
        source: "stops",
        minzoom: 11,
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 16, 6],
          "circle-color": "#0b0d10",
          "circle-stroke-color": "#8a95a3",
          "circle-stroke-width": 1.5,
        },
      });
      map.addLayer({
        id: "stop-labels",
        type: "symbol",
        source: "stops",
        minzoom: 14,
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          "text-offset": [0, 1.1],
          "text-anchor": "top",
        },
        paint: { "text-color": "#c3cad3", "text-halo-color": "#0b0d10", "text-halo-width": 1.2 },
      });
      map.on("click", (e) => {
        if (!(e.originalEvent.target as HTMLElement).closest(".bm-bus")) onSelectRef.current(null);
      });
      setReady(true);
    });
    const report = () => {
      const b = map.getBounds();
      onViewportRef.current?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    };
    map.on("moveend", report);
    mapRef.current = map;
    const markers = drawn.current;
    return () => {
      for (const d of markers.values()) d.marker.remove();
      markers.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ── routes and stops, once the network and the style are both there
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !network) return;
    (map.getSource("routes") as maplibregl.GeoJSONSource).setData(
      routeFeatures(network.routes, null),
    );
    (map.getSource("stops") as maplibregl.GeoJSONSource).setData(stopFeatures(network.routes));
    const all = network.routes.flatMap((r) => r.coords);
    if (all.length) {
      const bounds = all.reduce(
        (b, c) => b.extend(c as [number, number]),
        new maplibregl.LngLatBounds(all[0] as [number, number], all[0] as [number, number]),
      );
      map.fitBounds(bounds, { padding: 40, duration: 0 });
    }
  }, [ready, network]);

  // ── highlight the selected bus's route
  const selectedRoute = useFleet((s) => (selected ? (s.buses[selected]?.routeId ?? null) : null));
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !network) return;
    (map.getSource("routes") as maplibregl.GeoJSONSource).setData(
      routeFeatures(network.routes, selectedRoute),
    );
  }, [ready, network, selectedRoute]);

  // ── markers follow the store; the animation loop moves them
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const measure = new URLSearchParams(window.location.search).has("measure");
    if (measure) window.__bmLatency ??= [];

    const sync = (buses: Record<string, BusView>, offset: number) => {
      const now = serverNow(offset);
      for (const [id, d] of drawn.current) {
        if (!buses[id]) {
          d.marker.remove();
          drawn.current.delete(id);
        }
      }
      for (const [id, b] of Object.entries(buses)) {
        const d = drawn.current.get(id);
        if (d && d.from === b) continue;
        const route = b.routeId ? (geomsRef.current.get(b.routeId) ?? null) : null;
        const fix = {
          s: route ? b.s : null,
          lat: b.lat,
          lng: b.lng,
          at: Date.parse(b.ts),
          kmh: b.spd,
          cadenceS: b.cadence,
          live: b.state === "LIVE",
        };
        if (d) {
          const newFix = d.from.ts !== b.ts;
          d.track = retarget(d.track, fix, now, route);
          d.from = b;
          if (newFix && measure) d.unpainted = Date.now();
          d.el.dataset.state = b.state;
          continue;
        }
        const node = document.createElement("div");
        node.className = "bm-bus";
        node.dataset.state = b.state;
        node.setAttribute("role", "button");
        const pill = document.createElement("div");
        pill.className = "bm-bus__pill";
        const number = network?.buses.find((x) => x.id === id)?.number ?? "?";
        pill.textContent = number;
        const note = document.createElement("div");
        note.className = "bm-bus__note";
        node.append(pill, note);
        node.addEventListener("click", (ev) => {
          ev.stopPropagation();
          onSelectRef.current(id);
        });
        const track = retarget(null, fix, now, route);
        const pos = displayAt(track, now, route).pos;
        const marker = new maplibregl.Marker({ element: node, anchor: "center" })
          .setLngLat([pos.lng, pos.lat])
          .addTo(map);
        drawn.current.set(id, { marker, el: node, note, track, from: b, unpainted: null });
      }
    };

    const st = useFleet.getState();
    sync(st.buses, st.clockOffsetMs);
    const unsub = useFleet.subscribe((s, prev) => {
      if (s.buses !== prev.buses) sync(s.buses, s.clockOffsetMs);
    });

    let raf = 0;
    let lastNotes = 0;
    const frame = () => {
      const offset = useFleet.getState().clockOffsetMs;
      const now = serverNow(offset);
      const writeNotes = now - lastNotes > 500;
      for (const [id, d] of drawn.current) {
        const route = d.from.routeId ? (geomsRef.current.get(d.from.routeId) ?? null) : null;
        const { pos } = displayAt(d.track, now, route);
        d.marker.setLngLat([pos.lng, pos.lat]);
        if (d.unpainted !== null) {
          // painted this frame: fix time → pixel, on the gateway's clock
          window.__bmLatency?.push({
            ms: now - Date.parse(d.from.ts),
            bus: d.el.firstChild?.textContent ?? id,
            t: now,
          });
          d.unpainted = null;
        }
        if (writeNotes) {
          const text = noteFor(d.from, now);
          if (d.note.textContent !== text) d.note.textContent = text;
          d.el.dataset.selected = String(selectedRef.current === id);
          d.el.setAttribute(
            "aria-label",
            `Bus ${d.el.firstChild?.textContent ?? ""}: ${PRESENCE_STYLE[d.from.state].label}${text ? `, ${text}` : ""}`,
          );
        }
      }
      if (writeNotes) lastNotes = now;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      unsub();
      // rebuilt from the store on the next run (bus numbers and geometry come with the network)
      for (const d of drawn.current.values()) d.marker.remove();
      drawn.current.clear();
    };
  }, [ready, network]);

  return <div ref={el} className={className} data-testid="live-map" />;
}
