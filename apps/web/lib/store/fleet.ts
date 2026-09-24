"use client";
import { create } from "zustand";
import type { SseEvent } from "@busmitra/contracts";
import type { ConnectionState } from "../sse/client";
import { applyEvent, initialFleet, type FleetState } from "./fleet-reducer";

/**
 * The live fleet (ARCH §2.1: Zustand for the SSE-fed stream, never TanStack Query — a cache is
 * not a stream). The rules live in fleet-reducer.ts; this is the React binding.
 */
/** One page's share of the stream focus (ARCH §7): the map's viewport, a stop's ETAs, … */
export interface FocusPart {
  bbox?: [number, number, number, number] | null;
  busIds?: string[];
  stopIds?: string[];
}

export interface FleetStore extends FleetState {
  focusParts: Record<string, FocusPart>;
  setFocusPart: (key: string, part: FocusPart | null) => void;
  connection: ConnectionState;
  connectionDetail: string | null;
  /** local ms at which each bus's latest position frame was applied (latency measurement) */
  appliedAt: Record<string, number>;
  apply: (e: SseEvent) => void;
  setConnection: (s: ConnectionState, detail?: string) => void;
}

export const useFleet = create<FleetStore>((set) => ({
  ...initialFleet(),
  connection: "connecting",
  connectionDetail: null,
  appliedAt: {},
  focusParts: {},
  setFocusPart: (key, part) =>
    set((st) => {
      const { [key]: _old, ...rest } = st.focusParts;
      return { focusParts: part ? { ...rest, [key]: part } : rest };
    }),
  apply: (e) =>
    set((st) => {
      const next = applyEvent(st, e, Date.now());
      if (next === st) return st;
      const appliedAt =
        e.type === "bus.position" && next.buses[e.data.id] !== st.buses[e.data.id]
          ? { ...st.appliedAt, [e.data.id]: Date.now() }
          : st.appliedAt;
      return { ...next, appliedAt };
    }),
  setConnection: (connection, detail) => set({ connection, connectionDetail: detail ?? null }),
}));

/** Now, on the gateway's clock. */
export const serverNow = (offsetMs: number) => Date.now() + offsetMs;

/** Merge every page's focus part into the one focus the stream is scoped to. */
export function mergeFocus(parts: Record<string, FocusPart>): FocusPart | null {
  const all = Object.values(parts);
  if (!all.length) return null;
  const bbox = all.find((p) => p.bbox)?.bbox ?? null;
  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    bbox,
    busIds: uniq(all.flatMap((p) => p.busIds ?? [])).slice(0, 50),
    stopIds: uniq(all.flatMap((p) => p.stopIds ?? [])).slice(0, 20),
  };
}
