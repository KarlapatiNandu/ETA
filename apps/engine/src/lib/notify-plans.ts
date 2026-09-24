import type { BroadcastEvent, NotifyEvent } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import type { Tier } from "@busmitra/notify";
import type { Audience } from "./audience.ts";

/**
 * From a domain event to what the notification spine sends: the event wiring table of
 * BUILD_PLAN Stage 6, one function per row. A plan names its audience and its tier; it never
 * decides a channel (that is per student, in the worker) and never touches a transport.
 *
 * Doorbell events (announcement, ticket, event_day) are re-read from their rows — the row is
 * the truth (ADR-0007). A doorbell whose row is missing, unpublished or cancelled plans nothing.
 */

export type Category =
  | "bus_activated"
  | "stop_reached"
  | "leave_now"
  | "signal_lost"
  | "signal_restored"
  | "delay"
  | "announcement"
  | "roster_published"
  | "ticket_opened"
  | "ticket_resolved";

export interface Plan {
  /** idempotency of the parent: a replayed event finds its notification instead of adding one */
  sourceKey: string;
  tier: Tier;
  category: Category;
  title: string;
  body: string;
  audience: Audience;
  /** the bus a "Not today" mute applies to */
  busId: string | null;
  tripId: string | null;
  stopId: string | null;
  ticketId: string | null;
  createdBy: string | null;
  collapseTag: string | null;
  expiresAt: Date | null;
  /** when the thing happened; with `freshForS`, older events reach the center but buzz nobody */
  eventAt: number;
  freshForS: number | null;
  url: string;
  actions?: { action: string; title: string }[];
  payload?: Record<string, unknown>;
  /** set announcements.notification_id to the parent */
  announcementId?: string;
  /** broadcast a ticket.update frame to the audience with this status */
  ticketStatus?: "open" | "resolved";
}

/** Past this, a time-critical event is history, not news (invariant 4: never a late alert). */
export const LEAVE_NOW_FRESH_S = 120;
export const TRIP_START_FRESH_S = 300;
/** broadcast-derived progress and signal alerts older than this are not recorded at all */
export const BROADCAST_FRESH_S = 120;
/**
 * Admin sends (announcements, bus lists) delivered this late — the engine was down overnight, a
 * consumer group started on an old stream — reach the center but buzz nobody.
 */
export const ADMIN_FRESH_S = 12 * 3600;

const minutes = (s: number) => Math.max(1, Math.round(s / 60));

async function busNumber(q: Queryable, busId: string): Promise<string> {
  const { rows } = await q.query<{ bus_number: string }>(
    `SELECT bus_number FROM buses WHERE id = $1`,
    [busId],
  );
  return rows[0]?.bus_number ?? "?";
}

