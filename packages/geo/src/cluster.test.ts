import { describe, expect, it } from "vitest";
import {
  bufferedHull,
  centroid,
  convexHullXY,
  dbscan,
  NOISE,
  percentile,
  ringContains,
} from "./cluster.ts";
import { haversine, offsetPoint, type LatLng } from "./geometry.ts";

const UPPAL: LatLng = { lat: 17.4015, lng: 78.5591 };
const KOTI: LatLng = { lat: 17.3833, lng: 78.4867 };

/** n points on a ring of radius r around c (deterministic "noise") */
const around = (c: LatLng, n: number, r: number) =>
  Array.from({ length: n }, (_, i) => offsetPoint(c, (r * ((i % 3) + 1)) / 3, (360 * i) / n));

describe("dbscan", () => {
  it("finds two separate dead zones and leaves a stray outage as noise", () => {
    const pts = [...around(UPPAL, 6, 60), ...around(KOTI, 5, 40), offsetPoint(UPPAL, 2000, 90)];
    const r = dbscan(pts, 150, 4);
    expect(r.count).toBe(2);
    expect(new Set(r.labels.slice(0, 6))).toEqual(new Set([0]));
    expect(new Set(r.labels.slice(6, 11))).toEqual(new Set([1]));
    expect(r.labels[11]).toBe(NOISE);
  });

  it("needs minPts including the point itself — three outages are not a zone", () => {
    expect(dbscan(around(UPPAL, 3, 20), 150, 4).count).toBe(0);
    expect(dbscan(around(UPPAL, 4, 20), 150, 4).count).toBe(1);
  });

  it("chains through core points but not through a border point", () => {
    // a line of points 100 m apart: every inner point is core at ε = 150 m, minPts = 3
    const line = Array.from({ length: 8 }, (_, i) => offsetPoint(KOTI, i * 100, 0));
    expect(dbscan(line, 150, 3).count).toBe(1);
    // minPts 4: nobody has 4 neighbours on a line with 100 m spacing and ε 150 m
    expect(dbscan(line, 150, 4).count).toBe(0);
  });

  it("assigns a border point but does not expand from it", () => {
    // along an east–west line: a core blob at −100…0 m, a border point at +140 m (one blob
    // neighbour), and a point at +270 m that only the border point reaches
    const at = (m: number) => offsetPoint(UPPAL, Math.abs(m), m < 0 ? 270 : 90);
    const blob = [-100, -60, -20, 0].map(at);
    const r = dbscan([...blob, at(140), at(270)], 150, 4);
    expect(r.count).toBe(1);
    expect(r.labels[4]).toBe(0);
    expect(r.core[4]).toBe(false);
    expect(r.labels[5]).toBe(NOISE);
  });

  it("is deterministic and handles empty input and grid-cell boundaries", () => {
    expect(dbscan([], 150, 4)).toEqual({ labels: [], count: 0, core: [] });
    const pts = around(KOTI, 9, 140);
    expect(dbscan(pts, 150, 4)).toEqual(dbscan(pts, 150, 4));
    // two points 149 m apart straddling any grid line are still neighbours
    const a = KOTI;
    const b = offsetPoint(KOTI, 149, 45);
    expect(haversine(a, b)).toBeLessThan(150);
    expect(dbscan([a, b], 150, 2).count).toBe(1);
  });
});

describe("convex hull and buffer", () => {
  it("hull drops interior points", () => {
    const h = convexHullXY([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 },
    ]);
    expect(h).toHaveLength(4);
    expect(convexHullXY([{ x: 1, y: 1 }])).toHaveLength(1);
  });

  it("buffers a cluster so every point sits at least bufferM inside the ring", () => {
    const pts = around(UPPAL, 7, 80);
    const ring = bufferedHull(pts, 50);
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    for (const p of pts) {
      expect(ringContains(ring, p)).toBe(true);
      for (let b = 0; b < 360; b += 30)
        expect(ringContains(ring, offsetPoint(p, 49, b))).toBe(true);
    }
    expect(ringContains(ring, offsetPoint(UPPAL, 400, 0))).toBe(false);
  });

  it("turns one point into a disc and two into a capsule", () => {
    const disc = bufferedHull([KOTI], 50);
    expect(ringContains(disc, KOTI)).toBe(true);
    expect(ringContains(disc, offsetPoint(KOTI, 49, 200))).toBe(true);
    expect(ringContains(disc, offsetPoint(KOTI, 60, 200))).toBe(false);
    const b = offsetPoint(KOTI, 300, 90);
    const capsule = bufferedHull([KOTI, b], 40);
    expect(ringContains(capsule, offsetPoint(KOTI, 150, 90))).toBe(true);
    expect(ringContains(capsule, offsetPoint(offsetPoint(KOTI, 150, 90), 60, 0))).toBe(false);
    expect(bufferedHull([], 50)).toEqual([]);
    expect(ringContains([KOTI, KOTI], KOTI)).toBe(false);
  });
});

describe("helpers", () => {
  it("centroid and nearest-rank percentile", () => {
    const c = centroid([
      { lat: 0, lng: 0 },
      { lat: 2, lng: 4 },
    ]);
    expect(c).toEqual({ lat: 1, lng: 2 });
    expect(percentile([90, 30, 60, 120, 45], 90)).toBe(120);
    expect(percentile([90, 30, 60, 120, 45], 50)).toBe(60);
    expect(percentile([7], 0)).toBe(7);
  });
});
