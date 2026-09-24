import { describe, expect, it } from "vitest";
import type { RouteStop } from "./crossings.ts";
import { offsetPoint, pointAtOffset } from "./geometry.ts";
import { initialTripState, stepTrip, type Fix, type TripGeoState, type TripStep } from "./trip.ts";
import { drive, routeFrom, T0 } from "./testkit.ts";

/**
 * Whole-trip adversarial fixtures (BUILD_PLAN Stage 1 exit: GPS spike, backward jitter, 83 m
 * ping gap at speed, route self-intersection). Every fix goes through stepTrip exactly as
 * the engine's geo worker will run it.
 */

// A figure-eight: east 2 km, north 1 km, west 1 km, then south 2 km — crossing the first leg
// at (1000, 0) — then east 2 km. The crossing point is on the route twice: s = 1000 and
// s = 5000, 160 vertices apart.
const route = routeFrom([
  [0, 0],
  [2000, 0],
  [2000, 1000],
  [1000, 1000],
  [1000, -1000],
  [3000, -1000],
]);
const stops: RouteStop[] = [0, 1000, 2500, 4000, 5000, 6500, route.total - 1].map((offset, i) => ({
  seq: i + 1,
  stopId: `S${i + 1}`,
  offset,
}));

function replay(fixes: Fix[], start: TripGeoState = initialTripState()) {
  let state = start;
  const steps: TripStep[] = [];
  for (const f of fixes) {
    const r = stepTrip(state, f, route, stops);
    steps.push(r);
    state = r.state;
  }
  const events = steps.flatMap((s) => s.events);
  return {
    state,
    steps,
    events,
    arrived: events.filter((e) => e.kind === "arrived").map((e) => e.stopId),
    skipped: events.filter((e) => e.kind === "skipped").map((e) => e.stopId),
  };
}

/** A trip to the terminus: drive, then stand at the last stop for 20 s (buses stop there). */
function toTerminus(opts: Parameters<typeof drive>[1]): Fix[] {
  const fixes = drive(route, opts);
  const last = fixes[fixes.length - 1]!;
  return [...fixes, ...[1, 2, 3, 4].map((i) => ({ ...last, at: last.at + i * 5000, speedKmh: 0 }))];
}

/** Park at offset `s` for `seconds`, jittering by `noiseM`. */
function dwell(s: number, fromAt: number, seconds: number, jitter: number[]): Fix[] {
  return jitter.slice(0, Math.ceil(seconds / 5)).map((d, i) => ({
    at: fromAt + i * 5000,
    ...pointAtOffset(route, s + d),
    speedKmh: 0,
  }));
}

describe("stepTrip — a clean trip", () => {
  it("arrives at every stop, in order, exactly once, with σ = 8 m GPS noise", () => {
    const { arrived, skipped, steps } = replay(toTerminus({ speedKmh: 30, noiseM: 8, seed: 3 }));
    expect(arrived).toEqual(stops.map((s) => s.stopId));
    expect(skipped).toEqual([]);
    const offsets = steps.map((s) => s.s).filter((s): s is number => s !== null);
    for (let i = 1; i < offsets.length; i++)
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    expect(steps.some((s) => s.status === "off_route")).toBe(false);
  });
});

describe("fixture: route self-intersection", () => {
  it("stays on the pass the bus is actually on through the crossing point, both times", () => {
    const fixes = drive(route, { speedKmh: 25, noiseM: 8, seed: 11 });
    const { steps } = replay(fixes);
    steps.forEach((step, i) => {
      const truth = Math.min(route.total, (25 / 3.6) * 5 * i);
      expect(Math.abs(step.s! - truth)).toBeLessThan(45);
    });
    expect(steps.some((s) => s.resnapped)).toBe(false);
  });
});

describe("fixture: GPS spike", () => {
  it("rejects a fix 600 m ahead along the route, then carries on", () => {
    const fixes = drive(route, { to: 1500, speedKmh: 30, seed: 5 });
    const spikeAt = 20; // ≈ 833 m
    fixes[spikeAt] = { ...fixes[spikeAt]!, ...pointAtOffset(route, 1433) };
    const { steps, arrived } = replay(fixes);
    expect(steps[spikeAt]!.decision).toBe("reject_spike");
    expect(steps[spikeAt]!.s).toBeCloseTo(steps[spikeAt - 1]!.s!, 6);
    expect(steps[spikeAt + 1]!.decision).toBe("accept");
    expect(arrived).toEqual(["S1", "S2"]);
  });

  it("holds the offset through a single fix 300 m off the road", () => {
    const fixes = drive(route, { to: 800, speedKmh: 30, seed: 5 });
    fixes[10] = { ...fixes[10]!, ...offsetPoint(fixes[10]!, 300, 0) };
    const { steps } = replay(fixes);
    expect(steps[10]!.status).toBe("noise");
    expect(steps[10]!.s).toBe(steps[9]!.s);
    expect(steps[11]!.status).toBe("on_route");
  });
});

