import { createHmac } from "node:crypto";
import type { Ping } from "@busmitra/contracts";
import { signingPayload, TRACKER_HEADERS } from "@busmitra/contracts/signing";
import type { Fix } from "./gt06.ts";

/**
 * One hardware tracker's uplink to the gateway (BUILD_PLAN Stage 9, ADR-0008). It speaks the
 * exact contract the driver app speaks — signed `/v1/tracker/me`, `/v1/tracker/trips`,
 * `/v1/ingest` with a `PingBatch` carrying `cadence_s` — so nothing downstream knows or cares
 * that the bus now has a wired box instead of a phone. That is what `tracker_kind` was for.
 *
 * What a phone decides by a driver's tap, a wired tracker decides by the ignition (ARCH §3
 * "ignition-driven trip start"): ACC on with a fix → start (or resume) the bus's trip on its
 * default route; ACC off for TRIP_END_AFTER_ACC_OFF_S → end it. A device that does not report
 * ACC (the original 0x12 packet) starts on its first fix and ends only by the presence timeout.
 *
 * It never fabricates: a heartbeat carries no position and produces no ping (invariant 2), and a
 * fix the receiver marks unpositioned is dropped. Buffered fixes a device re-uploads after a dead
 * zone keep their own `recorded_at`; the gateway flags them backfill (ARCH §5.7).
 */

export interface DeviceConfig {
  secret: string;
  /** the device's configured upload interval with the ignition on / off (GT06 `TIMER` command) */
  movingIntervalS: number;
  idleIntervalS: number;
}

export const UPLINK = {
  BATCH_EVERY_MS: 5_000,
  MAX_BATCH: 500,
  /** like the phone's IndexedDB ring: a day of fixes, oldest dropped first */
  MAX_BUFFER: 20_000,
  TRIP_END_AFTER_ACC_OFF_S: 600,
  MAX_BACKOFF_MS: 60_000,
} as const;

type Fetch = typeof fetch;
type Log = (msg: string, extra?: Record<string, unknown>) => void;

export class DeviceUplink {
  readonly deviceUid: string;
  private readonly cfg: DeviceConfig;
  private readonly gateway: string;
  private readonly fetch: Fetch;
  private readonly now: () => number;
  private readonly log: Log;
  private buffer: Ping[] = [];
  private tripId: string | null = null;
  private acc: boolean | null = null;
  private accOffSince: number | null = null;
  private hadFix = false;
  private retryAt = 0;
  private backoff = 1000;
  private busy = false;
  private readonly tripEndAfterAccOffS: number;
  dropped = 0;

