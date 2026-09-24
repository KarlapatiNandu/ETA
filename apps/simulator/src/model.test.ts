import { describe, expect, it } from "vitest";
import {
  buildRoute,
  initialTripState,
  nearestOnRoute,
  pointAtOffset,
  stepTrip,
  type LatLng,
  type RouteStop,
} from "@busmitra/geo";
import { gaussian, prng, replayTrace, simulateTrip, surveyOf } from "./model.ts";

// ~6 km, three legs, through east Hyderabad
const line: LatLng[] = [
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5447 },
  { lat: 17.3848, lng: 78.5447 },
  { lat: 17.3848, lng: 78.5647 },
];
const route = buildRoute(line);
const stops = [0, 1500, 2900, 4400, route.total];
const T0 = Date.parse("2026-09-22T02:00:00.000Z");

describe("prng", () => {
  it("is deterministic per seed and has unit-variance gaussians", () => {
    const a = prng(42);
    const b = prng(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    const r = prng(1);
    const xs = Array.from({ length: 20000 }, () => gaussian(r));
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / xs.length);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(sd).toBeCloseTo(1, 1);
  });
});

describe("simulateTrip", () => {
  it("is byte-identical for the same seed, different for another", () => {
    const a = simulateTrip(route, { seed: 7, t0: T0, stops });
    const b = simulateTrip(route, { seed: 7, t0: T0, stops });
    const c = simulateTrip(route, { seed: 8, t0: T0, stops });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it("injects σ ≈ 8 m of GPS noise per axis", () => {
    const { pings } = simulateTrip(route, { seed: 3, t0: T0, stops, noiseM: 8 });
    const d = pings.map((p) => nearestOnRoute(p, route, null).distance);
    // perpendicular error of a 2-D gaussian with σ per axis: RMS ≈ σ
    const rms = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length);
    expect(rms).toBeGreaterThan(6);
    expect(rms).toBeLessThan(10);
  });

  it("reports at 5 s moving and 15 s while dwelling, with cadence in every batch", () => {
    const { pings, batches } = simulateTrip(route, {
      seed: 4,
      t0: T0,
      stops,
      dwellS: [60, 60],
      stallsPerKm: 0,
    });
    const gaps = pings
      .slice(1)
      .map((p, i) => (Date.parse(p.recorded_at) - Date.parse(pings[i]!.recorded_at)) / 1000);
    expect(gaps).toContain(5);
    expect(gaps).toContain(15);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);
    expect(new Set(batches.map((b) => b.cadenceS))).toEqual(new Set([5, 15]));
  });

  it("never leaves a gap longer than the cadence the previous fix advertised", () => {
    // presence (ARCH §5.7) reads the gap after a fix against the cadence that fix was sent
    // with; a gap longer than it is a missed ping, and a parked bus must never have one
    for (const seed of [1, 2, 3, 4, 5]) {
      const trip = simulateTrip(route, { seed, t0: T0, stops, stallsPerKm: 2, dwellS: [40, 90] });
      const advertised = new Map<string, number>();
      for (const b of trip.batches)
        for (const p of b.pings) advertised.set(p.recorded_at, b.cadenceS);
      let slowed = 0;
      for (let i = 1; i < trip.pings.length; i++) {
        const prev = trip.pings[i - 1]!;
        const gapS = (Date.parse(trip.pings[i]!.recorded_at) - Date.parse(prev.recorded_at)) / 1000;
        const promised = advertised.get(prev.recorded_at)!;
        if (promised === 15) slowed++;
        expect(gapS, `seed ${seed}, fix ${i}`).toBeLessThanOrEqual(promised);
      }
      expect(slowed).toBeGreaterThan(0); // the stationary cadence was actually exercised
    }
  });

  it("buffers through a dead zone and flushes on exit with the original timestamps", () => {
    const zone: [number, number] = [2000, 2600];
    const { batches, pings } = simulateTrip(route, {
      seed: 5,
      t0: T0,
      stops,
      deadZones: [zone],
      dupRate: 0,
      reorderRate: 0,
    });
    const flush = batches.find((b) => b.kind === "flush")!;
    expect(flush.pings.length).toBeGreaterThan(3);
    // the flushed fixes were recorded before the flush was sent
    expect(Date.parse(flush.pings[0]!.recorded_at)).toBeLessThan(flush.sendAt - 30_000);
    // nothing lost: every fix is in exactly one batch
    const sent = batches.flatMap((b) => b.pings.map((p) => p.recorded_at));
    expect(sent).toEqual(pings.map((p) => p.recorded_at));
  });

  it("an offline time window (airplane mode) buffers the same way", () => {
    const { batches } = simulateTrip(route, {
      seed: 5,
      t0: T0,
      stops,
      offline: [[120_000, 300_000]],
      dupRate: 0,
      reorderRate: 0,
    });
    const flush = batches.find((b) => b.kind === "flush")!;
    expect(flush.sendAt - T0).toBeGreaterThanOrEqual(300_000);
    expect(flush.pings.length).toBeGreaterThan(10);
  });

  it("injects duplicate and out-of-order batches without changing the fixes", () => {
    const clean = simulateTrip(route, { seed: 9, t0: T0, stops, dupRate: 0, reorderRate: 0 });
    const faulty = simulateTrip(route, { seed: 9, t0: T0, stops, dupRate: 0.2, reorderRate: 0.2 });
    expect(faulty.batches.some((b) => b.kind === "duplicate")).toBe(true);
    const times = faulty.batches.map((b) => Date.parse(b.pings[0]!.recorded_at));
    expect(times.some((t, i) => i > 0 && t < times[i - 1]!)).toBe(true);
    expect(new Set(faulty.batches.flatMap((b) => b.pings.map((p) => p.recorded_at)))).toEqual(
      new Set(clean.pings.map((p) => p.recorded_at)),
    );
  });

  it("detours sideways for an off-route excursion", () => {
    const { pings } = simulateTrip(route, {
      seed: 6,
      t0: T0,
      stops,
      noiseM: 1,
      offRoute: [{ atS: 3000, durationS: 60, offsetM: 200 }],
    });
    expect(pings.some((p) => nearestOnRoute(p, route, null).distance > 150)).toBe(true);
  });

  it("drives stepTrip through every stop in order (the simulator and the geo core agree)", () => {
    const routeStops: RouteStop[] = stops.map((offset, i) => ({
      seq: i + 1,
      stopId: `S${i + 1}`,
      offset,
    }));
    const { pings } = simulateTrip(route, { seed: 11, t0: T0, stops });
    let state = initialTripState();
    const arrived: string[] = [];
    for (const p of pings) {
      const r = stepTrip(
        state,
        { at: Date.parse(p.recorded_at), lat: p.lat, lng: p.lng, speedKmh: p.speed_kmh },
        route,
        routeStops,
      );
      state = r.state;
      arrived.push(...r.events.filter((e) => e.kind === "arrived").map((e) => e.stopId));
    }
    expect(arrived).toEqual(routeStops.map((s) => s.stopId));
  });
});

