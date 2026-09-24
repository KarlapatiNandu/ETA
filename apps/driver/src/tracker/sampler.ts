import type { Ping } from "@busmitra/contracts";
import {
  initialCadence,
  nextCadence,
  pingDue,
  type CadenceState,
} from "@busmitra/contracts/tracker";
import { haversine } from "@busmitra/geo";

/**
 * GPS → pings at the tracker cadence (BUILD_PLAN Stage 2): `watchPosition` with high accuracy
 * delivers fixes roughly every second; the shared cadence rule decides which become pings —
 * every 5 s moving, every 15 s after 30 s standing still.
 */

export interface Fix {
  /** epoch ms of the GPS fix (GeolocationPosition.timestamp) */
  timestamp: number;
  lat: number;
  lng: number;
  accuracy: number;
  /** m/s, null when the platform does not report it */
  speed: number | null;
  heading: number | null;
}

export function fromPosition(p: GeolocationPosition): Fix {
  const c = p.coords;
  return {
    timestamp: p.timestamp,
    lat: c.latitude,
    lng: c.longitude,
    accuracy: c.accuracy,
    speed: c.speed ?? null,
    heading: c.heading ?? null,
  };
}

export class Sampler {
  private cadence: CadenceState = initialCadence();
  private lastPingAt: number | null = null;
  /** the cadence the last ping went out with: the next one is owed within it */
  private lastPingCadence: number | undefined;
  private last: Fix | null = null;
  lastFix: Fix | null = null;
  private readonly onPing: (ping: Ping, cadenceS: number) => void;

  constructor(onPing: (ping: Ping, cadenceS: number) => void) {
    this.onPing = onPing;
  }

  get cadenceS(): number {
    return this.cadence.cadenceS;
  }

  /** Feed every fix; emits a ping when one is due. */
  handle(fix: Fix): void {
    let speed = fix.speed;
    if (
      (speed === null || Number.isNaN(speed)) &&
      this.last &&
      fix.timestamp > this.last.timestamp
    ) {
      // Android Chrome often reports no speed: derive it from the previous fix
      speed = haversine(this.last, fix) / ((fix.timestamp - this.last.timestamp) / 1000);
    }
    this.last = fix;
    this.lastFix = fix;
    this.cadence = nextCadence(this.cadence, speed, fix.timestamp);
    if (!pingDue(this.lastPingAt, fix.timestamp, this.cadence.cadenceS, this.lastPingCadence))
      return;
    this.lastPingAt = fix.timestamp;
    this.lastPingCadence = this.cadence.cadenceS;
    this.onPing(
      {
        recorded_at: new Date(fix.timestamp).toISOString(),
        lat: Math.round(fix.lat * 1e7) / 1e7,
        lng: Math.round(fix.lng * 1e7) / 1e7,
        speed_kmh: speed === null ? null : Math.min(200, Math.round(speed * 36) / 10),
        heading_deg:
          fix.heading === null || Number.isNaN(fix.heading) ? null : Math.round(fix.heading) % 360,
        accuracy_m: Math.round(fix.accuracy * 10) / 10,
      },
      this.cadence.cadenceS,
    );
  }
}

/** watchPosition as a start/stop pair. */
export function watchGps(
  onFix: (f: Fix) => void,
  onError: (e: GeolocationPositionError) => void,
  geo: Geolocation = navigator.geolocation,
): () => void {
  const id = geo.watchPosition((p) => onFix(fromPosition(p)), onError, {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 20_000,
  });
  return () => geo.clearWatch(id);
}
