/**
 * @busmitra/ui — shared design tokens (ARCH §8). CSS variables live in tokens.css; this module
 * is the part code needs: how each presence state looks and reads.
 *
 * Every state has a colour, a shape and a word. Colour-blind riders (≈ 1 in 12 men) must be able
 * to tell a live bus from a lost one, and the word is what a screen reader says.
 */

export type Presence = "LIVE" | "DEGRADED" | "DARK" | "ENDED";

export interface PresenceStyle {
  /** CSS variable holding the state colour */
  colorVar: string;
  inkVar: string;
  /** solid = live, dashed = late, hollow = lost */
  shape: "solid" | "dashed" | "hollow";
  label: string;
}

export const PRESENCE_STYLE: Record<Presence, PresenceStyle> = {
  LIVE: { colorVar: "--bm-live", inkVar: "--bm-live-ink", shape: "solid", label: "Live" },
  DEGRADED: {
    colorVar: "--bm-degraded",
    inkVar: "--bm-degraded-ink",
    shape: "dashed",
    label: "Delayed signal",
  },
  DARK: { colorVar: "--bm-dark", inkVar: "--bm-dark-ink", shape: "hollow", label: "Signal lost" },
  ENDED: { colorVar: "--bm-muted", inkVar: "--bm-canvas", shape: "hollow", label: "Trip ended" },
};

/** "34 s", "2 min 14 s", "1 h 3 min" — how long ago, in the words a student reads at a glance. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** 07:42 in Asia/Kolkata — the operating timezone, whatever the phone is set to. */
export function formatClock(iso: string | number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(iso));
}

/** An ETA range in minutes — "4–6 min", "under 1 min", never a single confident number (§5.5). */
export function formatEtaRange(p50S: number, p90S: number): string {
  const lo = Math.max(0, Math.round(p50S / 60));
  const hi = Math.max(lo, Math.round(p90S / 60));
  if (hi <= 0) return "under 1 min";
  if (lo === hi) return `${lo} min`;
  return `${lo === 0 ? "<1" : lo}–${hi} min`;
}
