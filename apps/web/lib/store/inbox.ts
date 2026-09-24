"use client";
import { create } from "zustand";
import type { SseEvent } from "@busmitra/contracts";

/**
 * The notification center's live edge (Stage 6): the unread badge, unacknowledged T0s, the
 * latest arrival (shown as an in-app banner when the tab is open), and live ticket statuses.
 * Per-user frames are never replayed (invariant 9), so the counts are re-derived from
 * /v1/notifications/summary whenever the stream (re)connects — `setSummary`.
 */
export interface Arrival {
  id: string;
  tier: number;
  title: string;
  body: string;
}

interface InboxState {
  unread: number;
  unackedCritical: number;
  latest: Arrival | null;
  tickets: Record<string, string>;
  setSummary: (s: { unread: number; unacked_critical: number }) => void;
  apply: (e: SseEvent) => void;
  dismiss: () => void;
}

export const useInbox = create<InboxState>((set) => ({
  unread: 0,
  unackedCritical: 0,
  latest: null,
  tickets: {},
  setSummary: (s) => set({ unread: s.unread, unackedCritical: s.unacked_critical }),
  apply: (e) =>
    set((st) => {
      if (e.type === "notification")
        return {
          unread: st.unread + 1,
          unackedCritical: st.unackedCritical + (e.data.tier === 0 ? 1 : 0),
          // T4 is ambient: it lands in the center without interrupting
          latest:
            e.data.tier <= 3
              ? { id: e.data.id, tier: e.data.tier, title: e.data.title, body: e.data.body }
              : st.latest,
        };
      if (e.type === "ticket.update")
        return { tickets: { ...st.tickets, [e.data.id]: e.data.status } };
      return st;
    }),
  dismiss: () => set({ latest: null }),
}));
