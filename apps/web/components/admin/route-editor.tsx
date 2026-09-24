"use client";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl, { type GeoJSONSource, type MapMouseEvent } from "maplibre-gl";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DraftStop, LngLat, RouteDetail, StopSearchHit } from "@busmitra/contracts";
import { buildRoute, findPasses, nearestOnRoute, type Route } from "@busmitra/geo";
import { ErrorText } from "@/components/ui";
import { publicEnv } from "@/lib/env";
import { gateway, GatewayError } from "@/lib/gateway";
import { supabaseBrowser } from "@/lib/supabase/client";

async function token() {
  const { data } = await supabaseBrowser().auth.getSession();
  return data.session?.access_token;
}

/** A stop in the editor: an existing stop, or one to be created on save. */
interface EditStop {
  key: string;
  stopId?: string;
  name: string;
  area?: string | null;
  landmark?: string | null;
  aliases?: string[];
  lat: number;
  lng: number;
  /** where along the line it was dropped — picks the pass on a route that loops back */
  near: number;
}

const toLatLng = ([lng, lat]: LngLat) => ({ lat, lng });
const km = (m: number) => `${(m / 1000).toFixed(2)} km`;
let keySeq = 0;

/** The theme style, with the tile server's address substituted in. */
function mapStyle(): string {
  return `/api/map-style?tiles=${encodeURIComponent(publicEnv.tilesUrl)}`;
}

function lineFeature(coords: LngLat[]) {
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "LineString" as const, coordinates: coords },
  };
}
function points(coords: LngLat[], props: (i: number) => Record<string, unknown> = (i) => ({ i })) {
  return {
    type: "FeatureCollection" as const,
    features: coords.map((c, i) => ({
      type: "Feature" as const,
      properties: props(i),
      geometry: { type: "Point" as const, coordinates: c },
    })),
  };
}

/**
 * The admin route editor (BUILD_PLAN Stage 1): the matched polyline on the map, drag to
 * correct it, drop stops along it, name them, publish. Publishing freezes the version (the
 * database enforces it); every later change is a new version on the same lineage (ADR-0003).
 */
