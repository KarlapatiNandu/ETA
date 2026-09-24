import { describe, expect, it } from "vitest";
import { nearestOnRoute, SNAP, snapToRoute } from "./snap.ts";
import { at, routeFrom } from "./testkit.ts";

// 6 km out along y = 0, a 40 m jog north, 6 km back along y = 40: two passes closer together
// than the off-route threshold. Only the forward-biased window can tell them apart.
const hairpin = routeFrom([
  [0, 0],
  [6000, 0],
  [6000, 40],
  [0, 40],
]);

describe("snapToRoute", () => {
  it("snaps an on-route fix", () => {
    const r = snapToRoute(at(510, 12), hairpin, 18);
    expect(r.status).toBe("on_route");
    expect(r.s).toBeCloseTo(510, 0);
    expect(r.distance).toBeCloseTo(12, 0);
    expect(r.offRouteRun).toBe(0);
  });

  it("holds a single far fix as noise, then declares off-route on the third", () => {
    const far = at(2000, -200);
    const one = snapToRoute(far, hairpin, 70, 0);
    expect(one.status).toBe("noise");
    const two = snapToRoute(far, hairpin, 70, one.offRouteRun);
    expect(two.status).toBe("noise");
    const three = snapToRoute(far, hairpin, 70, two.offRouteRun);
    expect(three.status).toBe("off_route");
    expect(three.offRouteRun).toBe(SNAP.OFF_ROUTE_SUSTAIN);
  });

  it("searches globally once off-route, so rejoining anywhere is caught", () => {
    // hint says outbound km 1, but the bus rejoined on the return leg
    const back = snapToRoute(at(3000, 45), hairpin, 40, SNAP.OFF_ROUTE_SUSTAIN);
    expect(back.status).toBe("on_route");
    expect(back.s).toBeCloseTo(6040 + 3000, -1);
  });
});

describe("the forward-biased window (route that loops back near itself)", () => {
  // outbound at x = 1000, noise pushes the fix to y = 25 — closer to the return leg (15 m)
  // than to the outbound one (25 m)
  const noisy = at(1000, 25);

  it("global search picks the wrong pass", () => {
    expect(nearestOnRoute(noisy, hairpin, null).s).toBeGreaterThan(6000);
  });

  it("the window keeps the bus on the pass it is actually on", () => {
    const r = snapToRoute(noisy, hairpin, 38);
    expect(r.status).toBe("on_route");
    expect(r.s).toBeCloseTo(1000, 0);
  });

  it("widens forwards (never backwards) after a long dead zone", () => {
    // last snapped at index 10 (250 m); the bus reappears 4 km on — 160 vertices ahead
    const r = snapToRoute(at(4000, 3), hairpin, 10);
    expect(r.status).toBe("on_route");
    expect(r.s).toBeCloseTo(4000, 0);
  });

  it("does not jump back onto the outbound pass from the return leg", () => {
    // bus on the return leg at x = 1000 (s ≈ 11,040); noise towards the outbound pass
    const idx = hairpin.coords.length - 45;
    const r = snapToRoute(at(1000, 15), hairpin, idx);
    expect(r.s).toBeGreaterThan(6000);
  });

  it("clamps the window at both ends of the route", () => {
    expect(snapToRoute(at(0, 0), hairpin, 0).s).toBeCloseTo(0, 3);
    expect(snapToRoute(at(0, 40), hairpin, hairpin.coords.length - 2).s).toBeCloseTo(
      hairpin.total,
      0,
    );
  });
});
