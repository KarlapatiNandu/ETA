import type { IngestResult } from "@busmitra/contracts";
import { CADENCE } from "@busmitra/contracts/tracker";
import { NetworkError, type SignedClient } from "../lib/api.ts";
import type { PingBuffer } from "./buffer.ts";

/**
 * Buffer → gateway (BUILD_PLAN Stage 2): a batch every 5 s; after a reconnect, the backlog
 * goes out in ≤500-ping requests back to back, oldest first, original recorded_at intact.
 *
 * Reachability is `navigator.onLine` *and* evidence: `onLine` is true on a captive portal or a
 * dead cell, so after a network failure a cheap /healthz probe must succeed before the next
 * real attempt. Failures back off exponentially with full jitter, so 30 phones coming out of
 * the same dead zone do not all retry on the same second.
 */

export interface UplinkStats {
  sent: number;
  buffered: number;
  lastSentAt: number | null;
  lastError: string | null;
  online: boolean;
  /** the trip was closed server-side (ended elsewhere): stop tracking it */
  tripClosed: boolean;
}

export interface UplinkDeps {
  buffer: PingBuffer;
  client: SignedClient;
  deviceUid: string;
  tripId: () => string | null;
  cadenceS: () => number;
  isOnline?: () => boolean;
  now?: () => number;
  random?: () => number;
  onStats?: (s: UplinkStats) => void;
}

export const UPLINK = { BASE_BACKOFF_MS: 1000, MAX_BACKOFF_MS: 60_000 } as const;

export class Uplink {
  readonly stats: UplinkStats = {
    sent: 0,
    buffered: 0,
    lastSentAt: null,
    lastError: null,
    online: true,
    tripClosed: false,
  };
  private busy = false;
  private failures = 0;
  private retryAt = 0;
  private needProbe = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly d: UplinkDeps;

  constructor(d: UplinkDeps) {
    this.d = d;
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), CADENCE.BATCH_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A new trip: fresh counters, no inherited backoff. */
  reset(): void {
    Object.assign(this.stats, { sent: 0, lastSentAt: null, lastError: null, tripClosed: false });
    this.failures = 0;
    this.retryAt = 0;
  }

  /** The network came back (window 'online'): try now, skipping any backoff. */
  reconnected(): void {
    this.retryAt = 0;
    this.needProbe = true;
    void this.tick();
  }

  private emit() {
    this.d.onStats?.({ ...this.stats });
  }

  private backoff(error: string) {
    this.failures++;
    const cap = Math.min(UPLINK.MAX_BACKOFF_MS, UPLINK.BASE_BACKOFF_MS * 2 ** this.failures);
    this.retryAt = this.now() + this.random() * cap;
    this.stats.lastError = error;
  }

  /** One pass: send the backlog in ≤500-ping requests until it is empty or something fails. */
  async tick(): Promise<void> {
    if (this.busy) return;
    const tripId = this.d.tripId();
    if (!tripId) return;
    this.busy = true;
    try {
      this.stats.online = this.d.isOnline?.() ?? true;
      if (!this.stats.online || this.now() < this.retryAt) return;
      if (this.needProbe) {
        if (!(await this.d.client.probe())) return this.backoff("gateway unreachable");
        this.needProbe = false;
      }
      for (;;) {
        const { keys, pings } = await this.d.buffer.peek(tripId, CADENCE.MAX_BATCH);
        if (!pings.length) break;
        let res;
        try {
          res = await this.d.client.request<IngestResult & { error?: string; message?: string }>(
            "POST",
            "/v1/ingest",
            { device_uid: this.d.deviceUid, trip_id: tripId, cadence_s: this.d.cadenceS(), pings },
          );
        } catch (err) {
          if (err instanceof NetworkError) {
            this.needProbe = true;
            return this.backoff("offline — pings are safe in the buffer");
          }
          throw err;
        }
        const { status, json } = res;
        if (status === 200) {
          // rejected pings (a broken phone clock) are dropped with the rest: resending never helps
          await this.d.buffer.remove(keys);
          this.stats.sent += json.accepted;
          this.stats.lastSentAt = this.now();
          this.stats.lastError = json.rejected.length
            ? `${json.rejected.length} pings refused (${json.rejected[0]!.reason})`
            : null;
          this.failures = 0;
          continue;
        }
        if (status === 409 && json.error === "replay") {
          await this.d.buffer.remove(keys); // the gateway already has exactly this request
          continue;
        }
        if (status === 409 && json.error === "trip_not_live") {
          await this.d.buffer.remove(keys);
          this.stats.tripClosed = true;
          this.stats.lastError = "This trip was closed on the server.";
          break;
        }
        if (status === 400) {
          await this.d.buffer.remove(keys); // malformed: can never succeed, must not block the rest
          this.stats.lastError = `batch refused: ${json.message ?? "invalid"}`;
          continue;
        }
        if (status === 401) {
          // keep the pings: a fixed clock or a re-pair makes them sendable again
          this.backoff(
            json.error === "stale_timestamp"
              ? "Phone clock is wrong — set date & time to automatic."
              : "This phone is not paired any more — ask the transport office for a new link.",
          );
          return;
        }
        return this.backoff(
          status === 429 ? "sending too fast, slowing down" : `server error ${status}`,
        );
      }
    } finally {
      this.stats.buffered = await this.d.buffer.count(tripId).catch(() => this.stats.buffered);
      this.busy = false;
      this.emit();
    }
  }
}