export function RouteEditor({ routeId }: { routeId: string }) {
  const router = useRouter();
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [detail, setDetail] = useState<RouteDetail | null>(null);
  const [coords, setCoords] = useState<LngLat[]>([]);
  const [stops, setStops] = useState<EditStop[]>([]);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<"edit" | "add-stop">("edit");
  const [pending, setPending] = useState<{
    lat: number;
    lng: number;
    near: number;
    nearby: StopSearchHit[];
  } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const coordsRef = useRef<LngLat[]>([]);
  coordsRef.current = coords;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const editable = !!detail && !detail.published_at && !detail.archived_at;
  const route: Route | null = useMemo(
    () => (coords.length >= 2 ? buildRoute(coords.map(toLatLng)) : null),
    [coords],
  );

  // stops ordered by where they sit along the line (what D_k will be once saved)
  const ordered = useMemo(() => {
    if (!route) return stops.map((s) => ({ ...s, offset: 0, distance: 0 }));
    return stops
      .map((s) => {
        const passes = findPasses(route, s);
        const best = passes.length
          ? passes.reduce((a, b) => (Math.abs(b.s - s.near) < Math.abs(a.s - s.near) ? b : a))
          : nearestOnRoute(s, route, null);
        return { ...s, offset: best.s, distance: best.distance };
      })
      .sort((a, b) => a.offset - b.offset);
  }, [stops, route]);

  const load = useCallback(async () => {
    const d = await gateway<RouteDetail>(`/v1/admin/routes/${routeId}`, { token: await token() });
    setDetail(d);
    setCoords(d.coords);
    setStops(
      d.stops.map((s) => ({
        key: `s${++keySeq}`,
        stopId: s.stop_id,
        name: s.name,
        area: s.area_name,
        landmark: s.landmark,
        aliases: s.aliases,
        lat: s.lat,
        lng: s.lng,
        near: s.offset_m,
      })),
    );
    setDirty(false);
  }, [routeId]);
  useEffect(() => {
    load().catch((e) =>
      setError(e instanceof GatewayError ? e.message : "Could not load the route."),
    );
  }, [load]);

  // ── map setup ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapEl.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapEl.current,
      // our own dark style on our own tiles (ADR-0005, ARCH §8). tileserver-gl's bundled
      // preview style asks for fonts the server does not have, which loses every label.
      style: mapStyle(),
      center: [78.45, 17.4],
      zoom: 11,
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }));
    map.on("load", () => {
      map.addSource("route", { type: "geojson", data: lineFeature([]) });
      map.addSource("vertices", { type: "geojson", data: points([]) });
      map.addSource("midpoints", { type: "geojson", data: points([]) });
      map.addSource("stops", { type: "geojson", data: points([]) });
      map.addLayer({
        id: "route",
        type: "line",
        source: "route",
        paint: { "line-color": "#2fd27a", "line-width": 5 },
      });
      map.addLayer({
        id: "midpoints",
        type: "circle",
        source: "midpoints",
        minzoom: 14,
        paint: {
          "circle-radius": 4,
          "circle-color": "#0b0d10",
          "circle-stroke-color": "#2fd27a",
          "circle-stroke-width": 1.5,
          "circle-opacity": 0.8,
        },
      });
      map.addLayer({
        id: "vertices",
        type: "circle",
        source: "vertices",
        minzoom: 13,
        paint: {
          "circle-radius": 5,
          "circle-color": "#e8ecf1",
          "circle-stroke-color": "#0b0d10",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "stops",
        type: "circle",
        source: "stops",
        paint: {
          "circle-radius": 9,
          "circle-color": "#f5a524",
          "circle-stroke-color": "#0b0d10",
          "circle-stroke-width": 2,
        },
      });
      map.addLayer({
        id: "stop-labels",
        type: "symbol",
        source: "stops",
        layout: {
          "text-field": ["get", "label"],
          "text-font": ["Noto Sans Regular"],
          "text-size": 12,
          "text-offset": [0, 1.4],
          "text-anchor": "top",
        },
        paint: { "text-color": "#e8ecf1", "text-halo-color": "#0b0d10", "text-halo-width": 1.5 },
      });
      setMapReady(true);
      // dev-only handle, for debugging in the console and for browser tests; a production
      // build strips this branch entirely
      if (process.env.NODE_ENV !== "production") {
        (window as unknown as { __routeMap?: maplibregl.Map }).__routeMap = map;
      }
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // keep the map's sources in step with state
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    (map.getSource("route") as GeoJSONSource).setData(lineFeature(coords));
    (map.getSource("vertices") as GeoJSONSource).setData(points(editable ? coords : []));
    const mids: LngLat[] = editable
      ? coords
          .slice(1)
          .map((c, i) => [(c[0] + coords[i]![0]) / 2, (c[1] + coords[i]![1]) / 2] as LngLat)
      : [];
    (map.getSource("midpoints") as GeoJSONSource).setData(points(mids));
    (map.getSource("stops") as GeoJSONSource).setData(
      points(
        ordered.map((s) => [s.lng, s.lat] as LngLat),
        (i) => ({ label: `${i + 1}. ${ordered[i]!.name}` }),
      ),
    );
  }, [coords, ordered, editable, mapReady]);

  // fit to the route once it first arrives
  const fitted = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || fitted.current || coords.length < 2) return;
    const b = new maplibregl.LngLatBounds(coords[0], coords[0]);
    coords.forEach((c) => b.extend(c));
    map.fitBounds(b, { padding: 40, duration: 0 });
    fitted.current = true;
  }, [coords, mapReady]);

  // ── editing interactions (drafts only) ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !editable) return;
    let dragging: number | null = null;
    let frame = 0;

    const startDrag = (index: number) => {
      dragging = index;
      map.dragPan.disable();
      map.getCanvas().style.cursor = "grabbing";
    };
    const onVertexDown = (e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      if (modeRef.current !== "edit" || e.originalEvent.button !== 0) return;
      e.preventDefault();
      startDrag(Number(e.features?.[0]?.properties.i));
    };
    const onMidDown = (e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] }) => {
      if (modeRef.current !== "edit" || e.originalEvent.button !== 0) return;
      e.preventDefault();
      const i = Number(e.features?.[0]?.properties.i);
      const next = [...coordsRef.current];
      next.splice(i + 1, 0, [e.lngLat.lng, e.lngLat.lat]);
      setCoords(next);
      setDirty(true);
      startDrag(i + 1);
    };
    const onMove = (e: MapMouseEvent) => {
      if (dragging === null) return;
      const idx = dragging;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setCoords((c) =>
          c.map((p, i) => (i === idx ? ([e.lngLat.lng, e.lngLat.lat] as LngLat) : p)),
        );
        setDirty(true);
      });
    };
    const onUp = () => {
      if (dragging === null) return;
      dragging = null;
      map.dragPan.enable();
      map.getCanvas().style.cursor = "";
    };
    const onVertexRightClick = (
      e: MapMouseEvent & { features?: maplibregl.MapGeoJSONFeature[] },
    ) => {
      const i = Number(e.features?.[0]?.properties.i);
      if (coordsRef.current.length <= 2) return;
      setCoords((c) => c.filter((_, k) => k !== i));
      setDirty(true);
    };
    const hover = () =>
      (map.getCanvas().style.cursor = modeRef.current === "edit" ? "grab" : "crosshair");
    const leave = () =>
      (map.getCanvas().style.cursor = modeRef.current === "edit" ? "" : "crosshair");

    map.on("mousedown", "vertices", onVertexDown);
    map.on("mousedown", "midpoints", onMidDown);
    map.on("contextmenu", "vertices", onVertexRightClick);
    map.on("mouseenter", "vertices", hover);
    map.on("mouseleave", "vertices", leave);
    map.on("mouseenter", "midpoints", hover);
    map.on("mouseleave", "midpoints", leave);
    map.on("mousemove", onMove);
    map.on("mouseup", onUp);
    return () => {
      map.off("mousedown", "vertices", onVertexDown);
      map.off("mousedown", "midpoints", onMidDown);
      map.off("contextmenu", "vertices", onVertexRightClick);
      map.off("mouseenter", "vertices", hover);
      map.off("mouseleave", "vertices", leave);
      map.off("mouseenter", "midpoints", hover);
      map.off("mouseleave", "midpoints", leave);
      map.off("mousemove", onMove);
      map.off("mouseup", onUp);
    };
  }, [mapReady, editable]);

  // drop a stop: project the click onto the line, offer nearby existing stops
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !editable) return;
    map.getCanvas().style.cursor = mode === "add-stop" ? "crosshair" : "";
    const onClick = async (e: MapMouseEvent) => {
      if (modeRef.current !== "add-stop" || !route) return;
      const snap = nearestOnRoute(e.lngLat, route, null);
      const hits = await gateway<StopSearchHit[]>(
        `/v1/admin/stops?lat=${e.lngLat.lat}&lng=${e.lngLat.lng}`,
        { token: await token() },
      ).catch(() => []);
      setPending({ lat: e.lngLat.lat, lng: e.lngLat.lng, near: snap.s, nearby: hits.slice(0, 5) });
    };
    map.on("click", onClick);
    return () => void map.off("click", onClick);
  }, [mapReady, editable, mode, route]);

  // ── actions ──────────────────────────────────────────────────────────────
  async function save(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const body: { coords: LngLat[]; stops: DraftStop[] } = {
        coords,
        stops: ordered.map((s) =>
          s.stopId
            ? { stop_id: s.stopId, near_offset_m: s.offset }
            : {
                new_stop: {
                  name: s.name,
                  aliases: s.aliases ?? [],
                  area_name: s.area || null,
                  landmark: s.landmark || null,
                  lat: s.lat,
                  lng: s.lng,
                },
                near_offset_m: s.offset,
              },
        ),
      };
      const res = await gateway<{ warnings: { seq: number; distance_m: number }[] }>(
        `/v1/admin/routes/${routeId}`,
        { method: "PUT", token: await token(), body },
      );
      setWarnings(
        res.warnings.map((w) => `Stop ${w.seq} is ${w.distance_m} m from the line — check it.`),
      );
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    if (dirty && !(await save())) return;
    const names = ordered.map((s) => s.name);
    if (
      !confirm(
        `Publish ${detail!.name} v${detail!.version} with ${names.length} stops?\n\nThis version becomes frozen, and it replaces the current published version for drivers.`,
      )
    ) {
      return;
    }
    const attempt = async (confirmRepeated: boolean) =>
      gateway(`/v1/admin/routes/${routeId}/publish`, {
        token: await token(),
        body: { confirm_repeated_stops: confirmRepeated },
      });
    setBusy(true);
    try {
      try {
        await attempt(false);
      } catch (e) {
        if (!(e instanceof GatewayError) || e.status !== 409 || !/more than once/.test(e.message))
          throw e;
        if (!confirm(`${e.message}\n\nThat is right for a circular route. Publish anyway?`)) return;
        await attempt(true);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function newVersion() {
    const v = await gateway<{ id: string }>(`/v1/admin/routes/${routeId}/versions`, {
      token: await token(),
      body: {},
    });
    router.push(`/admin/routes/${v.id}`);
  }

  const state = detail?.published_at ? (detail.archived_at ? "Superseded" : "Published") : "Draft";
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
      {/* always mounted: the map is created on mount, so the container cannot appear later */}
      <div
        className="relative h-[70vh] overflow-hidden rounded-2xl border border-line"
        ref={mapEl}
      />
      {!detail ? (
        <aside className="text-muted">{error ?? "Loading route…"}</aside>
      ) : (
        <aside className="space-y-4">
          <section className="rounded-2xl border border-line bg-panel p-4">
            <h1 className="text-lg font-semibold">
              {detail.name} <span className="text-muted">v{detail.version}</span>
            </h1>
            <p className="text-sm text-muted">
              {state} · {detail.direction} · {km(route?.total ?? detail.total_distance_m)} ·{" "}
              {detail.source.replace("_", " ")}
            </p>
            {editable ? (
              <>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                  <button
                    className={`rounded border px-2 py-1 ${mode === "edit" ? "border-ink" : "border-line text-muted"}`}
                    onClick={() => setMode("edit")}
                  >
                    Shape line
                  </button>
                  <button
                    className={`rounded border px-2 py-1 ${mode === "add-stop" ? "border-ink" : "border-line text-muted"}`}
                    onClick={() => setMode("add-stop")}
                  >
                    Add stops
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted">
                  {mode === "edit"
                    ? "Zoom in: drag a white vertex to move it, drag a ring to add one, right-click a vertex to delete it."
                    : "Click the map where a stop is. It is placed on the line at the nearest point."}
                </p>
                <div className="mt-3 flex gap-2">
                  <button
                    className="flex-1 rounded-lg border border-line px-3 py-2 disabled:opacity-50"
                    disabled={!dirty || busy}
                    onClick={() => void save()}
                  >
                    {dirty ? "Save draft" : "Saved"}
                  </button>
                  <button
                    className="flex-1 rounded-lg bg-live px-3 py-2 font-semibold text-black disabled:opacity-50"
                    disabled={busy || ordered.length < 2}
                    onClick={() => void publish()}
                  >
                    Publish
                  </button>
                </div>
              </>
            ) : (
              <button
                className="mt-3 w-full rounded-lg border border-line px-3 py-2"
                onClick={() => void newVersion()}
              >
                Edit as a new version
              </button>
            )}
            {editable && detail.version > 1 && (
              <button
                className="mt-2 w-full text-sm text-muted underline"
                onClick={async () => {
                  if (
                    !confirm(
                      `Discard this draft (v${detail.version})? The published version is unaffected.`,
                    )
                  )
                    return;
                  await gateway(`/v1/admin/routes/${routeId}`, {
                    method: "DELETE",
                    token: await token(),
                  });
                  router.push("/admin/routes");
                }}
              >
                Discard draft
              </button>
            )}
            <ErrorText>{error}</ErrorText>
            {warnings.map((w) => (
              <p key={w} className="mt-1 text-sm text-degraded">
                {w}
              </p>
            ))}
          </section>

          {pending && (
            <NewStopForm
              pending={pending}
              onCancel={() => setPending(null)}
              onAdd={(s) => {
                setStops((prev) => [...prev, { ...s, key: `s${++keySeq}`, near: pending.near }]);
                setDirty(true);
                setPending(null);
              }}
            />
          )}

          <section className="rounded-2xl border border-line bg-panel p-4">
            <h2 className="font-semibold">Stops, in route order</h2>
            <ol className="mt-2 space-y-1 text-sm">
              {ordered.map((s, i) => {
                // only an existing stop can be served twice; a new stop has no id to match on
                const repeat = !!s.stopId && ordered.findIndex((o) => o.stopId === s.stopId) !== i;
                return (
                  <li key={s.key} className="flex items-baseline gap-2">
                    <span className="w-5 text-right text-muted">{i + 1}</span>
                    <span className="flex-1">
                      {s.name}
                      {!s.stopId && <span className="text-degraded"> · new</span>}
                      {repeat && <span className="text-degraded"> · served twice</span>}
                      {s.distance > 50 && (
                        <span className="text-dark">
                          {" "}
                          · {Math.round(s.distance)} m off the line
                        </span>
                      )}
                    </span>
                    <span className="text-muted">{km(s.offset)}</span>
                    {editable && (
                      <button
                        aria-label={`remove ${s.name}`}
                        className="text-muted"
                        onClick={() => {
                          setStops((prev) => prev.filter((p) => p.key !== s.key));
                          setDirty(true);
                        }}
                      >
                        ×
                      </button>
                    )}
                  </li>
                );
              })}
              {!ordered.length && <li className="text-muted">No stops yet.</li>}
            </ol>
          </section>
        </aside>
      )}
    </div>
  );
}

function NewStopForm({
  pending,
  onAdd,
  onCancel,
}: {
  pending: { lat: number; lng: number; nearby: StopSearchHit[] };
  onAdd: (s: Omit<EditStop, "key" | "near">) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [area, setArea] = useState("");
  const [landmark, setLandmark] = useState("");
  const [aliases, setAliases] = useState("");
  const field = "w-full rounded border border-line bg-canvas px-2 py-1 text-sm";
  return (
    <section className="rounded-2xl border border-degraded bg-panel p-4">
      <h2 className="font-semibold">Stop here</h2>
      {pending.nearby.length > 0 && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-muted">
            Existing stops nearby — reuse one instead of creating a twin:
          </p>
          {pending.nearby.map((h) => (
            <button
              key={h.id}
              className="block w-full rounded border border-line px-2 py-1 text-left text-sm"
              onClick={() =>
                onAdd({ stopId: h.id, name: h.name, area: h.area_name, lat: h.lat, lng: h.lng })
              }
            >
              {h.name} {h.area_name && <span className="text-muted">· {h.area_name}</span>}
            </button>
          ))}
        </div>
      )}
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          onAdd({
            name: name.trim(),
            area: area.trim() || null,
            landmark: landmark.trim() || null,
            aliases: aliases
              .split(",")
              .map((a) => a.trim())
              .filter(Boolean),
            lat: pending.lat,
            lng: pending.lng,
          });
        }}
      >
        <input
          className={field}
          placeholder="Stop name (what students say)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          className={field}
          placeholder="Area, e.g. Dilsukhnagar"
          value={area}
          onChange={(e) => setArea(e.target.value)}
        />
        <input
          className={field}
          placeholder="Landmark, e.g. opposite Konark Theatre"
          value={landmark}
          onChange={(e) => setLandmark(e.target.value)}
        />
        <input
          className={field}
          placeholder="Other spellings, comma-separated"
          value={aliases}
          onChange={(e) => setAliases(e.target.value)}
        />
        <div className="flex gap-2">
          <button className="rounded bg-live px-3 py-1 font-semibold text-black">Add stop</button>
          <button type="button" className="text-muted underline" onClick={onCancel}>
            cancel
          </button>
        </div>
      </form>
    </section>
  );
}
