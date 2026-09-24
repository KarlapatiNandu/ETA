import { describe, expect, it } from "vitest";
import { haversine, offsetPoint } from "./geometry.ts";
import { dedupe, simplifyTrace } from "./simplify.ts";
import { at, gaussian, prng } from "./testkit.ts";

describe("simplifyTrace (Douglas–Peucker)", () => {
  it("reduces a noisy straight 1 Hz trace to its end points", () => {
    const rng = prng(7);
    const pts = Array.from({ length: 300 }, (_, i) =>
      offsetPoint(at(i * 8, 0), Math.abs(gaussian(rng)) * 1.5, rng() * 360),
    );
    const out = simplifyTrace(pts, 8);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out[0]).toBe(pts[0]);
    expect(out[out.length - 1]).toBe(pts[pts.length - 1]);
  });

  it("keeps corners", () => {
    const pts = [at(0, 0), at(100, 1), at(200, 0), at(200, 100), at(201, 200)];
    const out = simplifyTrace(pts, 5);
    expect(out).toEqual([at(0, 0), at(200, 0), at(201, 200)]);
  });

  it("keeps a trace that doubles back on itself", () => {
    // out 500 m and back: every interior point is on the chord's infinite line, but the
    // turnaround is 500 m from the chord *segment* and must survive
    const pts = [at(0, 0), at(250, 0), at(500, 0), at(250, 1), at(0, 2)];
    const out = simplifyTrace(pts, 5);
    expect(out).toContainEqual(at(500, 0));
  });

  it("passes short input through and preserves extra properties", () => {
    const two = [
      { ...at(0, 0), t: 1 },
      { ...at(9, 9), t: 2 },
    ];
    expect(simplifyTrace(two, 5)).toEqual(two);
    const loop = [at(0, 0), at(50, 50), at(0, 0)];
    expect(simplifyTrace(loop, 5)).toHaveLength(3);
  });
});

describe("dedupe", () => {
  it("drops consecutive points closer than the gap", () => {
    const out = dedupe([at(0, 0), at(0.1, 0), at(10, 0), at(10, 0.2), at(20, 0)]);
    expect(out).toHaveLength(3);
    for (let i = 1; i < out.length; i++) expect(haversine(out[i - 1]!, out[i]!)).toBeGreaterThan(1);
  });
});
