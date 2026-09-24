"use client";
import type { NetworkRoute } from "@busmitra/contracts";
import { formatClock } from "@busmitra/ui";
import type { StopMark } from "@/lib/store/fleet-reducer";

/**
 * The vertical route timeline (BUILD_PLAN Stage 5): every stop of the trip, what has happened at
 * each, where the bus is, and the student's stop. Stop progress fills the line (ARCH §8: motion
 * only to show causality). A stop the bus went past without stopping says so — it is not
 * pretended to have been served.
 */
export function RouteTimeline({
  route,
  reachedIndex,
  marks,
  targetStopId,
  targetEta,
}: {
  route: NetworkRoute;
  /** highest stop index reached (the bus's `seq`), -1 before the first */
  reachedIndex: number;
  marks: StopMark[];
  targetStopId: string;
  targetEta: React.ReactNode;
}) {
  return (
    <ol className="relative mt-4 space-y-0" aria-label={`${route.name} stops`}>
      {route.stops.map((st, i) => {
        const passed = i <= reachedIndex;
        const next = i === reachedIndex + 1;
        const mine = st.stopId === targetStopId;
        const arrived = marks.find((m) => m.seq === st.seq && m.event === "arrived");
        const skipped = marks.find((m) => m.seq === st.seq && m.event === "skipped");
        return (
          <li
            key={st.seq}
            className="relative flex gap-3 pb-3 last:pb-0"
            data-testid={mine ? "timeline-target" : undefined}
          >
            <div className="flex w-4 flex-col items-center">
              <span
                aria-hidden
                className={`mt-1 h-3 w-3 shrink-0 rounded-full border-2 ${
                  passed
                    ? "border-live bg-live"
                    : next
                      ? "border-live bg-canvas"
                      : "border-line bg-canvas"
                } ${mine ? "ring-2 ring-offset-2 ring-offset-panel ring-[var(--bm-focus)]" : ""}`}
              />
              {i < route.stops.length - 1 && (
                <span
                  aria-hidden
                  className={`w-0.5 grow ${i < reachedIndex ? "bg-live" : "bg-line"}`}
                />
              )}
            </div>
            <div
              className={`-mt-0.5 flex grow items-baseline justify-between gap-2 text-sm ${passed ? "text-muted" : ""}`}
            >
              <span className={mine ? "font-semibold text-ink" : ""}>
                {st.name}
                {mine && <span className="ml-2 text-xs text-muted">your stop</span>}
              </span>
              <span className="shrink-0 text-xs">
                {skipped
                  ? "passed without stopping"
                  : arrived?.at
                    ? formatClock(arrived.at)
                    : passed
                      ? "passed"
                      : mine
                        ? targetEta
                        : next
                          ? "next"
                          : ""}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