export async function planNotify(q: Queryable, e: NotifyEvent): Promise<Plan[]> {
  switch (e.type) {
    case "leave_now": {
      const { rows } = await q.query<{ bus_number: string; stop: string }>(
        `SELECT b.bus_number, s.name AS stop FROM buses b, stops s WHERE b.id = $1 AND s.id = $2`,
        [e.busId, e.stopId],
      );
      const r = rows[0];
      if (!r) return [];
      const at = Date.parse(e.at);
      return [
        {
          sourceKey: `leave_now:${e.subscriptionId}:${e.stopId}`,
          tier: 1,
          category: "leave_now",
          title: `Leave now — Bus ${r.bus_number} arrives in ${minutes(e.etaP50S)} min`,
          body: `Bus ${r.bus_number} reaches ${r.stop} in about ${minutes(e.etaP50S)}–${minutes(e.etaP90S)} min. Your walk is ${minutes(e.travelTimeS)} min.`,
          audience: { kind: "users", userIds: [e.userId] },
          busId: e.busId,
          tripId: e.tripId,
          stopId: e.stopId,
          ticketId: null,
          createdBy: null,
          collapseTag: `trip-${e.tripId}-leave`,
          // "expires when the event passes" (ARCH §6.1)
          expiresAt: new Date(at + e.etaP50S * 1000),
          eventAt: at,
          freshForS: LEAVE_NOW_FRESH_S,
          url: "/",
        },
      ];
    }

    case "announcement": {
      const { rows } = await q.query<{
        tier: Tier;
        audience: string;
        audience_ref: string | null;
        title: string;
        body_md: string;
        created_by: string;
        published_at: Date | null;
        cancelled_at: Date | null;
      }>(
        `SELECT tier, audience, audience_ref, title, body_md, created_by, published_at, cancelled_at
           FROM announcements WHERE id = $1`,
        [e.announcementId],
      );
      const a = rows[0];
      if (!a || !a.published_at || a.cancelled_at) return [];
      const audience: Audience =
        a.audience === "custom"
          ? { kind: "announcement", announcementId: e.announcementId }
          : a.audience === "route"
            ? { kind: "route", routeId: a.audience_ref! }
            : a.audience === "bus"
              ? { kind: "bus", busId: a.audience_ref! }
              : { kind: a.audience as "all" | "juniors" | "seniors" };
      return [
        {
          sourceKey: `announcement:${e.announcementId}`,
          tier: a.tier,
          category: "announcement",
          title: a.title,
          // phones show plain text; the center renders the markdown
          body: a.body_md.replace(/\*\*(.+?)\*\*/g, "$1"),
          audience,
          busId: a.audience === "bus" ? a.audience_ref : null,
          tripId: null,
          stopId: null,
          ticketId: null,
          createdBy: a.created_by,
          collapseTag: null,
          expiresAt: null,
          eventAt: new Date(a.published_at).getTime(),
          freshForS: ADMIN_FRESH_S,
          url: "/notifications",
          payload: { markdown: a.body_md },
          announcementId: e.announcementId,
        },
      ];
    }

    case "ticket": {
      const { rows } = await q.query<{
        kind: string;
        status: string;
        title: string;
        description: string | null;
        bus_id: string | null;
        trip_id: string | null;
        bus_number: string | null;
        opened_by: string | null;
        resolved_by: string | null;
        resolution_note: string | null;
        opened_at: Date;
        resolved_at: Date | null;
      }>(
        `SELECT k.kind, k.status, k.title, k.description, k.bus_id, k.trip_id, b.bus_number,
                k.opened_by, k.resolved_by, k.resolution_note, k.opened_at, k.resolved_at
           FROM tickets k LEFT JOIN buses b ON b.id = k.bus_id WHERE k.id = $1`,
        [e.ticketId],
      );
      const t = rows[0];
      // only out-of-commission tickets are told to students (BUILD_PLAN Stage 6 wiring table)
      if (!t || t.kind !== "out_of_commission" || !t.bus_id) return [];
      const opened = e.transition === "opened";
      if (!opened && t.status !== "resolved") return [];
      // "out of commission" for a bus already back in service is not news: center only
      const stillOut = t.status === "open" || t.status === "acknowledged";
      return [
        {
          sourceKey: `ticket:${e.ticketId}:${e.transition}`,
          tier: opened ? 0 : 2,
          category: opened ? "ticket_opened" : "ticket_resolved",
          title: opened ? t.title : `Bus ${t.bus_number} is back in service`,
          body: (opened ? t.description : t.resolution_note) ?? "",
          audience: { kind: "bus", busId: t.bus_id },
          busId: t.bus_id,
          tripId: t.trip_id,
          stopId: null,
          ticketId: e.ticketId,
          createdBy: opened ? t.opened_by : t.resolved_by,
          // the phone replaces "out of commission" with "back in service": one card
          collapseTag: `ticket-${e.ticketId}`,
          expiresAt: null,
          eventAt: new Date(opened ? t.opened_at : (t.resolved_at ?? t.opened_at)).getTime(),
          // an open T0 buzzes however late the doorbell is — the bus is still out; anything
          // else (resolved since, or a stale "back in service") is history
          freshForS: opened ? (stillOut ? null : 0) : ADMIN_FRESH_S,
          url: "/notifications",
          ticketStatus: opened ? "open" : "resolved",
        },
      ];
    }

    case "event_day": {
      const { rows } = await q.query<{
        service_date: string;
        status: string;
        diff_summary: {
          added?: number;
          changed?: number;
          removed?: number;
          notify_cohorts?: ("junior" | "senior")[];
        } | null;
        applied_by: string | null;
        applied_at: Date | null;
      }>(
        `SELECT to_char(service_date, 'YYYY-MM-DD') AS service_date, status, diff_summary, applied_by, applied_at
           FROM roster_uploads WHERE id = $1 AND kind = 'event_day_buses'`,
        [e.uploadId],
      );
      const u = rows[0];
      const cohorts = u?.diff_summary?.notify_cohorts ?? [];
      if (!u || u.status !== "applied" || !cohorts.length) return [];
      const d = u.diff_summary!;
      const day = new Date(`${u.service_date}T12:00:00+05:30`).toLocaleDateString("en-IN", {
        weekday: "short",
        day: "numeric",
        month: "short",
        timeZone: "Asia/Kolkata",
      });
      const who =
        cohorts.length === 2 ? "Everyone" : cohorts[0] === "junior" ? "Juniors" : "Seniors";
      return [
        {
          sourceKey: `event_day:${e.uploadId}`,
          tier: 2,
          category: "roster_published",
          title: `Bus list for ${day} has changed`,
          body: `${who}: check which bus to take. ${d.added ?? 0} added, ${d.changed ?? 0} changed, ${d.removed ?? 0} removed.`,
          audience: { kind: "cohorts", cohorts },
          busId: null,
          tripId: null,
          stopId: null,
          ticketId: null,
          createdBy: u.applied_by,
          collapseTag: `event-day-${u.service_date}`,
          expiresAt: new Date(`${u.service_date}T23:59:59+05:30`),
          eventAt: new Date(u.applied_at ?? Date.now()).getTime(),
          freshForS: ADMIN_FRESH_S,
          url: "/notifications",
          payload: { serviceDate: u.service_date },
        },
      ];
    }

    case "trip_start": {
      const { rows } = await q.query<{ bus_number: string; route: string }>(
        `SELECT b.bus_number, r.name AS route FROM trips t JOIN buses b ON b.id = t.bus_id
           JOIN routes r ON r.id = t.route_id WHERE t.id = $1`,
        [e.tripId],
      );
      const r = rows[0];
      if (!r) return [];
      const at = Date.parse(e.at);
      const common = {
        category: "bus_activated" as const,
        busId: e.busId,
        tripId: e.tripId,
        stopId: null,
        ticketId: null,
        createdBy: null,
        expiresAt: new Date(at + 30 * 60_000),
        eventAt: at,
        freshForS: TRIP_START_FRESH_S,
        url: `/?trip=${e.tripId}`,
      };
      const favs = (kind: "main" | "starred"): Audience => ({
        kind: "sql",
        sql: `SELECT user_id FROM favourites WHERE bus_id = $1 AND kind = $2::fav_kind_t`,
        params: [e.busId, kind],
      });
      return [
        {
          ...common,
          sourceKey: `trip_start:${e.tripId}:main`,
          tier: 1,
          title: `Your bus has started — Bus ${r.bus_number}`,
          body: `Bus ${r.bus_number} is on its way (${r.route}). Open the app to follow it.`,
          audience: favs("main"),
          collapseTag: `trip-${e.tripId}-start`,
        },
        {
          ...common,
          sourceKey: `trip_start:${e.tripId}:starred`,
          tier: 3,
          title: `Bus ${r.bus_number} has started`,
          body: `${r.route}. Taking it today?`,
          audience: favs("starred"),
          collapseTag: `trip-${e.tripId}-start`,
          // Follow → a trip subscription; Not today → mute this bus until midnight (ARCH §6.4)
          actions: [
            { action: "follow", title: "Follow" },
            { action: "not_today", title: "Not today" },
          ],
        },
      ];
    }
  }
}

