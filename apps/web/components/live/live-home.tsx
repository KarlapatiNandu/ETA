"use client";
import { useCallback, useRef, useState } from "react";
import { LiveMap } from "@/components/map/live-map";
import { useFleet } from "@/lib/store/fleet";
import { BusSheet } from "./bus-sheet";
import { ConnectionBadge } from "./connection-badge";
import { useFocusPart } from "./live-provider";
import { useNetwork } from "./use-network";

/**
 * The live half of the student home (Stage 3): the map and the bus sheet. The map contributes
 * its viewport to the stream focus (ARCH §7) — buses in view, plus the one selected. The hero
 * ETA card (Stage 5) is passed in as children and sits above the map (ARCH §8: the hero is the
 * ETA, not the map).
 */
export function LiveHome({ children }: { children?: React.ReactNode }) {
  const { network, error } = useNetwork();
  const [selected, setSelected] = useState<string | null>(null);
  const [bbox, setBbox] = useState<[number, number, number, number] | null>(null);
  const running = useFleet((s) => Object.keys(s.buses).length);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useFocusPart("map", bbox ? { bbox, busIds: selected ? [selected] : [] } : null);

  const onViewport = useCallback((b: [number, number, number, number]) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setBbox(b), 400);
  }, []);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <ConnectionBadge />
        <span className="text-xs text-muted" data-testid="running-count">
          {running} {running === 1 ? "bus" : "buses"} in view
        </span>
      </div>
      {children}
      {error && !network && <p className="mb-2 text-sm text-degraded">{error}</p>}
      <LiveMap
        network={network}
        selected={selected}
        onSelect={setSelected}
        onViewport={onViewport}
        className="h-[62dvh] min-h-[360px] w-full overflow-hidden rounded-2xl border border-line"
      />
      {selected && (
        <BusSheet busId={selected} network={network} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}
