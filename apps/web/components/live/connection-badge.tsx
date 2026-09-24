"use client";
import { useFleet } from "@/lib/store/fleet";

const TEXT = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline — showing last known positions",
} as const;

/** The visible connection indicator (BUILD_PLAN Stage 3): never let a dead stream look live. */
export function ConnectionBadge() {
  const state = useFleet((s) => s.connection);
  const tone =
    state === "live"
      ? "border-live text-live"
      : state === "offline"
        ? "border-dark text-dark"
        : "border-degraded text-degraded";
  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="connection"
      data-state={state}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${state === "live" ? "bg-live" : state === "offline" ? "bg-dark" : "bg-degraded"}`}
      />
      {TEXT[state]}
    </span>
  );
}
