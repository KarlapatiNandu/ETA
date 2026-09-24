"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { SubscriptionView } from "@busmitra/contracts";
import { formatAge, formatClock } from "@busmitra/ui";
import { useFocusPart } from "@/components/live/live-provider";
import { accessToken } from "@/components/live/use-live-stream";
import { useNetwork } from "@/components/live/use-network";
import { gateway } from "@/lib/gateway";
import { useFleet } from "@/lib/store/fleet";
import { etaKey, remaining } from "@/lib/store/fleet-reducer";
import { EtaRange } from "./eta-range";
import { RouteTimeline } from "./route-timeline";
import { useServerNow } from "./use-now";

/**
 * The hero (ARCH §8): "Bus 14 · 6 min · Dilsukhnagar", unmissable, above the map — most sessions
 * last eleven seconds and answer exactly one question. Below it, when to leave:
 *
 *   leave in = remaining p50 − walk − buffer − (p90 − p50)
 *
 * the same comparison the leave-now evaluator makes (ARCH §5.6), so the countdown on screen and
 * the alert (Stage 6) agree. Every degraded state is stated, never papered over (invariant 2).
 */
export function HeroCard() {
  const [sub, setSub] = useState<SubscriptionView | null | undefined>(undefined);
  const { network } = useNetwork();
  const now = useServerNow();

  const load = useCallback(async () => {
    try {
      const r = await gateway<{ subscription: SubscriptionView | null }>("/v1/me/subscription", {
        token: (await accessToken()) ?? undefined,
      });
      setSub(r.subscription);
    } catch {
      /* keep what we have; the next poll retries */
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, [load]);

  useFocusPart("hero", sub ? { busIds: [sub.busId], stopIds: [sub.stop.id] } : null);

  const bus = useFleet((s) => (sub ? s.buses[sub.busId] : undefined));
  const eta = useFleet((s) => (sub ? s.etas[etaKey(sub.tripId, sub.stop.id)] : undefined));
  const marks = useFleet((s) => (sub ? s.stops[sub.tripId] : undefined));

  if (sub === undefined)
    return <section className="mb-3 h-28 animate-pulse rounded-2xl border border-line bg-panel" />;
  if (sub === null) {
    return (
      <section
        className="mb-3 rounded-2xl border border-line bg-panel p-5"
        data-testid="hero-empty"
      >
        <p className="text-lg font-semibold">Which bus are you taking today?</p>
        <p className="mt-1 text-sm text-muted">
          Find your stop and follow a bus to see when to leave.
        </p>
        <Link
          href="/search"
          className="mt-3 inline-block rounded-lg bg-live px-4 py-2 font-semibold text-live-ink"
        >
          Find your stop
        </Link>
      </section>
    );
  }

  const route = network?.routes.find((r) => r.id === sub.routeId);
  const onTrip = bus && bus.tripId === sub.tripId;
  const left = eta ? remaining(eta, now) : null;
  const spread = eta ? Math.max(0, eta.p90 - eta.p50) : 0;
  const leaveIn =
    left && sub.travelTimeS !== null ? left.p50 - sub.travelTimeS - sub.bufferS - spread : null;

  let status: React.ReactNode;
  if (sub.state === "missed")
    status = (
      <span className="text-degraded">
        Bus {sub.busNumber} has passed {sub.stop.name}.
      </span>
    );
  else if (!onTrip)
    status = <span className="text-muted">Bus {sub.busNumber} is not reporting yet.</span>;
  else if (bus.state === "DARK")
    status = (
      <span className="text-dark">
        Signal lost at {formatClock(bus.ts)}. No arrival time until it reports again.
      </span>
    );
  else if (!left) status = <span className="text-muted">Working out the arrival time…</span>;
  else
    status = (
      <>
        {bus.state === "DEGRADED" && (
          <span className="block text-sm text-degraded">
            Last update {formatAge((now - Date.parse(bus.ts)) / 1000)} ago — this may be out of
            date.
          </span>
        )}
      </>
    );

  const leaveText =
    sub.notifiedDepartureAt || (leaveIn !== null && leaveIn <= 0)
      ? "Leave now"
      : leaveIn !== null
        ? `Leave in ${Math.max(1, Math.floor(leaveIn / 60))} min`
        : null;

  return (
    <section className="mb-3 rounded-2xl border border-line bg-panel p-5" data-testid="hero">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{sub.routeName}</p>
          <h1 className="mt-0.5 text-2xl font-bold tabular-nums">
            Bus {sub.busNumber}
            {left && onTrip && bus.state !== "DARK" && (
              <>
                {" · "}
                <EtaRange p50={left.p50} p90={left.p90} confidence={eta?.confidence ?? null} />
              </>
            )}
          </h1>
          <p className="mt-0.5 font-medium">{sub.stop.name}</p>
        </div>
        <button
          className="text-sm text-muted"
          onClick={async () => {
            await gateway(`/v1/me/subscription/${sub.id}`, {
              method: "DELETE",
              token: (await accessToken()) ?? undefined,
            });
            setSub(null);
          }}
        >
          Unfollow
        </button>
      </div>
      <div className="mt-2 text-sm">{status}</div>
      {leaveText && onTrip && bus.state !== "DARK" && sub.state === "active" && (
        <p
          data-testid="leave-in"
          className={`mt-3 rounded-lg px-3 py-2 text-lg font-bold ${
            leaveText === "Leave now" ? "bg-live text-live-ink" : "border border-line"
          }`}
        >
          {leaveText}
          {sub.travelTimeS !== null && (
            <span className="ml-2 text-sm font-normal">
              ({Math.round(sub.travelTimeS / 60)} min{" "}
              {sub.travelMode === "foot" ? "walk" : "journey"} + {Math.round(sub.bufferS / 60)} min
              margin
              {spread >= 60
                ? ` + ${Math.round(spread / 60)} min because the bus's time is uncertain`
                : ""}
              )
            </span>
          )}
        </p>
      )}
      {sub.travelTimeS === null && (
        <p className="mt-3 text-sm text-muted">
          <Link href="/settings" className="underline">
            Pin your home
          </Link>{" "}
          to see when to leave.
        </p>
      )}
      {route && (
        <RouteTimeline
          route={route}
          reachedIndex={onTrip ? (bus.seq ?? -1) : -1}
          marks={marks ?? []}
          targetStopId={sub.stop.id}
          targetEta={
            left ? (
              <EtaRange p50={left.p50} p90={left.p90} confidence={eta?.confidence ?? null} />
            ) : (
              "—"
            )
          }
        />
      )}
    </section>
  );
}
