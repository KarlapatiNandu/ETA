"use client";
import "maplibre-gl/dist/maplibre-gl.css";
import maplibregl from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { Me } from "@busmitra/contracts";
import { accessToken } from "@/components/live/use-live-stream";
import { publicEnv } from "@/lib/env";
import { gateway } from "@/lib/gateway";

/**
 * The home pin (BUILD_PLAN Stage 5 "Location pinning"): drag the pin, or use the phone's
 * location once. Stored coarsened to ~100 m by the database (ARCH §10), which is all a walking
 * ETA needs — and it is never shown to admins or other students.
 */
export function HomePinEditor() {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const marker = useRef<maplibregl.Marker | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      const m = await gateway<Me>("/v1/me", { token: (await accessToken()) ?? undefined });
      setMe(m);
      if (m.home) setPin(m.home);
    })().catch(() => setMsg("Could not load your pin."));
  }, []);

  useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: `/api/map-style?tiles=${encodeURIComponent(publicEnv.tilesUrl)}`,
      center: [78.4867, 17.385],
      zoom: 11,
      attributionControl: { compact: true },
    });
    m.on("click", (e) => setPin({ lat: e.lngLat.lat, lng: e.lngLat.lng }));
    map.current = m;
    return () => {
      m.remove();
      map.current = null;
      marker.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m || !pin) return;
    if (!marker.current) {
      marker.current = new maplibregl.Marker({ draggable: true, color: "#2fd27a" })
        .setLngLat([pin.lng, pin.lat])
        .addTo(m);
      marker.current.on("dragend", () => {
        const p = marker.current!.getLngLat();
        setPin({ lat: p.lat, lng: p.lng });
      });
      m.jumpTo({ center: [pin.lng, pin.lat], zoom: 15 });
    } else marker.current.setLngLat([pin.lng, pin.lat]);
  }, [pin]);

  const useMyLocation = () => {
    if (!navigator.geolocation)
      return setMsg("This browser cannot share its location. Drop the pin on the map.");
    setMsg("Finding you…");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setPin({ lat: p.coords.latitude, lng: p.coords.longitude });
        map.current?.jumpTo({ center: [p.coords.longitude, p.coords.latitude], zoom: 15 });
        setMsg(null);
      },
      () => setMsg("Location was not shared. Drop the pin on the map instead."),
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 300_000 },
    );
  };

  const save = async () => {
    if (!pin) return;
    setBusy(true);
    try {
      const m = await gateway<Me>("/v1/me/home", {
        method: "PUT",
        token: (await accessToken()) ?? undefined,
        body: { lat: pin.lat, lng: pin.lng, label: "Home" },
      });
      setMe(m);
      setMsg("Saved. Walking times now start from here.");
    } catch {
      setMsg("Could not save the pin.");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    setBusy(true);
    try {
      const m = await gateway<Me>("/v1/me/home", {
        method: "DELETE",
        token: (await accessToken()) ?? undefined,
      });
      setMe(m);
      setPin(null);
      marker.current?.remove();
      marker.current = null;
      setMsg("Pin removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mx-auto mt-6 w-full max-w-md rounded-2xl border border-line bg-panel p-6"
      data-testid="home-pin"
    >
      <h2 className="text-lg font-semibold">Home pin</h2>
      <p className="mt-1 text-sm text-muted">
        Used only to work out how long it takes you to reach your stop. We keep it to about 100 m,
        and nobody else — not even the Transport Department — can see it.
      </p>
      <div ref={el} className="mt-3 h-56 w-full overflow-hidden rounded-xl border border-line" />
      <div className="mt-3 flex gap-2">
        <button onClick={useMyLocation} className="rounded-lg border border-line px-3 py-2 text-sm">
          Use my location
        </button>
        <button
          onClick={() => void save()}
          disabled={!pin || busy}
          className="grow rounded-lg bg-live px-3 py-2 text-sm font-semibold text-live-ink disabled:opacity-50"
        >
          Save pin
        </button>
        {me?.home && (
          <button
            onClick={() => void clear()}
            disabled={busy}
            className="rounded-lg border border-line px-3 py-2 text-sm"
          >
            Remove
          </button>
        )}
      </div>
      {msg && (
        <p role="status" className="mt-2 text-sm text-muted">
          {msg}
        </p>
      )}
    </section>
  );
}
