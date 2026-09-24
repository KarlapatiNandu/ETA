import { describe, expect, it } from "vitest";
import type { Ping } from "@busmitra/contracts";
import { fromPosition, Sampler, type Fix } from "./sampler.ts";

const T0 = 1_758_506_400_000;
const fix = (sec: number, lat: number, speed: number | null, extra: Partial<Fix> = {}): Fix => ({
  timestamp: T0 + sec * 1000,
  lat,
  lng: 78.5,
  accuracy: 6.44,
  speed,
  heading: 91.6,
  ...extra,
});

describe("Sampler", () => {
  it("turns ~1 Hz fixes into a ping every 5 s while moving, every 15 s after 30 s still", () => {
    const out: [Ping, number][] = [];
    const s = new Sampler((p, c) => out.push([p, c]));
    for (let t = 0; t <= 20; t++) s.handle(fix(t, 17.4 + t * 0.00008, 9));
    for (let t = 21; t <= 120; t++) s.handle(fix(t, 17.4016, 0));
    const secs = out.map(([p]) => (Date.parse(p.recorded_at) - T0) / 1000);
    expect(secs.slice(0, 5)).toEqual([0, 5, 10, 15, 20]);
    const gaps = secs.slice(1).map((x, i) => x - secs[i]!);
    expect(gaps.at(-1)).toBe(15);
    expect(out.at(-1)![1]).toBe(15);
  });

  it("sends the first slow ping on the old promise, so a parking bus never looks late", () => {
    const out: [Ping, number][] = [];
    const s = new Sampler((p, c) => out.push([p, c]));
    for (let t = 0; t <= 4; t++) s.handle(fix(t, 17.4 + t * 0.00008, 9));
    for (let t = 5; t <= 90; t++) s.handle(fix(t, 17.4004, 0));
    const rows = out.map(([p, c]) => [(Date.parse(p.recorded_at) - T0) / 1000, c] as const);
    for (let i = 1; i < rows.length; i++) {
      // the gap before each ping is within the cadence the previous one advertised
      expect(rows[i]![0] - rows[i - 1]![0]).toBeLessThanOrEqual(rows[i - 1]![1]);
    }
    expect(rows.some(([, c]) => c === 15)).toBe(true);
  });

  it("derives speed when the phone reports none, and rounds for the wire", () => {
    const out: Ping[] = [];
    const s = new Sampler((p) => out.push(p));
    s.handle(fix(0, 17.4, null));
    s.handle(fix(5, 17.4 + 0.000449, null, { heading: Number.NaN })); // ≈ 50 m in 5 s = 36 km/h
    expect(out[1]!.speed_kmh).toBeCloseTo(36, 0);
    expect(out[1]!.heading_deg).toBeNull();
    expect(out[0]!.accuracy_m).toBe(6.4);
    expect(out[0]!.heading_deg).toBe(92);
    expect(s.lastFix!.timestamp).toBe(T0 + 5000);
  });

  it("maps a GeolocationPosition", () => {
    const f = fromPosition({
      timestamp: T0,
      coords: {
        latitude: 17.4,
        longitude: 78.5,
        accuracy: 5,
        speed: null,
        heading: null,
        altitude: null,
        altitudeAccuracy: null,
      },
    } as unknown as GeolocationPosition);
    expect(f).toEqual({
      timestamp: T0,
      lat: 17.4,
      lng: 78.5,
      accuracy: 5,
      speed: null,
      heading: null,
    });
  });
});