/**
 * Broadcast-class events (from `stream:events`) that students are told about. Backfilled
 * crossings are history, never news (invariant 4): they plan nothing, and neither does anything
 * older than BROADCAST_FRESH_S — a replayed day of events is silent.
 */
export async function planBroadcast(q: Queryable, e: BroadcastEvent, now: number): Promise<Plan[]> {
  if (e.type === "stop.reached") {
    const d = e.data;
    const kind = d.event ?? "arrived";
    if (d.backfill || kind === "departed" || !d.busId) return [];
    const at = d.at ? Date.parse(d.at) : now;
    if (now - at > BROADCAST_FRESH_S * 1000) return [];
    const { rows } = await q.query<{ stop: string; next_stop: string | null; bus_number: string }>(
      `SELECT s.name AS stop, b.bus_number,
              (SELECT n.name FROM route_stops x JOIN stops n ON n.id = x.stop_id
                WHERE x.route_id = t.route_id AND x.seq > $2 ORDER BY x.seq LIMIT 1) AS next_stop
         FROM trips t JOIN buses b ON b.id = t.bus_id, stops s
        WHERE t.id = $1 AND s.id = $3`,
      [d.tripId, d.seq, d.stopId],
    );
    const r = rows[0];
    if (!r) return [];
    // riders following this trip whose own stop is this one or still ahead
    const audience: Audience = {
      kind: "sql",
      sql: `SELECT s.user_id FROM trip_subscriptions s JOIN trips t ON t.id = s.trip_id
             WHERE s.trip_id = $1 AND s.state = 'active'
               AND EXISTS (SELECT 1 FROM route_stops rs WHERE rs.route_id = t.route_id
                            AND rs.stop_id = s.target_stop_id AND rs.seq >= $2)`,
      params: [d.tripId, d.seq],
    };
    return [
      {
        sourceKey: `stop:${d.tripId}:${d.seq}:${kind}`,
        tier: 3,
        category: "stop_reached",
        title:
          kind === "skipped"
            ? `Bus ${r.bus_number} passed ${r.stop}`
            : `Bus ${r.bus_number} — at ${r.stop}`,
        body: r.next_stop ? `Next: ${r.next_stop}` : "Last stop.",
        audience,
        busId: d.busId,
        tripId: d.tripId,
        stopId: d.stopId,
        ticketId: null,
        createdBy: null,
        // 12 stops, one notification that keeps updating (ARCH §6.1)
        collapseTag: `trip-${d.tripId}-progress`,
        expiresAt: new Date(at + 10 * 60_000),
        eventAt: at,
        freshForS: BROADCAST_FRESH_S,
        url: `/?trip=${d.tripId}`,
      },
    ];
  }

  if (e.type === "bus.status") {
    const d = e.data;
    if (!d.tripId) return [];
    const signal =
      d.state === "DARK" && (d.reason === "signal_lost" || d.reason === "known_dead_zone")
        ? d.reason
        : d.state === "LIVE" && d.reason === "recovered"
          ? "recovered"
          : null;
    if (!signal) return [];
    const at = d.at ? Date.parse(d.at) : now;
    if (now - at > BROADCAST_FRESH_S * 1000) return [];
    const n = await busNumber(q, d.id);
    const riders: Audience = {
      kind: "sql",
      sql: `SELECT user_id FROM trip_subscriptions WHERE trip_id = $1 AND state = 'active'`,
      params: [d.tripId],
    };
    const lastSeen = new Date(d.lastSeenAt).toLocaleTimeString("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Kolkata",
    });
    const zone = d.deadZone;
    const base = {
      audience: riders,
      busId: d.id,
      tripId: d.tripId,
      stopId: null,
      ticketId: null,
      createdBy: null,
      collapseTag: `trip-${d.tripId}-signal`,
      expiresAt: new Date(at + 15 * 60_000),
      eventAt: at,
      freshForS: BROADCAST_FRESH_S,
      url: `/?trip=${d.tripId}`,
    };
    if (signal === "recovered")
      return [
        {
          ...base,
          sourceKey: `signal:${d.tripId}:${d.lastSeenAt}:recovered`,
          tier: 3,
          category: "signal_restored",
          title: `Bus ${n} is reporting again`,
          body: "Its position and ETA are live again.",
        },
      ];
    return [
      {
        ...base,
        sourceKey: `signal:${d.tripId}:${d.lastSeenAt}:lost`,
        // a known dead zone is expected and explained: in-app only (ARCH §5.7)
        tier: signal === "known_dead_zone" ? 4 : 2,
        category: "signal_lost",
        title:
          signal === "known_dead_zone"
            ? `Bus ${n} is in a known dead zone${zone?.label ? ` near ${zone.label}` : ""}`
            : `Signal lost from Bus ${n}`,
        body:
          signal === "known_dead_zone"
            ? `Usually clears in about ${Math.round((zone?.avgOutageS ?? 90) / 10) * 10} seconds.`
            : `No position since ${lastSeen}. We will tell you when it reports again.`,
      },
    ];
  }
  return [];
}
