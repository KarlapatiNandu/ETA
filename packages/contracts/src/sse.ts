import { z } from "zod";
import { LngLat } from "./routes.ts";

/**
 * SSE frames (ARCH §7). `BROADCAST_EVENTS` are replayable from `stream:events` via
 * Last-Event-ID; everything else is per-user and re-derived on connect, never replayed
 * (invariant 9) — replaying them would leak one student's payload to another.
 *
 * Fields added after the first version are optional, so a client built against an older
 * contract keeps parsing newer frames.
 */

export const PresenceState = z.enum(["LIVE", "DEGRADED", "DARK", "ENDED"]);
export type PresenceState = z.infer<typeof PresenceState>;

const iso = z.iso.datetime({ offset: true });

const BusPosition = z.object({
  id: z.uuid(),
  lat: z.number(),
  lng: z.number(),
  spd: z.number().nullable(),
  hdg: z.number().nullable(),
  /** route offset in metres (ARCH §5.1); null when off-route */
  s: z.number().nullable(),
  /** recorded_at of the GPS fix — never the time the frame was sent */
  ts: iso,
  tripId: z.uuid().nullable().optional(),
  /** the route the trip runs on: the client dead-reckons along this polyline (ARCH §4) */
  routeId: z.uuid().nullable().optional(),
  /** highest stop index reached (trip:{id}:seq); -1 before the first stop */
  seq: z.number().int().optional(),
  /** the tracker's current cadence, seconds: the client stops extrapolating past it */
  cadence: z.number().int().positive().optional(),
  /** "off_route" | "resnapped" — why `s` is what it is */
  flag: z.string().nullable().optional(),
});

export const LiveBus = BusPosition.extend({
  tripId: z.uuid().nullable(),
  state: PresenceState,
  cadence: z.number().int().positive(),
  /** a known dead zone the bus went dark in (ARCH §5.7 classification) */
  deadZone: z
    .object({ label: z.string().nullable(), avgOutageS: z.number() })
    .nullable()
    .optional(),
});
export type LiveBus = z.infer<typeof LiveBus>;

export const StopEventKind = z.enum(["arrived", "departed", "skipped"]);

export const SseEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("fleet.snapshot"),
    data: z.object({
      buses: z.array(LiveBus),
      /** gateway clock: "last seen 34 s ago" must not depend on the phone's clock being right */
      serverTime: iso.optional(),
    }),
  }),
  z.object({ type: z.literal("bus.position"), data: BusPosition }),
  z.object({
    type: z.literal("bus.status"),
    data: z.object({
      id: z.uuid(),
      state: PresenceState,
      /** signal_lost | known_dead_zone | recovered | trip_end | dark_timeout | late */
      reason: z.string().optional(),
      cadence: z.number().int().positive(),
      /** the last fix the state is judged against */
      lastSeenAt: iso,
      tripId: z.uuid().nullable().optional(),
      /** when the transition was observed */
      at: iso.optional(),
      deadZone: z
        .object({ label: z.string().nullable(), avgOutageS: z.number() })
        .nullable()
        .optional(),
    }),
  }),
  z.object({
    type: z.literal("eta.update"),
    data: z.object({
      tripId: z.uuid(),
      stopId: z.uuid(),
      p50: z.number().nonnegative(),
      p90: z.number().nonnegative(),
      confidence: z.enum(["high", "medium", "low"]).optional(),
      /** the fix the prediction was made from: remaining time is p50 − (now − at) */
      at: iso.optional(),
      /**
       * the ETA no longer exists — the bus went dark, off-route, passed the stop or ended.
       * The client must stop showing it rather than keep counting down (invariant 2)
       */
      withdrawn: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("stop.reached"),
    data: z.object({
      tripId: z.uuid(),
      stopId: z.uuid(),
      seq: z.number().int().nonnegative(),
      busId: z.uuid().optional(),
      /** arrived (the default), departed, or skipped (ARCH §5.4) */
      event: StopEventKind.optional(),
      at: iso.optional(),
      /**
       * derived from buffered pings flushed late: true history, shown on the timeline, but it
       * must never trigger a notification (invariant 4)
       */
      backfill: z.boolean().optional(),
    }),
  }),
  z.object({
    type: z.literal("notification"),
    data: z.object({
      id: z.uuid(),
      tier: z.number().int().min(0).max(4),
      title: z.string(),
      body: z.string(),
      createdAt: iso,
    }),
  }),
  z.object({
    type: z.literal("ticket.update"),
    data: z.object({
      id: z.uuid(),
      status: z.enum(["open", "acknowledged", "resolved", "cancelled"]),
      at: iso,
    }),
  }),
  z.object({
    /** first frame of every stream: the id this connection's focus is posted against */
    type: z.literal("stream.ready"),
    data: z.object({
      connId: z.string().min(8).max(64),
      heartbeatS: z.number().int().positive(),
      serverTime: iso,
      /** Last-Event-ID was older than the replay window: the snapshot is all there is */
      replayTruncated: z.boolean().optional(),
    }),
  }),
]);
export type SseEvent = z.infer<typeof SseEvent>;
export type SseEventType = SseEvent["type"];
export type SseEventOf<T extends SseEventType> = Extract<SseEvent, { type: T }>;