describe("replayTrace", () => {
  const trace = {
    pings: Array.from({ length: 120 }, (_, i) => ({
      t: new Date(Date.parse("2025-01-01T00:00:00Z") + i * 1000).toISOString(),
      ...pointAtOffset(route, i * 9),
      speed_kmh: 32,
    })),
  };

  it("replays deterministically, re-sampled at the tracker cadence and shifted to t0", () => {
    const a = replayTrace(trace, T0);
    const b = replayTrace(trace, T0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.pings).toHaveLength(24); // 120 s of 1 Hz fixes at a 5 s cadence
    expect(a.pings[0]!.recorded_at).toBe(new Date(T0).toISOString());
  });

  it("honours offline windows", () => {
    const r = replayTrace(trace, T0, { offline: [[20_000, 80_000]] });
    expect(r.batches.some((b) => b.kind === "flush" && b.pings.length >= 10)).toBe(true);
  });
});

describe("surveyOf", () => {
  it("produces a 1 Hz noisy trace the length of the route", () => {
    const pts = surveyOf(route, { seed: 1, t0: T0, kmh: 36 });
    expect(pts.length).toBeCloseTo(route.total / 10, -1);
    expect(Date.parse(pts[1]!.t) - Date.parse(pts[0]!.t)).toBe(1000);
  });
});
