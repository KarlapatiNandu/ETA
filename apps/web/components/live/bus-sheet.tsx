"use client";
import { useEffect, useState } from "react";
import type { Network } from "@busmitra/contracts";
import { formatAge, formatClock, PRESENCE_STYLE } from "@busmitra/ui";
import { serverNow, useFleet } from "@/lib/store/fleet";
import { FavouriteToggle } from "@/components/notifications/favourite-toggle";

/**
 * The bus detail sheet (BUILD_PLAN Stage 3). The degraded states get the same typographic care
 * as a live one (ARCH §8): "last seen 2 min 14 s ago" is information, not an error.
 */
export function BusSheet({
  busId,
  network,
  onClose,
}: {
  busId: string;
  network: Network | null;
  onClose: () => void;
}) {
  const bus = useFleet((s) => s.buses[busId]);
  const offset = useFleet((s) => s.clockOffsetMs);
  const [now, setNow] = useState(() => serverNow(offset));
  useEffect(() => {
    const t = setInterval(() => setNow(serverNow(offset)), 1000);
    return () => clearInterval(t);
  }, [offset]);

  const number = network?.buses.find((b) => b.id === busId)?.number ?? "?";
  if (!bus) {
    return (
      <Sheet onClose={onClose} title={`Bus ${number}`}>
        <p className="text-muted">Not running right now.</p>
        <FavouriteToggle busId={busId} number={number} />
      </Sheet>
    );
  }
  const route = network?.routes.find((r) => r.id === bus.routeId);
  const next = route?.stops[(bus.seq ?? -1) + 1];
  const age = (now - Date.parse(bus.ts)) / 1000;
  const style = PRESENCE_STYLE[bus.state];
  const tone =
    bus.state === "LIVE" ? "text-live" : bus.state === "DEGRADED" ? "text-degraded" : "text-dark";

  return (
    <Sheet onClose={onClose} title={`Bus ${number}`} subtitle={route?.name}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        <div>
          <dt className="text-muted">Status</dt>
          <dd className={`font-semibold ${tone}`} data-testid="bus-state">
            {style.label}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Last position</dt>
          <dd className="font-semibold">
            {formatClock(bus.ts)} · {formatAge(age)} ago
          </dd>
        </div>
        <div>
          <dt className="text-muted">Next stop</dt>
          <dd className="font-semibold">{bus.s === null ? "—" : (next?.name ?? "End of route")}</dd>
        </div>
        <div>
          <dt className="text-muted">Speed</dt>
          <dd className="font-semibold">
            {bus.state === "LIVE" && bus.spd !== null ? `${Math.round(bus.spd)} km/h` : "—"}
          </dd>
        </div>
      </dl>
      {bus.state === "DARK" && (
        <p className="mt-4 rounded-lg border border-dark/40 p-3 text-sm">
          {bus.deadZone
            ? `In a known dead zone${bus.deadZone.label ? ` near ${bus.deadZone.label}` : ""}. It usually clears in about ${formatAge(bus.deadZone.avgOutageS)}.`
            : `Signal lost at ${formatClock(bus.ts)}. The marker shows where it last was — it may have moved since.`}
        </p>
      )}
      {bus.state === "DEGRADED" && (
        <p className="mt-4 rounded-lg border border-degraded/40 p-3 text-sm">
          This bus has missed its last updates. Its position may be out of date.
        </p>
      )}
      {bus.flag === "off_route" && (
        <p className="mt-4 rounded-lg border border-degraded/40 p-3 text-sm">
          Bus {number} is off its usual route. Arrival times are paused until it rejoins.
        </p>
      )}
      <FavouriteToggle busId={busId} number={number} />
    </Sheet>
  );
}

function Sheet({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-testid="bus-sheet"
      className="mt-3 rounded-2xl border border-line bg-panel p-4"
    >
      <header className="mb-3 flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
        </div>
        <button onClick={onClose} className="text-sm text-muted" aria-label="Close">
          Close
        </button>
      </header>
      {children}
    </section>
  );
}