export const BROADCAST_EVENTS = [
  "bus.position",
  "bus.status",
  "stop.reached",
] as const satisfies readonly SseEventType[];
export type BroadcastEvent = SseEventOf<(typeof BROADCAST_EVENTS)[number]>;

export function isBroadcast(type: SseEventType): boolean {
  return (BROADCAST_EVENTS as readonly string[]).includes(type);
}

/** The bus a broadcast-class event is about — what focus filtering keys on. */
export function eventBusId(e: BroadcastEvent): string | null {
  if (e.type === "stop.reached") return e.data.busId ?? null;
  return e.data.id;
}

/** [west, south, east, north] in degrees. */
export const BBox = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(([w, s, e, n]) => w <= e && s <= n, "bbox must be [west, south, east, north]");
export type BBox = z.infer<typeof BBox>;

/**
 * POST /v1/stream/focus (ARCH §7): which buses this connection wants. Buses inside `bbox`
 * plus every id in `busIds` (favourites, the active trip). Omit both to receive everything.
 */
export const StreamFocus = z.object({
  connId: z.string().min(8).max(64),
  bbox: BBox.nullable().optional(),
  busIds: z.array(z.uuid()).max(50).default([]),
  /** stops whose ETAs this connection wants as `eta.update` frames (Stage 5) */
  stopIds: z.array(z.uuid()).max(20).default([]),
});
export type StreamFocus = z.infer<typeof StreamFocus>;

export function inBBox(b: BBox, lat: number, lng: number): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

/** GET /v1/network — what the student map draws: published routes, their stops, the fleet. */
export const NetworkStop = z.object({
  stopId: z.uuid(),
  seq: z.number().int(),
  name: z.string(),
  lat: z.number(),
  lng: z.number(),
  /** D_k, metres along the route */
  offset: z.number(),
});
export type NetworkStop = z.infer<typeof NetworkStop>;

export const NetworkRoute = z.object({
  id: z.uuid(),
  lineageId: z.uuid(),
  name: z.string(),
  direction: z.enum(["inbound", "outbound"]),
  coords: z.array(LngLat),
  /** cumulative_dist_m: lets the client place an offset without re-measuring the line */
  cum: z.array(z.number()),
  stops: z.array(NetworkStop),
});
export type NetworkRoute = z.infer<typeof NetworkRoute>;

export const Network = z.object({
  routes: z.array(NetworkRoute),
  buses: z.array(z.object({ id: z.uuid(), number: z.string(), status: z.string() })),
});
export type Network = z.infer<typeof Network>;
