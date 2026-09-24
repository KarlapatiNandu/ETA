"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import type { StopDetail } from "@busmitra/contracts";
import { formatAge } from "@busmitra/ui";
import { useServerNow } from "@/components/eta/use-now";
import { ConnectionBadge } from "@/components/live/connection-badge";
import { useFocusPart } from "@/components/live/live-provider";
import { accessToken } from "@/components/live/use-live-stream";
import { BusLine } from "@/components/search/bus-line";
import { gateway, GatewayError } from "@/lib/gateway";
import { useFleet } from "@/lib/store/fleet";
import { etaKey } from "@/lib/store/fleet-reducer";

/**
 * A stop (BUILD_PLAN Stage 5): the buses that serve it with live ETAs, how long it takes to get
 * there from the student's pin, and "Take this bus" — the trip subscription that drives the
 * hero card and, from Stage 6, the leave-now alert.
 */
export default function StopPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [stop, setStop] = useState<StopDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const now = useServerNow();
  const etas = useFleet((s) => s.etas);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const d = await gateway<StopDetail>(`/v1/stops/${id}`, {
          token: (await accessToken()) ?? undefined,
        });
        if (!cancelled) setStop(d);
      } catch (err) {
        if (!cancelled)
          setError(
            err instanceof GatewayError && err.status === 404
              ? "No such stop."
              : "Could not load this stop.",
          );
      }
    };
    void load();
    // membership (which buses run, which passed) changes slowly; ETAs arrive over the stream
    const t = setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [id]);

  const running = stop?.buses.filter((b) => b.status === "running").map((b) => b.busId) ?? [];
  useFocusPart("stop", stop ? { stopIds: [stop.stopId], busIds: running } : null);

  const follow = async (tripId: string) => {
    setBusy(tripId);
    try {
      await gateway("/v1/me/subscription", {
        token: (await accessToken()) ?? undefined,
        body: { tripId, stopId: id },
      });
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not follow that bus.");
      setBusy(null);
    }
  };

  if (error && !stop) return <p className="text-degraded">{error}</p>;
  if (!stop)
    return <section className="h-40 animate-pulse rounded-2xl border border-line bg-panel" />;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <Link href="/search" className="text-sm text-muted">
          ← Search
        </Link>
        <ConnectionBadge />
      </div>
      <div className="rounded-2xl border border-line bg-panel p-5">
        <h1 className="text-2xl font-bold" data-testid="stop-name">
          {stop.name}
        </h1>
        {(stop.areaName || stop.landmark) && (
          <p className="text-sm text-muted">
            {[stop.landmark, stop.areaName].filter(Boolean).join(" · ")}
          </p>
        )}
        <p className="mt-2 text-sm" data-testid="walk">
          {stop.walk ? (
            <>
              {formatAge(stop.walk.durationS)}{" "}
              {stop.walk.mode === "foot" ? "walk" : `by ${stop.walk.mode}`} from home ·{" "}
              {(stop.walk.distanceM / 1000).toFixed(1)} km
            </>
          ) : (
            <Link href="/settings" className="text-muted underline">
              Pin your home to see how long it takes to get here
            </Link>
          )}
        </p>
        {error && <p className="mt-2 text-sm text-degraded">{error}</p>}
        <ul className="mt-4 space-y-3">
          {stop.buses.map((b) => (
            <li key={b.busId} className="rounded-xl border border-line p-3">
              <BusLine
                bus={b}
                live={b.tripId ? etas[etaKey(b.tripId, stop.stopId)] : null}
                now={now}
              />
              <p className="mt-0.5 text-xs text-muted">{b.routeName}</p>
              {(b.status === "running" || b.status === "scheduled") && b.tripId && (
                <button
                  onClick={() => void follow(b.tripId!)}
                  disabled={busy !== null}
                  className="mt-2 w-full rounded-lg bg-live px-3 py-2 text-sm font-semibold text-live-ink disabled:opacity-50"
                >
                  {busy === b.tripId ? "Following…" : `Take Bus ${b.number} from here`}
                </button>
              )}
            </li>
          ))}
          {stop.buses.length === 0 && <li className="text-muted">No bus serves this stop.</li>}
        </ul>
      </div>
    </section>
  );
}
