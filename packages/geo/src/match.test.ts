import { describe, expect, it } from "vitest";
import { haversine, offsetPoint, pointAtOffset } from "./geometry.ts";
import {
  chunkWindows,
  findPasses,
  MATCH,
  projectStops,
  stitchChunks,
  type MatchedChunk,
} from "./match.ts";
import { at, routeFrom } from "./testkit.ts";

describe("chunkWindows", () => {
  it("keeps short traces in one request", () => {
    expect(chunkWindows(0)).toEqual([]);
    expect(chunkWindows(80)).toEqual([[0, 80]]);
  });

  it("splits a 45-minute 1 Hz survey into ≤80-point windows overlapping by 15", () => {
    const w = chunkWindows(2700);
    for (const [s, e] of w) expect(e - s).toBeLessThanOrEqual(MATCH.CHUNK);
    for (let i = 1; i < w.length; i++) expect(w[i - 1]![1] - w[i]![0]).toBe(MATCH.OVERLAP);
    expect(w[0]![0]).toBe(0);
    expect(w[w.length - 1]![1]).toBe(2700);
  });

  it("rejects an overlap that would never advance", () => {
    expect(() => chunkWindows(200, 10, 10)).toThrow(/overlap/);
  });
});

describe("stitchChunks", () => {
  // a 3 km L-shaped road; 1 point every 10 m stands in for the survey
  const road = routeFrom([
    [0, 0],
    [2000, 0],
    [2000, 1000],
  ]);
  const trace = Array.from({ length: 301 }, (_, i) => pointAtOffset(road, i * 10));

  /** What a perfect map-matcher would return for trace[start, end). */
  const matched = (start: number, end: number): MatchedChunk => {
    const from = start * 10;
    const to = (end - 1) * 10;
    const geometry = [pointAtOffset(road, from)];
    for (let i = 0; i < road.coords.length; i++) {
      if (road.cum[i]! > from && road.cum[i]! < to) geometry.push(road.coords[i]!);
    }
    geometry.push(pointAtOffset(road, to));
    return { start, geometry, tracepoints: trace.slice(start, end) };
  };

  it("joins overlapping chunks into one line with the overlap counted once", () => {
    const chunks = chunkWindows(trace.length).map(([s, e]) => matched(s, e));
    const { line, gaps } = stitchChunks(chunks);
    expect(gaps).toBe(0);
    const length = line.slice(1).reduce((sum, p, i) => sum + haversine(line[i]!, p), 0);
    expect(length).toBeCloseTo(3000, -1); // doubled overlaps would add ~150 m per join
    expect(haversine(line[0]!, at(0, 0))).toBeLessThan(0.5);
    expect(haversine(line[line.length - 1]!, at(2000, 1000))).toBeLessThan(0.5);
  });

  it("concatenates and counts a gap when no overlap point matched in both chunks", () => {
    const a = matched(0, 80);
    const b = matched(65, 145);
    b.tracepoints = b.tracepoints.map((p, i) => (i < 15 ? null : p));
    expect(stitchChunks([a, b]).gaps).toBe(1);
  });

  it("ignores chunks OSRM could not match at all", () => {
    expect(stitchChunks([])).toEqual({ line: [], gaps: 0 });
    const only = matched(0, 80);
    expect(stitchChunks([only, { start: 65, geometry: [], tracepoints: [] }]).line.length).toBe(
      only.geometry.length,
    );
  });
});

describe("findPasses / projectStops", () => {
  // circular route: out along y = 0 and back along y = 60, serving the gate stop twice
  const loop = routeFrom([
    [0, 0],
    [3000, 0],
    [3000, 60],
    [0, 60],
  ]);
  const gate = at(1500, 30); // between the two carriageways

  it("finds one pass per carriageway", () => {
    const passes = findPasses(loop, gate);
    expect(passes).toHaveLength(2);
    expect(passes[0]!.s).toBeCloseTo(1500, 0);
    expect(passes[1]!.s).toBeCloseTo(3060 + 1500, 0);
  });

  it("places a repeated stop on its second pass when given in order", () => {
    const [first, depot, again] = projectStops(loop, [
      { point: gate },
      { point: at(3000, 30) },
      { point: gate },
    ]);
    expect(first!.s).toBeCloseTo(1500, 0);
    expect(depot!.s).toBeCloseTo(3030, 0);
    expect(again!.s).toBeCloseTo(4560, 0);
    expect([first, depot, again].some((p) => p!.outOfOrder)).toBe(false);
  });

  it("uses the admin's click offset to choose the pass", () => {
    const [p] = projectStops(loop, [{ point: gate, near: 4400 }]);
    expect(p!.s).toBeCloseTo(4560, 0);
  });

  it("flags a stop that can only sit behind the previous one", () => {
    const res = projectStops(loop, [{ point: at(2900, 0) }, { point: at(100, 0) }]);
    expect(res[1]!.outOfOrder).toBe(false); // the return pass at y=60 is within reach
    const straight = routeFrom([
      [0, 0],
      [3000, 0],
    ]);
    const back = projectStops(straight, [{ point: at(2900, 0) }, { point: at(100, 0) }]);
    expect(back[1]!.outOfOrder).toBe(true);
  });

  it("falls back to the nearest point for a stop far from the route", () => {
    const [p] = projectStops(loop, [{ point: offsetPoint(at(1000, 0), 400, 180) }]);
    expect(p!.distance).toBeCloseTo(400, 0);
    expect(p!.s).toBeCloseTo(1000, 0);
  });
});