  constructor(
    deviceUid: string,
    cfg: DeviceConfig,
    gateway: string,
    opts: { fetch?: Fetch; now?: () => number; log?: Log; tripEndAfterAccOffS?: number } = {},
  ) {
    this.tripEndAfterAccOffS = opts.tripEndAfterAccOffS ?? UPLINK.TRIP_END_AFTER_ACC_OFF_S;
    this.deviceUid = deviceUid;
    this.cfg = cfg;
    this.gateway = gateway.replace(/\/$/, "");
    this.fetch = opts.fetch ?? fetch;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  get pending(): number {
    return this.buffer.length;
  }

  get trip(): string | null {
    return this.tripId;
  }

  /** The reporting interval the gateway should judge presence by (ARCH §5.7, invariant 3). */
  get cadenceS(): number {
    return this.acc === false ? this.cfg.idleIntervalS : this.cfg.movingIntervalS;
  }

  onAcc(acc: boolean) {
    if (acc) this.accOffSince = null;
    else if (this.acc !== false) this.accOffSince = this.now();
    this.acc = acc;
  }

  onFix(fix: Fix) {
    if (fix.acc !== null) this.onAcc(fix.acc);
    if (!fix.positioned) return; // no satellite fix: not a position (invariant 2)
    this.hadFix = true;
    this.buffer.push({
      recorded_at: fix.recordedAt,
      lat: fix.lat,
      lng: fix.lng,
      speed_kmh: Math.min(200, fix.speedKmh),
      heading_deg: fix.headingDeg,
      accuracy_m: null,
    });
    if (this.buffer.length > UPLINK.MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - UPLINK.MAX_BUFFER);
      this.dropped++;
    }
  }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown) {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = String(Math.floor(this.now() / 1000));
    const sig = createHmac("sha256", this.cfg.secret)
      .update(signingPayload(this.deviceUid, ts, raw))
      .digest("hex");
    const res = await this.fetch(`${this.gateway}${path}`, {
      method,
      headers: {
        ...(raw ? { "content-type": "application/json" } : {}),
        [TRACKER_HEADERS.device]: this.deviceUid,
        [TRACKER_HEADERS.timestamp]: ts,
        [TRACKER_HEADERS.signature]: sig,
      },
      ...(raw ? { body: raw } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { status: res.status, json };
  }

  /** Resume the bus's live trip, or start one on its default route. */
  private async ensureTrip(): Promise<boolean> {
    if (this.tripId) return true;
    const me = await this.call<{
      live_trip: { id: string } | null;
      default_route_id?: string | null;
      bus: { id: string } | null;
    }>("GET", "/v1/tracker/me");
    if (me.status !== 200) throw new Error(`tracker/me ${me.status} ${me.json.error ?? ""}`);
    if (me.json.live_trip) {
      this.tripId = me.json.live_trip.id;
      return true;
    }
    if (!me.json.bus) {
      this.log("adapter: device is not paired to a bus", { device: this.deviceUid });
      return false;
    }
    if (!me.json.default_route_id) {
      this.log("adapter: bus has no default route — set one in Fleet", { device: this.deviceUid });
      return false;
    }
    const t = await this.call<{ trip_id: string }>("POST", "/v1/tracker/trips", {
      route_id: me.json.default_route_id,
    });
    if (t.status !== 200) throw new Error(`trip start ${t.status} ${t.json.error ?? ""}`);
    this.tripId = t.json.trip_id;
    this.log("adapter: trip started by ignition", { device: this.deviceUid, trip: this.tripId });
    return true;
  }

  /**
   * One tick: start/resume the trip if the ignition says so, send up to one batch, and end the
   * trip after the ignition has been off long enough. Never throws; failures back off.
   */
  async tick(): Promise<void> {
    if (this.busy || this.now() < this.retryAt) return;
    this.busy = true;
    try {
      const wantTrip = this.hadFix && this.acc !== false;
      if (!this.tripId && !wantTrip && this.buffer.length) {
        // parked with the ignition off and no trip: these fixes belong to no trip, and must not
        // be pinned onto tomorrow morning's (fleet data is trip data, ARCH §10)
        this.buffer.length = 0;
      }
      if (!this.tripId && wantTrip && this.buffer.length) {
        if (!(await this.ensureTrip())) {
          this.retryLater();
          return;
        }
      }
      if (this.tripId && this.buffer.length) await this.sendBatch();
      if (
        this.tripId &&
        this.accOffSince !== null &&
        this.now() - this.accOffSince >= this.tripEndAfterAccOffS * 1000 &&
        !this.buffer.length
      ) {
        const id = this.tripId;
        const r = await this.call("POST", `/v1/tracker/trips/${id}/end`, {});
        if (r.status !== 200) throw new Error(`trip end ${r.status}`);
        this.tripId = null;
        this.hadFix = false;
        this.log("adapter: trip ended by ignition off", { device: this.deviceUid, trip: id });
      }
      this.backoff = 1000;
    } catch (err) {
      this.log("adapter: uplink failed, will retry", {
        device: this.deviceUid,
        error: (err as Error).message,
      });
      this.retryLater();
    } finally {
      this.busy = false;
    }
  }

  private retryLater() {
    this.retryAt = this.now() + Math.random() * this.backoff;
    this.backoff = Math.min(this.backoff * 2, UPLINK.MAX_BACKOFF_MS);
  }

  private async sendBatch() {
    const pings = this.buffer.slice(0, UPLINK.MAX_BATCH);
    const r = await this.call<{ accepted: number; rejected: { index: number; reason: string }[] }>(
      "POST",
      "/v1/ingest",
      { device_uid: this.deviceUid, trip_id: this.tripId, cadence_s: this.cadenceS, pings },
    );
    if (r.status === 200 || (r.status === 409 && r.json.error === "replay")) {
      // taken — or listed as rejected, which resending can never change
      this.buffer.splice(0, pings.length);
      if (r.json.rejected?.length) {
        this.log("adapter: gateway rejected fixes", {
          device: this.deviceUid,
          reasons: [...new Set(r.json.rejected.map((x) => x.reason))],
        });
      }
      return;
    }
    if (r.status === 409 && r.json.error === "trip_not_live") {
      // the trip was ended elsewhere (an admin, the next START): start afresh on the next tick
      this.tripId = null;
      return;
    }
    if (r.status === 400) {
      this.buffer.splice(0, pings.length);
      this.log("adapter: batch refused as malformed; dropped", { device: this.deviceUid });
      return;
    }
    throw new Error(`ingest ${r.status} ${r.json.error ?? ""}`); // 401/429/5xx: keep and retry
  }
}
