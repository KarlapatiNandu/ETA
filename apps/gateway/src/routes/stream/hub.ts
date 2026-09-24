import { isBroadcast, SseEvent, type BroadcastEvent } from "@busmitra/contracts";
import { lastId, type Keys, type Redis } from "@busmitra/redis";
import { inSpan, instruments, RollingWindow } from "@busmitra/telemetry";

/**
 * One tailer per gateway process (ARCH §7): a single blocking XREAD on `stream:events` fans out
 * to every SSE connection this process holds. Six hundred connections each blocking on Redis
 * would be six hundred Redis connections; this is one.
 */

export interface Subscriber {
  offer(id: string, event: BroadcastEvent): void;
}

/** How long the hub remembers fan-out ages for the console's live-latency number (Stage 8). */
export const LATENCY_WINDOW_MS = 5 * 60_000;

export class EventHub {
  private readonly subs = new Set<Subscriber>();
  /**
   * Stage 8: age of each bus.position frame at fan-out — the fix's recorded_at to the moment
   * this gateway writes it to its streams. The client adds its paint (< 50 ms, ARCH §4), so this
   * is ping-to-pixel less a constant; the console reads it, OTel exports it as a histogram.
   */
  readonly pingToFrame = new RollingWindow(LATENCY_WINDOW_MS);
  private cursor = "$";
  private stopped = false;
  private running: Promise<void> | null = null;
  private readonly redis: Redis;
  private readonly keys: Keys;
  private readonly log?: (msg: string, extra?: Record<string, unknown>) => void;

  constructor(
    redis: Redis,
    keys: Keys,
    log?: (msg: string, extra?: Record<string, unknown>) => void,
  ) {
    // XREAD BLOCK holds its socket: a connection of its own
    this.redis = redis.duplicate();
    this.keys = keys;
    this.log = log;
  }

  subscribe(s: Subscriber): () => void {
    this.subs.add(s);
    return () => void this.subs.delete(s);
  }

  get size(): number {
    return this.subs.size;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.cursor = await lastId(this.redis, this.keys.streamEvents);
    this.running = this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const res = (await this.redis.xread(
          "COUNT",
          500,
          "BLOCK",
          2000,
          "STREAMS",
          this.keys.streamEvents,
          this.cursor,
        )) as [string, [string, string[]][]][] | null;
        if (!res?.[0]) continue;
        for (const [id, fields] of res[0][1]) {
          this.cursor = id;
          const i = fields.indexOf("d");
          let parsed;
          try {
            parsed = SseEvent.safeParse(JSON.parse(fields[i + 1] ?? "null"));
          } catch {
            continue;
          }
          if (!parsed.success || !isBroadcast(parsed.data.type)) continue;
          const ev = parsed.data as BroadcastEvent;
          if (ev.type === "bus.position") {
            const now = Date.now();
            const ageS = (now - Date.parse(ev.data.ts)) / 1000;
            // a backfilled fix is old by design; it is history, not latency
            if (ageS < 120) {
              this.pingToFrame.add(ageS, now);
              instruments.pingToFrame().record(ageS);
            }
          }
          const t = fields.indexOf("tp");
          const tp = t === -1 ? undefined : fields[t + 1];
          if (tp) {
            // traced frames only: the fan-out is the last hop of the fix's trace
            void inSpan(
              "sse.fanout",
              {
                parent: tp,
                attributes: { "busmitra.event": ev.type, "busmitra.streams": this.subs.size },
              },
              () => {
                for (const s of this.subs) s.offer(id, ev);
              },
            );
          } else for (const s of this.subs) s.offer(id, ev);
        }
      } catch (err) {
        if (this.stopped) break;
        this.log?.("sse hub: read failed, retrying", { error: (err as Error).message });
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.redis.disconnect();
    await this.running?.catch(() => undefined);
  }
}
