import { describe, expect, it } from "vitest";
import {
  bearing,
  buildCumulativeDistances,
  buildRoute,
  EARTH_RADIUS_M,
  haversine,
  headingAtOffset,
  offsetPoint,
  pointAtOffset,
  projectPointOnSegment,
  segmentAt,
} from "./geometry.ts";
import { at, routeFrom } from "./testkit.ts";

describe("haversine", () => {
  it("measures one degree of latitude on the PostGIS sphere", () => {
    expect(haversine({ lat: 17, lng: 78 }, { lat: 18, lng: 78 })).toBeCloseTo(
      (EARTH_RADIUS_M * Math.PI) / 180,
      3,
    );
  });

  it("is zero for identical points and symmetric", () => {
    const a = at(0, 0);
    const b = at(300, 400);
    expect(haversine(a, a)).toBe(0);
    expect(haversine(a, b)).toBeCloseTo(500, 0);
    expect(haversine(b, a)).toBeCloseTo(haversine(a, b), 9);
  });
});

describe("bearing / offsetPoint", () => {
  it("reads compass directions", () => {
    expect(bearing(at(0, 0), at(0, 100))).toBeCloseTo(0, 1);
    expect(bearing(at(0, 0), at(100, 0))).toBeCloseTo(90, 1);
    expect(bearing(at(0, 0), at(0, -100))).toBeCloseTo(180, 1);
    expect(bearing(at(0, 0), at(-100, 0))).toBeCloseTo(270, 1);
  });

  it("moves the requested distance", () => {
    const p = offsetPoint(at(0, 0), 250, 45);
    expect(haversine(at(0, 0), p)).toBeCloseTo(250, 0);
    expect(bearing(at(0, 0), p)).toBeCloseTo(45, 0);
  });
});

describe("projectPointOnSegment", () => {
  const a = at(0, 0);
  const b = at(200, 0);

  it("drops a perpendicular onto the segment interior", () => {
    const r = projectPointOnSegment(at(50, 30), a, b);
    expect(r.t).toBeCloseTo(0.25, 3);
    expect(r.along).toBeCloseTo(50, 1);
    expect(r.distance).toBeCloseTo(30, 1);
  });

  it("clamps to the end points", () => {
    expect(projectPointOnSegment(at(-40, 30), a, b)).toMatchObject({ t: 0, along: 0 });
    expect(projectPointOnSegment(at(-40, 30), a, b).distance).toBeCloseTo(50, 1);
    const past = projectPointOnSegment(at(260, 0), a, b);
    expect(past.t).toBe(1);
    expect(past.distance).toBeCloseTo(60, 1);
  });

  it("handles a zero-length segment", () => {
    const r = projectPointOnSegment(at(3, 4), a, a);
    expect(r).toMatchObject({ t: 0, along: 0 });
    expect(r.distance).toBeCloseTo(5, 2);
  });
});

describe("routes", () => {
  const route = routeFrom([
    [0, 0],
    [1000, 0],
    [1000, 500],
  ]);

  it("prefix-sums segment lengths", () => {
    const d = buildCumulativeDistances(route.coords);
    expect(d[0]).toBe(0);
    for (let i = 1; i < d.length; i++) expect(d[i]!).toBeGreaterThan(d[i - 1]!);
    expect(route.total).toBeCloseTo(1500, 0);
    expect(buildCumulativeDistances([])).toEqual([]);
  });

  it("rejects degenerate input", () => {
    expect(() => buildRoute([at(0, 0)])).toThrow(/two vertices/);
    expect(() => buildRoute([at(0, 0), at(1, 1)], [0])).toThrow(/one entry per vertex/);
  });

  it("maps an offset to a point and back", () => {
    const p = pointAtOffset(route, 1200);
    expect(haversine(p, at(1000, 200))).toBeLessThan(0.5);
    expect(haversine(pointAtOffset(route, -5), at(0, 0))).toBeLessThan(0.01);
    expect(haversine(pointAtOffset(route, 1e9), at(1000, 500))).toBeLessThan(0.5);
    expect(headingAtOffset(route, 500)).toBeCloseTo(90, 0);
    expect(headingAtOffset(route, 1250)).toBeCloseTo(0, 0);
  });

  it("finds the segment containing an offset", () => {
    expect(segmentAt(route, 0)).toBe(0);
    expect(segmentAt(route, route.total + 10)).toBe(route.coords.length - 2);
    const i = segmentAt(route, 612);
    expect(route.cum[i]!).toBeLessThanOrEqual(612);
    expect(route.cum[i + 1]!).toBeGreaterThan(612);
  });
});
