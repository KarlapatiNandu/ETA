import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { SSE } from "@busmitra/config";
import {
  eventBusId,
  inBBox,
  isBroadcast,
  SseEvent,
  StreamFocus,
  type BBox,
  type BroadcastEvent,
  type LiveBus,
  type UserFrames,
} from "@busmitra/contracts";
import {
  compareIds,
  isStreamId,
  readAfter,
  readFleet,
  type Keys,
  type Redis,
} from "@busmitra/redis";
import { instruments } from "@busmitra/telemetry";
import { requireUser } from "../../plugins/auth.ts";
import type { EventHub, Subscriber } from "./hub.ts";

/**
 * GET /v1/stream and POST /v1/stream/focus (BUILD_PLAN Stage 3, ARCH §7, ADR-0001).
 *
 * On the long-lived Fastify gateway, never a Next.js route (invariant 8). One stream per tab:
 *
 *   stream.ready (per-user)  →  Last-Event-ID replay (broadcast only)  →  fleet.snapshot
 *   (per-user, re-derived)  →  live broadcast frames  →  `:hb` every 15 s
 *
 * Only broadcast-class frames carry an `id:` (invariant 9). Per-user frames have none, so the
 * browser's Last-Event-ID never points at something another student could be replayed.
 *
 * The 3-stream cap is per-connection keys with a 45 s TTL refreshed by the heartbeat
 * (invariant 10). The key's value also holds this gateway's instance id — so a gateway
 * restarted after SIGKILL deletes its own phantoms at boot instead of making users wait 45 s —
 * and the connection's focus, so any instance can take a focus POST for any stream.
 */

export interface StreamDeps {
  redis: Redis;
  keys: Keys;
  hub: EventHub;
  /** a connection subscribed to nothing yet: it becomes the `pubsub:eta` listener (Stage 5) */
  etaSubscriber?: Redis;
  instanceId: string;
  heartbeatS?: number;
  connTtlS?: number;
  maxStreams?: number;
  now?: () => number;
}

interface Focus {
  bbox: BBox | null;
  busIds: string[];
  /** Stage 5: stops whose ETAs this connection gets as eta.update frames */
  stopIds?: string[];
}

/** One ETA change as the engine publishes it on `pubsub:eta` (engine/eta.ts EtaFrame). */
export interface EtaFrame {
  tripId: string;
  stopId: string;
  p50: number;
  p90: number;
  confidence?: "high" | "medium" | "low";
  at?: string;
  withdrawn?: boolean;
}

interface ConnValue {
  inst: string;
  focus: Focus | null;
}

/** Past this much unsent output the client is not keeping up: drop it, let it resume by id. */
const MAX_BUFFERED_BYTES = 1 << 20;
/** How much history a resuming client may replay before we say the snapshot is all there is. */
const MAX_REPLAY = 10_000;

export class Conn implements Subscriber {
  readonly id: string;
  readonly userId: string;
  private readonly raw: ServerResponse;
  private focus: Focus | null = null;
  private busSet = new Set<string>();
  private stopSet = new Set<string>();
  /** buses sent because they were inside the bbox: we owe them the frame that takes them out */
  private readonly visible = new Set<string>();
  private buffer: [string, BroadcastEvent][] | null = [];
  private lastSent = "0-0";
  closed = false;

  constructor(id: string, userId: string, raw: ServerResponse) {
    this.id = id;
    this.userId = userId;
    this.raw = raw;
  }

  setFocus(f: Focus | null) {
    this.focus = f;
    this.busSet = new Set(f?.busIds ?? []);
    this.stopSet = new Set(f?.stopIds ?? []);
    this.visible.clear();
  }

  get stopIds(): string[] {
    return [...this.stopSet];
  }

  /** ETA frames are per-user (invariant 9): sent only for stops this connection asked for */
  wantsStop(stopId: string): boolean {
    return this.stopSet.has(stopId);
  }

  get focusValue(): Focus | null {
    return this.focus;
  }