describe("fixture: backward jitter", () => {
  it("a bus parked at a stop with jitter never arrives twice and never moves backwards", () => {
    const approach = drive(route, { to: 995, speedKmh: 30, seed: 2 });
    const t = approach[approach.length - 1]!.at + 5000;
    // ±25 m of along-route jitter, plus one 45 m backwards excursion
    const jitter = [8, -12, 20, -25, 15, -45, 22, -18, 10, 25, -20, 5];
    const parked = dwell(1000, t, 60, jitter);
    const leave = drive(route, { from: 1000, to: 1600, speedKmh: 30, startAt: t + 60_000 });
    const { steps, events } = replay([...approach, ...parked, ...leave]);
    expect(events.filter((e) => e.stopId === "S2" && e.kind === "arrived")).toHaveLength(1);
    expect(events.filter((e) => e.stopId === "S2" && e.kind === "departed")).toHaveLength(1);
    const offsets = steps.map((s) => s.s!);
    for (let i = 1; i < offsets.length; i++)
      expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!);
    expect(steps.some((s) => s.decision === "reject_backward")).toBe(true);
    expect(steps.some((s) => s.resnapped)).toBe(false);
  });
});

describe("fixture: 83 m ping gap at speed", () => {
  it("at 60 km/h and a 5 s cadence no stop is missed", () => {
    const { arrived, skipped } = replay(toTerminus({ speedKmh: 60, cadenceS: 5, seed: 9 }));
    expect(skipped).toEqual([]);
    expect(arrived).toEqual(stops.map((s) => s.stopId));
  });
});

describe("§5.3 recovery — the bus really reversed", () => {
  it("re-snaps after 4 backward fixes instead of freezing the offset for the rest of the trip", () => {
    const out = drive(route, { to: 3000, speedKmh: 30, seed: 4 });
    const t = out[out.length - 1]!.at;
    // U-turn: drive back along the geometry from 3000 to 2200
    const back = Array.from({ length: 12 }, (_, i) => ({
      at: t + (i + 1) * 5000,
      ...pointAtOffset(route, 3000 - (i + 1) * 70),
      speedKmh: 30,
    }));
    const { steps, state } = replay([...out, ...back]);
    const tail = steps.slice(out.length);
    expect(tail.slice(0, 3).map((s) => s.decision)).toEqual([
      "reject_backward",
      "reject_backward",
      "reject_backward",
    ]);
    expect(tail[3]!.resnapped).toBe(true);
    expect(tail[3]!.state.suppressEta).toBe(true);
    expect(tail[4]!.state.suppressEta).toBe(false);
    // sequence reset to the stop after the new offset: at ≈2720 m, S3 (2500) is behind
    expect(tail[3]!.state.s!).toBeCloseTo(2720, -1);
    expect(tail[3]!.state.crossing.next).toBe(3);
    // still reversing: four more backward fixes, a second re-snap, and S3 is ahead again
    expect(tail[7]!.resnapped).toBe(true);
    expect(tail[7]!.state.crossing.next).toBe(2);
    expect(state.s!).toBeLessThan(2400);
  });
});

describe("state handling", () => {
  it("ignores a stale (out-of-order) fix without touching live state", () => {
    const fixes = drive(route, { to: 500, speedKmh: 30 });
    const { state } = replay(fixes);
    const stale = stepTrip(state, { ...fixes[3]! }, route, stops);
    expect(stale.status).toBe("stale");
    expect(stale.state).toBe(state);
  });

  it("goes off-route after 3 far fixes, publishes no offset, and rejoins", () => {
    const fixes = drive(route, { to: 1500, speedKmh: 30, seed: 8 });
    for (const i of [30, 31, 32, 33])
      fixes[i] = { ...fixes[i]!, ...offsetPoint(fixes[i]!, 200, 180) };
    const { steps } = replay(fixes);
    expect(steps.slice(30, 34).map((s) => s.status)).toEqual([
      "noise",
      "noise",
      "off_route",
      "off_route",
    ]);
    expect(steps[32]!.wentOffRoute).toBe(true);
    expect(steps[33]!.wentOffRoute).toBe(false);
    expect(steps[32]!.s).toBeNull();
    expect(steps[34]!.status).toBe("on_route");
    const stale = stepTrip(steps[32]!.state, fixes[0]!, route, stops);
    expect(stale.s).toBeNull(); // still off-route: a stale fix must not resurrect an offset
  });

  it("derives speed from progress when the tracker reports none", () => {
    const { steps, state } = replay(drive(route, { to: 1000, speedKmh: 36, reportSpeed: false }));
    expect(steps[5]!.speedKmh).toBeCloseTo(36, 0);
    expect(state.ewmaKmh!).toBeCloseTo(36, 0);
  });

  it("accepts a long forward jump after a dead zone and skips the stop it spans", () => {
    const before = drive(route, { to: 2200, speedKmh: 30, seed: 6 });
    const t = before[before.length - 1]!.at;
    // 150 s dark, reappearing 2 km on: 2500 is spanned by more than 300 m
    const after = drive(route, { from: 3200, to: 3600, speedKmh: 30, startAt: t + 150_000 });
    const { steps, skipped } = replay([...before, ...after]);
    expect(steps[before.length]!.decision).toBe("accept");
    expect(skipped).toEqual(["S3"]);
  });

  it("feeds EWMA from noisy and off-route fixes too (the bus is still moving)", () => {
    const s0 = initialTripState();
    const r = stepTrip(
      s0,
      { at: T0, ...offsetPoint(pointAtOffset(route, 100), 500, 180), speedKmh: 20 },
      route,
      stops,
    );
    expect(r.status).toBe("noise");
    expect(r.state.ewmaKmh).toBe(20);
  });
});
