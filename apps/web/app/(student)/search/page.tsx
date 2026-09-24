"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { StopSearchResponse } from "@busmitra/contracts";
import { useServerNow } from "@/components/eta/use-now";
import { accessToken } from "@/components/live/use-live-stream";
import { BusLine } from "@/components/search/bus-line";
import { gateway } from "@/lib/gateway";

/**
 * Stop search (BUILD_PLAN Stage 5): type a stop the way it sounds — "dilsuknagar", "kothi" —
 * or a locality, and see every stop within 2 km with the buses that serve it.
 */
export default function SearchPage() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<StopSearchResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const now = useServerNow();

  useEffect(() => {
    const text = q.trim();
    if (text.length < 2) {
      setRes(null);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        const r = await gateway<StopSearchResponse>(
          `/v1/search/stops?q=${encodeURIComponent(text)}`,
          {
            token: (await accessToken()) ?? undefined,
          },
        );
        if (mine === seq.current) {
          setRes(r);
          setError(null);
        }
      } catch {
        if (mine === seq.current) setError("Search is not answering. Try again in a moment.");
      } finally {
        if (mine === seq.current) setBusy(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <section>
      <label className="block">
        <span className="sr-only">Stop or area</span>
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Stop or area — e.g. Dilsukhnagar"
          className="w-full rounded-xl border border-line bg-panel px-4 py-3 text-lg outline-none focus:border-live"
          data-testid="search-input"
          inputMode="search"
          autoComplete="off"
        />
      </label>
      {busy && <p className="mt-2 text-sm text-muted">Searching…</p>}
      {error && <p className="mt-2 text-sm text-degraded">{error}</p>}
      {res && res.anchor?.source === "geocoder" && (
        <p className="mt-3 text-sm text-muted">Stops near {res.anchor.label}</p>
      )}
      {res && res.results.length === 0 && !busy && (
        <p className="mt-4 text-muted">No stops found for “{res.query}”. Try the area name.</p>
      )}
      <ul className="mt-3 space-y-2" data-testid="search-results">
        {res?.results.map((s) => (
          <li key={s.stopId}>
            <Link
              href={`/stop/${s.stopId}`}
              className="block rounded-xl border border-line bg-panel p-4"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold" data-testid="result-name">
                  {s.name}
                </span>
                <span className="text-xs text-muted">
                  {s.distanceM !== null && s.match === "nearby"
                    ? `${(s.distanceM / 1000).toFixed(1)} km away`
                    : s.areaName && s.areaName !== s.name
                      ? s.areaName
                      : ""}
                </span>
              </div>
              {s.landmark && <p className="text-xs text-muted">{s.landmark}</p>}
              <div className="mt-2 space-y-1">
                {s.buses.slice(0, 4).map((b) => (
                  <BusLine key={b.busId} bus={b} now={now} />
                ))}
                {s.buses.length > 4 && (
                  <p className="text-xs text-muted">+{s.buses.length - 4} more</p>
                )}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