  /** Whether this connection wants a bus at this position (snapshot and position frames). */
  wantsAt(busId: string, lat: number, lng: number): boolean {
    if (!this.focus) return true;
    if (this.busSet.has(busId)) return true;
    const inside = !!this.focus.bbox && inBBox(this.focus.bbox, lat, lng);
    if (inside) {
      this.visible.add(busId);
      return true;
    }
    if (this.visible.delete(busId)) return true; // the frame that moves it out of view
    return false;
  }

  wants(e: BroadcastEvent): boolean {
    if (!this.focus) return true;
    const busId = eventBusId(e);
    if (!busId) return true;
    if (e.type === "bus.position") return this.wantsAt(busId, e.data.lat, e.data.lng);
    return this.busSet.has(busId) || this.visible.has(busId);
  }

  write(frame: SseEvent, id?: string) {
    if (this.closed) return;
    const lines = `${id ? `id: ${id}\n` : ""}event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`;
    this.raw.write(lines);
    if (id) this.lastSent = id;
    if (this.raw.writableLength > MAX_BUFFERED_BYTES) this.raw.destroy();
  }

  comment(text: string) {
    if (!this.closed) this.raw.write(`: ${text}\n\n`);
  }

  offer(id: string, e: BroadcastEvent) {
    if (this.closed) return;
    if (this.buffer) {
      this.buffer.push([id, e]);
      return;
    }
    if (this.wants(e)) this.write(e, id);
  }

  sendReplay(id: string, e: BroadcastEvent) {
    if (this.wants(e)) this.write(e, id);
    else this.lastSent = id;
  }

  /** End the start-up phase: send what arrived meanwhile that the replay did not already cover. */
  goLive() {
    const pending = this.buffer ?? [];
    this.buffer = null;
    for (const [id, e] of pending) {
      if (compareIds(id, this.lastSent) > 0 && this.wants(e)) this.write(e, id);
    }
  }
}

function toLiveBus(id: string, e: Awaited<ReturnType<typeof readFleet>>[string]): LiveBus {
  return {
    id,
    lat: e.lat,
    lng: e.lng,
    spd: e.spd,
    hdg: e.hdg,
    s: e.s,
    ts: e.ts,
    tripId: e.tripId,
    routeId: e.routeId ?? null,
    seq: e.seq,
    cadence: e.cadence,
    state: e.state,
    flag: e.flag ?? null,
    deadZone: e.deadZone ?? null,
  };
}

export async function countStreams(redis: Redis, keys: Keys, userId: string): Promise<number> {
  let cursor = "0";
  let n = 0;
  do {
    const [next, found] = await redis.scan(
      cursor,
      "MATCH",
      keys.sseConnMatch(userId),
      "COUNT",
      100,
    );
    n += found.length;
    cursor = next;
  } while (cursor !== "0");
  return n;
}

/** At boot: delete the connection keys a previous run of this instance left behind (SIGKILL). */
export async function reclaimPhantoms(
  redis: Redis,
  keys: Keys,
  instanceId: string,
): Promise<number> {
  let cursor = "0";
  let n = 0;
  do {
    const [next, found] = await redis.scan(cursor, "MATCH", keys.sseConnAll, "COUNT", 500);
    cursor = next;
    if (!found.length) continue;
    const vals = await redis.mget(found);
    const mine = found.filter((_, i) => {
      try {
        return (JSON.parse(vals[i] ?? "{}") as ConnValue).inst === instanceId;
      } catch {
        return false;
      }
    });
    if (mine.length) n += await redis.del(...mine);
  } while (cursor !== "0");
  return n;
}

