"use client";
import type { BusAtStop } from "@busmitra/contracts";
import { formatClock } from "@busmitra/ui";
import { EtaRange } from "@/components/eta/eta-range";
import type { StopEta } from "@/lib/store/fleet-reducer";
import { remaining } from "@/lib/store/fleet-reducer";

/**
 * One bus at one stop, the way BUILD_PLAN Stage 5 renders it:
 *   Bus 14 · 4–6 min · running  /  Bus 22 · 07:40 · scheduled  /  Bus 27 · not running today
 * A running bus without a live ETA says why instead of showing a number.
 */
export function BusLine({
  bus,
  live,
  now,
}: {
  bus: BusAtStop;
  live?: StopEta | null;
  now: number;
}) {
  const eta = live ?? (bus.eta ? { ...bus.eta } : null);
  let detail: React.ReactNode;
  let tone = "text-muted";
  if (bus.status === "running") {
    tone = "text-live";
    if (bus.presence === "DARK") {
      detail = "signal lost";
      tone = "text-dark";
    } else if (eta) {
      const left = remaining(eta, now);
      detail = <EtaRange p50={left.p50} p90={left.p90} confidence={eta.confidence ?? null} />;
    } else detail = bus.presence ? "on its way" : "starting";
  } else if (bus.status === "scheduled") {
    detail = bus.scheduledAt ? formatClock(bus.scheduledAt) : "time not set";
  } else if (bus.status === "passed") detail = "already passed";
  else detail = "not running today";

  return (
    <span
      className="flex items-center justify-between gap-2 text-sm"
      data-testid="bus-line"
      data-status={bus.status}
    >
      <span className="font-semibold">Bus {bus.number}</span>
      <span className={`${tone} tabular-nums`}>
        {detail}
        {bus.status === "running" && bus.presence === "DEGRADED" && (
          <span className="ml-1 text-degraded">(delayed signal)</span>
        )}
        {(bus.status === "running" || bus.status === "scheduled") && (
          <span className="ml-1 text-xs text-muted">· {bus.status}</span>
        )}
      </span>
    </span>
  );
}
