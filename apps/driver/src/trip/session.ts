import type { TrackerMe, TripStarted } from "@busmitra/contracts";
import { kvDelete, kvGet, kvSet } from "../lib/idb.ts";
import type { SignedClient } from "../lib/api.ts";
import type { PingBuffer } from "../tracker/buffer.ts";
import { Sampler, type Fix } from "../tracker/sampler.ts";
import { Uplink, type UplinkStats } from "../tracker/uplink.ts";
import type { WakeLockKeeper } from "../tracker/wakelock.ts";

/**
 * One trip, start to END (BUILD_PLAN Stage 2): route picker → START → GPS sampled at the
 * cadence rule into the IndexedDB buffer → uplink every 5 s → END.
 *
 * END is queued behind the buffer. If the driver ends the trip inside a dead zone, the END
 * request waits until every buffered ping has gone, so the server never closes a trip and then
 * receives its last ten minutes of positions afterwards. The trip survives a reload: it is
 * persisted, and on boot the app resumes it (the server's `one_live_trip` agrees).
 */

export interface ActiveTrip {
  tripId: string;
  routeId: string;
  routeName: string;
  startedAt: string;
  /** END pressed; waiting for the buffer to drain before telling the server */
  ending: boolean;
}

export interface SessionView {
  trip: ActiveTrip | null;
  stats: UplinkStats;
  lastFix: Fix | null;
  cadenceS: number;
  gpsError: string | null;
}

export interface SessionDeps {
  db: IDBDatabase;
  buffer: PingBuffer;
  client: SignedClient;
  deviceUid: string;
  wake: WakeLockKeeper;
  watchGps: (onFix: (f: Fix) => void, onError: (e: GeolocationPositionError) => void) => () => void;
  isOnline: () => boolean;
  onUpdate: (v: SessionView) => void;
}

export class TripSession {
  trip: ActiveTrip | null = null;
  private sampler: Sampler | null = null;
  private stopGps: (() => void) | null = null;
  private gpsError: string | null = null;
  private readonly uplink: Uplink;
  private readonly d: SessionDeps;
  private drainTimer: ReturnType<typeof setInterval> | null = null;

  constructor(d: SessionDeps) {
    this.d = d;
    this.uplink = new Uplink({
      buffer: d.buffer,
      client: d.client,
      deviceUid: d.deviceUid,
      tripId: () => this.trip?.tripId ?? null,
      cadenceS: () => this.sampler?.cadenceS ?? 5,
      isOnline: d.isOnline,
      // stats only re-render; draining is driven by the 5 s timers, never from here — calling
      // back into the uplink from its own stats callback spins while offline
      onStats: () => this.emit(),
    });
  }

  view(): SessionView {
    return {
      trip: this.trip,
      stats: this.uplink.stats,
      lastFix: this.sampler?.lastFix ?? null,
      cadenceS: this.sampler?.cadenceS ?? 5,
      gpsError: this.gpsError,
    };
  }

  private emit() {
    this.d.onUpdate(this.view());
  }

  /** On boot: resume a trip this phone had open, if the server still has it open. */
  async restore(me: TrackerMe): Promise<void> {
    const saved = await kvGet<ActiveTrip>(this.d.db, "trip");
    if (saved?.ending) {
      this.trip = saved;
      this.uplink.start();
      this.drainTimer ??= setInterval(() => void this.maybeFinishEnding(), 5000);
    } else if (saved && me.live_trip?.id === saved.tripId) {
      this.trip = saved;
      this.begin();
    } else if (saved) {
      await kvDelete(this.d.db, "trip");
    }
    this.emit();
  }

  async start(route: { id: string; name: string }): Promise<void> {
    const res = await this.d.client.request<TripStarted & { message?: string }>(
      "POST",
      "/v1/tracker/trips",
      {
        route_id: route.id,
      },
    );
    if (res.status !== 200)
      throw new Error(res.json.message ?? `could not start the trip (${res.status})`);
    this.trip = {
      tripId: res.json.trip_id,
      routeId: route.id,
      routeName: route.name,
      startedAt: res.json.started_at,
      ending: false,
    };
    await kvSet(this.d.db, "trip", this.trip);
    this.uplink.reset();
    this.begin();
    this.emit();
  }

  private begin() {
    const trip = this.trip!;
    this.sampler = new Sampler((ping) => {
      void this.d.buffer.push(trip.tripId, ping).then(() => this.emit());
    });
    this.stopGps = this.d.watchGps(
      (fix) => {
        this.gpsError = null;
        this.sampler?.handle(fix);
        this.emit();
      },
      (e) => {
        this.gpsError =
          e.code === 1
            ? "Location permission is off — the bus cannot be tracked."
            : "Waiting for GPS…";
        this.emit();
      },
    );
    this.uplink.start();
    void this.d.wake.enable();
  }

  /** The network came back: flush now rather than at the next 5 s tick. */
  reconnected(): void {
    this.uplink.reconnected();
  }

  /** END TRIP: stop sampling now; tell the server once the buffer is empty. */
  async end(): Promise<void> {
    if (!this.trip) return;
    this.trip = { ...this.trip, ending: true };
    await kvSet(this.d.db, "trip", this.trip);
    this.stopGps?.();
    this.stopGps = null;
    void this.d.wake.disable();
    this.drainTimer ??= setInterval(() => void this.maybeFinishEnding(), 5000);
    await this.uplink.tick();
    await this.maybeFinishEnding();
  }

  private finishing = false;

  private async maybeFinishEnding(): Promise<void> {
    const trip = this.trip;
    if (!trip?.ending || this.finishing) return;
    // the uplink's own 5 s interval keeps sending; END waits until it has sent everything
    if ((await this.d.buffer.count(trip.tripId)) > 0 && !this.uplink.stats.tripClosed) return;
    this.finishing = true;
    try {
      const res = await this.d.client.request("POST", `/v1/tracker/trips/${trip.tripId}/end`, {});
      if (res.status !== 200 && res.status !== 404) return; // keep trying on the drain timer
    } catch {
      return; // offline: the drain timer tries again
    } finally {
      this.finishing = false;
    }
    this.uplink.stop();
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.trip = null;
    this.sampler = null;
    await kvDelete(this.d.db, "trip");
    this.emit();
  }
}
