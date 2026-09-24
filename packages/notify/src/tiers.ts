import { createHash } from "node:crypto";

/**
 * Tiering (ARCHITECTURE §6.1) and the per-user filters (§6.3), as pure functions: every input is
 * explicit, so the rules can be tested exhaustively and the worker only moves data.
 */

export type Tier = 0 | 1 | 2 | 3 | 4;

export interface TierBehaviour {
  /** Web Push `Urgency` header */
  urgency: "very-low" | "low" | "normal" | "high";
  /** how long the push service may hold it for an offline phone, seconds */
  ttlS: number;
  /** T0 stays on screen until the student acts */
  requireInteraction: boolean;
  /** T0: SMS always; T1: SMS when push cannot carry it; T2+: never */
  sms: "always" | "fallback" | "never";
  /** T4 is in-app only: no transport is attempted at all */
  transport: boolean;
}

export const TIER: Record<Tier, TierBehaviour> = {
  0: { urgency: "high", ttlS: 24 * 3600, requireInteraction: true, sms: "always", transport: true },
  1: {
    urgency: "high",
    ttlS: 15 * 60,
    requireInteraction: false,
    sms: "fallback",
    transport: true,
  },
  2: {
    urgency: "normal",
    ttlS: 6 * 3600,
    requireInteraction: false,
    sms: "never",
    transport: true,
  },
  3: { urgency: "normal", ttlS: 3600, requireInteraction: false, sms: "never", transport: true },
  4: { urgency: "low", ttlS: 0, requireInteraction: false, sms: "never", transport: false },
};

export interface AlertPrefs {
  alerts_paused_until: Date | string | null;
  max_tier: number;
  critical_breakthrough: boolean;
  quiet_start_min: number | null;
  quiet_duration_min: number | null;
  /** favourites.muted_until for the notification's bus, if any */
  bus_muted_until?: Date | string | null;
}

export type Decision =
  | { kind: "now" }
  | { kind: "defer"; until: Date }
  | { kind: "suppress"; reason: "tier_4" | "paused" | "muted" | "above_max_tier" };

const IST_OFFSET_MIN = 330;
const after = (t: Date | string | null | undefined, now: number) =>
  t != null && new Date(t).getTime() > now;

/** Minutes since midnight in Asia/Kolkata (the app has one timezone, SCHEMA §0). */
export function istMinuteOfDay(now: number): number {
  return Math.floor((now / 60_000 + IST_OFFSET_MIN) % 1440);
}

/**
 * When the current quiet window ends, or null if `now` is outside it. Stored as a start and a
 * duration so 22:00 → 06:00 wraps past midnight without special cases (SCHEMA §1):
 * inside ⟺ (now − start) mod 1440 < duration.
 */
export function quietUntil(
  prefs: Pick<AlertPrefs, "quiet_start_min" | "quiet_duration_min">,
  now: number,
): Date | null {
  const { quiet_start_min: start, quiet_duration_min: dur } = prefs;
  if (start == null || !dur) return null;
  const elapsed = (((istMinuteOfDay(now) - start) % 1440) + 1440) % 1440;
  if (elapsed >= dur) return null;
  const minuteStart = Math.floor(now / 60_000) * 60_000;
  return new Date(minuteStart + (dur - elapsed) * 60_000);
}

/**
 * ARCHITECTURE §6.3, in order: the kill switch (T0 breaks through unless the student turned that
 * off), a per-bus "not today", the student's maximum tier (`max_tier = 3` delivers 0–3), then
 * quiet hours, which *defer* anything but T0. Whatever this returns, the notification center is
 * written (invariant 14): these decide the transport, never the record.
 */
export function decide(tier: Tier, prefs: AlertPrefs, now: number): Decision {
  if (!TIER[tier].transport) return { kind: "suppress", reason: "tier_4" };
  if (after(prefs.alerts_paused_until, now) && !(tier === 0 && prefs.critical_breakthrough))
    return { kind: "suppress", reason: "paused" };
  if (after(prefs.bus_muted_until, now)) return { kind: "suppress", reason: "muted" };
  if (tier > prefs.max_tier) return { kind: "suppress", reason: "above_max_tier" };
  if (tier !== 0) {
    const until = quietUntil(prefs, now);
    if (until) return { kind: "defer", until };
  }
  return { kind: "now" };
}

/**
 * dedupe_key = sha256(user | event type | bus | stop | service date | content) — ARCHITECTURE
 * §6.2. Unique in the database (`notif_dedupe`): a retry, a replay or a flapping geofence
 * cannot notify a student twice for the same thing.
 */
export function dedupeKey(parts: {
  userId: string;
  eventType: string;
  busId?: string | null;
  stopId?: string | null;
  serviceDate: string;
  content: string;
}): string {
  return createHash("sha256")
    .update(
      [
        parts.userId,
        parts.eventType,
        parts.busId ?? "",
        parts.stopId ?? "",
        parts.serviceDate,
        parts.content,
      ].join("|"),
    )
    .digest("hex");
}

/** The operating day (SCHEMA §0) of an instant, as YYYY-MM-DD. */
export function serviceDate(at: number): string {
  return new Date(at + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

/** End of the operating day in IST — "Not today" mutes until then (ARCH §6.4). */
export function endOfServiceDay(now: number): Date {
  const d = serviceDate(now);
  return new Date(Date.parse(`${d}T23:59:59+05:30`));
}
