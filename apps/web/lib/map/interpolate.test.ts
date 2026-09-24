import { describe, expect, it } from "vitest";
import { buildRoute, nearestOnRoute } from "@busmitra/geo";
import { displayAt, EASE_MS, MAX_AHEAD_CADENCES, retarget } from "./interpolate";

// 4 km straight east
const route = buildRoute([
  { lat: 17.3688, lng: 78.5247 },
  { lat: 17.3688, lng: 78.5623 },
]);
const sOf = (p: { lat: number; lng: number }) => nearestOnRoute(p, route, null).s;
const fix = (s: number, at: number, kmh: number, live = true) => ({
  s,
  lat: 0,
  lng: 0,
  at,
  kmh,
  cadenceS: 5,
  live,
});

describe("dead reckoning", () => {
  it("draws the first fix where it is, then advances at the reported speed", () => {
    const tr = retarget(null, fix(1000, 0, 36), 0, route); // 10 m/s
    expect(displayAt(tr, 0, route).s).toBeCloseTo(1000, 3);
    expect(displayAt(tr, 3000, route).s).toBeCloseTo(1030, 3);
  });

  it("stops extrapolating after two cadences — never invents a bus that is not reporting", () => {
    const tr = retarget(null, fix(1000, 0, 36), 0, route);
    const cap = 1000 + 10 * MAX_AHEAD_CADENCES * 5;
    expect(displayAt(tr, 60_000, route).s).toBeCloseTo(cap, 3);
  });

  it("holds a DEGRADED or DARK bus at its last true fix", () => {
    const tr = retarget(null, fix(1000, 0, 36, false), 0, route);
    expect(displayAt(tr, 20_000, route).s).toBe(1000);
  });

  it("eases to a new fix from where the marker is drawn — no visible jump", () => {
    const a = retarget(null, fix(1000, 0, 36), 0, route);
    const drawnAtArrival = displayAt(a, 5000, route).s!; // 1050
    // the fix lands 30 m behind where we had drawn the bus
    const b = retarget(a, fix(1020, 5000, 36), 5000, route);
    expect(displayAt(b, 5000, route).s).toBeCloseTo(drawnAtArrival, 3);
    // after the ease, the marker is on the new trajectory
    expect(displayAt(b, 5000 + EASE_MS, route).s).toBeCloseTo(1020 + 10, 3);
    // and every intermediate frame moves by less than a car length
    let prev = drawnAtArrival;
    for (let t = 5000; t <= 5000 + EASE_MS; t += 16) {
      const s = displayAt(b, t, route).s!;
      expect(Math.abs(s - prev)).toBeLessThan(5);
      prev = s;
    }
  });

  it("never runs past the end of the route", () => {
    const tr = retarget(null, fix(route.total - 5, 0, 36), 0, route);
    expect(displayAt(tr, 9000, route).s).toBeCloseTo(route.total, 3);
  });

  it("places the offset on the polyline", () => {
    const tr = retarget(null, fix(2000, 0, 0), 0, route);
    expect(sOf(displayAt(tr, 0, route).pos)).toBeCloseTo(2000, 0);
  });
});
