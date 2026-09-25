import { z } from "zod";
import { LeaveNowEvent } from "./search.ts";

/**
 * `stream:notify` — domain events for the notification spine (SCHEMA §10). They name a student
 * or an admin action, so they never go on `stream:events` (invariant 9).
 *
 * Except `leave_now` (which carries the moment's numbers), an event is a doorbell: it names a
 * database row, and the notify worker (Stage 6) reads the truth from that row. The row is
 * committed before the doorbell rings, so a doorbell for a row that does not exist is dropped,
 * and a doorbell lost to a Redis blip is recovered by the worker's sweep over rows that were
 * published but never delivered.
 */

const iso = z.iso.datetime({ offset: true });

export const AnnouncementPublished = z.object({
  type: z.literal("announcement"),
  announcementId: z.uuid(),
  at: iso,
});

/** A ticket opened or resolved in a way students are told about (out of commission → T0, back → T2). */
export const TicketTransition = z.object({
  type: z.literal("ticket"),
  ticketId: z.uuid(),
  transition: z.enum(["opened", "resolved"]),
  at: iso,
});

/** An event-day list applied with changes: a cohort-segmented T2. */
export const EventDayPublished = z.object({
  type: z.literal("event_day"),
  uploadId: z.uuid(),
  at: iso,
});

/**
 * A driver pressed START on a new trip (not a resume). Rung by the gateway's tracker endpoint;
 * buffered pings can never produce it, so it cannot fire retroactively.
 */
export const TripStartEvent = z.object({
  type: z.literal("trip_start"),
  tripId: z.uuid(),
  busId: z.uuid(),
  at: iso,
});

export const NotifyEvent = z.discriminatedUnion("type", [
  LeaveNowEvent,
  AnnouncementPublished,
  TicketTransition,
  EventDayPublished,
  TripStartEvent,
]);
export type NotifyEvent = z.infer<typeof NotifyEvent>;

/**
 * `pubsub:notify` — engine → gateway: per-user SSE frames (`notification`, `ticket.update`) for
 * students with the app open. Pub/sub, not a stream: per-user frames are re-derived from the
 * notification center on connect, never replayed (invariant 9).
 */
export interface UserFrames {
  userIds: string[];
  frame:
    | {
        type: "notification";
        data: { id: string; tier: number; title: string; body: string; createdAt: string };
      }
    | {
        type: "ticket.update";
        data: {
          id: string;
          status: "open" | "acknowledged" | "resolved" | "cancelled";
          at: string;
        };
      };
}

// ── student API (Stage 6) ────────────────────────────────────────────────

/**
 * The push services browsers actually hand out endpoints on (Chrome/Edge/Android → FCM, Firefox
 * → Mozilla autopush, Safari/iOS → Apple, legacy Edge → WNS). The engine POSTs to whatever
 * endpoint a student registers, so an unrestricted URL would let anyone make the engine call an
 * internal address (SSRF) — Stage 9 hardening. HTTPS only, these hosts only.
 */
export const PUSH_SERVICE_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
] as const;

export function isPushServiceEndpoint(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      !u.port &&
      !u.username &&
      PUSH_SERVICE_HOSTS.some((h) => h.test(u.hostname))
    );
  } catch {
    return false;
  }
}

/** POST /v1/push/subscriptions — what PushSubscription.toJSON() gives, plus install state. */
export const PushSubscribe = z.object({
  endpoint: z
    .url()
    .max(1000)
    .refine(isPushServiceEndpoint, "not a push service this app can deliver to"),
  keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  /** installed PWA (display-mode: standalone); iOS delivers push only to these */
  standalone: z.boolean().optional(),
});
export type PushSubscribe = z.infer<typeof PushSubscribe>;

/** PATCH /v1/me/alerts — the student's own filters (ARCH §6.3, §6.5). */
export const AlertPrefsPatch = z
  .object({
    max_tier: z.number().int().min(0).max(4).optional(),
    critical_breakthrough: z.boolean().optional(),
    /** minutes from IST midnight; null clears quiet hours */
    quiet_start_min: z.number().int().min(0).max(1439).nullable().optional(),
    quiet_duration_min: z.number().int().min(1).max(1440).nullable().optional(),
  })
  .refine(
    (p) => (p.quiet_start_min === undefined) === (p.quiet_duration_min === undefined),
    "quiet_start_min and quiet_duration_min are set together",
  );
export type AlertPrefsPatch = z.infer<typeof AlertPrefsPatch>;

export const FavouriteKind = z.enum(["main", "starred"]);

/** POST /v1/notifications/:id/actions — the inline actions on "Bus 14 has started". */
export const NotificationAction = z.object({ action: z.enum(["follow", "not_today"]) });

/** One notification-center entry. */
export interface NotificationItem {
  id: string;
  tier: number;
  category: string;
  title: string;
  body: string;
  created_at: string;
  read_at: string | null;
  acknowledged_at: string | null;
  channel: "push" | "sms" | "inapp_only" | null;
  bus_id: string | null;
  trip_id: string | null;
  payload: { url?: string; markdown?: string; actions?: { action: string; title: string }[] };
  /** a ticket card: its status right now, not when the notification was sent */
  ticket: { id: string; status: string; title: string } | null;
}