export async function streamRoutes(app: FastifyInstance, deps: StreamDeps) {
  const k = deps.keys;
  const heartbeatS = deps.heartbeatS ?? SSE.HEARTBEAT_S;
  const ttlS = deps.connTtlS ?? SSE.CONN_TTL_S;
  const cap = deps.maxStreams ?? SSE.MAX_STREAMS_PER_USER;
  const now = deps.now ?? Date.now;
  const local = new Map<string, Conn>();
  const closers = new Map<string, () => void>();

  const snapshot = async (conn: Conn) => {
    const fleet = await readFleet(deps.redis, k);
    const buses = Object.entries(fleet)
      .filter(([, e]) => e.tripId && e.state !== "ENDED")
      .filter(([id, e]) => conn.wantsAt(id, e.lat, e.lng))
      .map(([id, e]) => toLiveBus(id, e));
    conn.write({
      type: "fleet.snapshot",
      data: { buses, serverTime: new Date(now()).toISOString() },
    });
    // per-user ETA frames are re-derived from Redis on every connect and focus change, never
    // replayed (invariant 9)
    const stops = conn.stopIds;
    if (!stops.length) return;
    const trips = [
      ...new Set(
        Object.values(fleet)
          .filter((e) => e.tripId && e.state !== "ENDED" && e.state !== "DARK")
          .map((e) => e.tripId!),
      ),
    ];
    if (!trips.length) return;
    const pipe = deps.redis.pipeline();
    for (const tripId of trips) for (const stopId of stops) pipe.hget(k.tripEta(tripId), stopId);
    const res = (await pipe.exec()) ?? [];
    let i = 0;
    for (const tripId of trips)
      for (const stopId of stops) {
        const raw = res[i++]?.[1] as string | null | undefined;
        if (!raw) continue;
        const v = JSON.parse(raw) as {
          p50: number;
          p90: number;
          confidence?: EtaFrame["confidence"];
          at?: string;
        };
        conn.write({
          type: "eta.update",
          data: { tripId, stopId, p50: v.p50, p90: v.p90, confidence: v.confidence, at: v.at },
        });
      }
  };

  if (deps.etaSubscriber) {
    const sub = deps.etaSubscriber;
    await sub.subscribe(k.etaChannel, k.notifyChannel);
    sub.on("message", (channel, message) => {
      if (channel === k.notifyChannel) {
        // Stage 6: notification / ticket.update frames, only to the students they name
        // (per-user, no id — never replayed, invariant 9)
        let f: UserFrames;
        try {
          f = JSON.parse(message) as UserFrames;
        } catch {
          return;
        }
        const who = new Set(f.userIds);
        for (const conn of local.values())
          if (who.has(conn.userId)) conn.write(f.frame as SseEvent);
        return;
      }
      let frames: EtaFrame[];
      try {
        frames = JSON.parse(message) as EtaFrame[];
      } catch {
        return;
      }
      for (const conn of local.values()) {
        for (const f of frames) {
          if (!conn.wantsStop(f.stopId)) continue;
          conn.write({
            type: "eta.update",
            data: {
              tripId: f.tripId,
              stopId: f.stopId,
              p50: f.p50,
              p90: f.p90,
              ...(f.confidence ? { confidence: f.confidence } : {}),
              ...(f.at ? { at: f.at } : {}),
              ...(f.withdrawn ? { withdrawn: true } : {}),
            },
          });
        }
      }
    });
  }

  app.get("/v1/stream", { preHandler: requireUser }, async (req, reply) => {
    const userId = req.user!.id;
    const connId = randomUUID();
    const key = k.sseConn(userId, connId);
    const value: ConnValue = { inst: deps.instanceId, focus: null };
    // claim first, then count: two racing connects can both be refused, never both admitted
    await deps.redis.set(key, JSON.stringify(value), "EX", ttlS);
    if ((await countStreams(deps.redis, k, userId)) > cap) {
      await deps.redis.del(key);
      return reply.code(429).send({
        error: "too_many_streams",
        message: `At most ${cap} live connections per account. Close another tab and retry.`,
      });
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string>), // CORS headers set by the plugin
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    raw.flushHeaders?.();
    const conn = new Conn(connId, userId, raw);
    local.set(connId, conn);
    const unsubscribe = deps.hub.subscribe(conn);
    instruments.sseConnections().add(1);

    // assigned once the stream is set up; `close` may run before that
    const timers: { heartbeat?: NodeJS.Timeout; expiry?: NodeJS.Timeout } = {};
    const close = () => {
      if (conn.closed) return;
      conn.closed = true;
      clearInterval(timers.heartbeat);
      clearTimeout(timers.expiry);
      unsubscribe();
      instruments.sseConnections().add(-1);
      local.delete(connId);
      closers.delete(connId);
      void deps.redis.del(key).catch(() => undefined);
      if (!raw.writableEnded) raw.end();
    };
    closers.set(connId, close);
    req.raw.on("close", close);
    raw.on("error", close);

    const exp = req.user!.exp;
    if (exp) {
      // a stream must not outlive its token: close at expiry, the client reconnects with a fresh one
      timers.expiry = setTimeout(close, Math.max(0, exp * 1000 - now()));
    }

    try {
      const lastEventId = String(req.headers["last-event-id"] ?? "");
      let truncated = false;
      if (lastEventId && isStreamId(lastEventId)) {
        let after = lastEventId;
        let sent = 0;
        for (;;) {
          const page = await readAfter<unknown>(deps.redis, k.streamEvents, after, 1000);
          if (sent === 0 && page.truncated) truncated = true;
          for (const entry of page.entries) {
            after = entry.id;
            // only broadcast-class frames are ever replayed (invariant 9), whatever is in the stream
            const parsed = SseEvent.safeParse(entry.data);
            if (!parsed.success || !isBroadcast(parsed.data.type)) continue;
            conn.sendReplay(entry.id, parsed.data as BroadcastEvent);
          }
          sent += page.entries.length;
          if (page.entries.length < 1000) break;
          if (sent >= MAX_REPLAY) {
            truncated = true;
            break;
          }
        }
      }
      conn.write({
        type: "stream.ready",
        data: {
          connId,
          heartbeatS,
          serverTime: new Date(now()).toISOString(),
          ...(truncated ? { replayTruncated: true } : {}),
        },
      });
      await snapshot(conn);
      conn.goLive();
    } catch (err) {
      req.log.error(err);
      close();
      return;
    }

    timers.heartbeat = setInterval(() => {
      void (async () => {
        conn.comment("hb");
        // refresh the TTL key; pick up a focus another gateway instance stored for this stream
        const cur = await deps.redis.get(key);
        if (cur === null) {
          await deps.redis.set(
            key,
            JSON.stringify({ inst: deps.instanceId, focus: conn.focusValue }),
            "EX",
            ttlS,
          );
          return;
        }
        await deps.redis.expire(key, ttlS);
        const v = JSON.parse(cur) as ConnValue;
        if (JSON.stringify(v.focus) !== JSON.stringify(conn.focusValue)) {
          conn.setFocus(v.focus);
          await snapshot(conn);
        }
      })().catch(() => undefined);
    }, heartbeatS * 1000);
  });

  app.post("/v1/stream/focus", { preHandler: requireUser }, async (req, reply) => {
    const body = StreamFocus.parse(req.body);
    const key = k.sseConn(req.user!.id, body.connId);
    const cur = await deps.redis.get(key);
    // the key embeds the user id: another student's connId is simply not found
    if (cur === null) {
      return reply.code(404).send({ error: "no_such_stream", message: "That stream is not open." });
    }
    const focus: Focus = { bbox: body.bbox ?? null, busIds: body.busIds, stopIds: body.stopIds };
    const value: ConnValue = { ...(JSON.parse(cur) as ConnValue), focus };
    await deps.redis.set(key, JSON.stringify(value), "KEEPTTL", "XX");
    const conn = local.get(body.connId);
    if (conn && conn.userId === req.user!.id) {
      conn.setFocus(focus);
      await snapshot(conn);
    }
    return reply.code(204).send();
  });

  // graceful shutdown (SIGTERM, deploy): end every stream and delete its key, so reconnecting
  // clients are not counted against phantoms. SIGKILL skips this — reclaimPhantoms covers it.
  app.addHook("preClose", async () => {
    for (const c of local.values()) c.comment("bye");
    for (const close of [...closers.values()]) close();
  });
}
