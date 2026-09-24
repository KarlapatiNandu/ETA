import { describe, expect, it } from "vitest";
import { computeEta, ETA, resolveRung, type SegmentStat } from "./eta.ts";

const stat = (median: number, n = 10, p10 = median * 0.6): SegmentStat => ({
  medianKmh: median,
  p10Kmh: p10,
  p90Kmh: median * 1.3,
  sampleCount: n,
});

describe("resolveRung — the v_hist fallback ladder", () => {
  it("takes the most specific rung with at least 5 samples", () => {
    const r = resolveRung([stat(20, 1), stat(22, 4), stat(25, 6), stat(30, 40)]);
    expect(r).toEqual({ stat: stat(25, 6), rung: 3 });
  });

  it("returns null (cold start) when no rung qualifies", () => {
    expect(resolveRung([null, undefined, stat(20, 4)])).toBeNull();
    expect(resolveRung([])).toBeNull();
  });
});

describe("computeEta", () => {
  it("is zero when the bus is at or past the target", () => {
    expect(computeEta(500, 500, { hist: [], osrm: [], liveKmh: 20 })).toEqual({
      p50S: 0,
      p90S: 0,
      confidence: "high",
    });
  });

  it("uses the history blend 0.55·hist + 0.35·live + 0.10·osrm", () => {
    // 1 km over 5 segments, hist 30, live 30, osrm 30 → 30 km/h → 120 s
    const eta = computeEta(0, 1000, {
      hist: Array(5).fill(stat(30)),
      osrm: Array(5).fill(30),
      liveKmh: 30,
    });
    expect(eta.p50S).toBe(120);
    expect(eta.p90S).toBeGreaterThan(eta.p50S);
    expect(eta.confidence).toBe("high");
  });

  it("cold start: 0.60·osrm·congestion + 0.40·live", () => {
    // osrm 40, live 20 → congestion 0.5 → 0.6·40·0.5 + 0.4·20 = 20 km/h over 1 km = 180 s
    const eta = computeEta(0, 1000, { hist: [], osrm: Array(5).fill(40), liveKmh: 20 });
    expect(eta.p50S).toBe(180);
    expect(eta.p90S).toBe(Math.round(180 * ETA.COLD_P90_FACTOR));
    expect(eta.confidence).toBe("low");
  });

  it("clamps congestion to [0.3, 1.2] and speed to [5, 60] km/h", () => {
    const crawl = computeEta(0, 1000, { hist: [], osrm: Array(5).fill(50), liveKmh: 1 });
    // 0.6·50·0.3 + 0.4·1 = 9.4 km/h
    expect(crawl.p50S).toBe(Math.round(1000 / (9.4 / 3.6)));
    const flying = computeEta(0, 1000, { hist: [], osrm: Array(5).fill(200), liveKmh: 200 });
    expect(flying.p50S).toBe(60); // 60 km/h cap
    const stuck = computeEta(0, 100, { hist: [], osrm: [], liveKmh: 0 });
    expect(stuck.p50S).toBe(72); // 5 km/h floor
  });

  it("without OSRM or history falls back to live speed, then a town-traffic guess", () => {
    expect(computeEta(0, 1000, { hist: [], osrm: [], liveKmh: 36 }).p50S).toBe(100);
    expect(computeEta(0, 1000, { hist: [], osrm: [], liveKmh: null }).p50S).toBe(180);
    // osrm only, no live: congestion 1
    expect(computeEta(0, 1000, { hist: [], osrm: Array(5).fill(30), liveKmh: null }).p50S).toBe(
      120,
    );
  });

  it("history without live or osrm uses the median for the missing terms", () => {
    expect(
      computeEta(0, 1000, { hist: Array(5).fill(stat(36)), osrm: [], liveKmh: null }).p50S,
    ).toBe(100);
  });

  it("adds dwell for stops strictly between the bus and the target", () => {
    const model = { hist: [], osrm: Array(10).fill(36), liveKmh: null };
    const base = computeEta(0, 2000, model).p50S;
    const withStops = computeEta(0, 2000, model, [
      { offset: 0 }, // behind: excluded
      { offset: 500 }, // default 30 s
      { offset: 1200, dwellS: 45 },
      { offset: 2000 }, // the target itself: excluded
    ]);
    expect(withStops.p50S).toBe(base + 75);
  });

  it("reports medium confidence when history covers part of the way", () => {
    const hist = [stat(30), stat(30), null, null, null];
    expect(computeEta(0, 1000, { hist, osrm: Array(5).fill(30), liveKmh: 30 }).confidence).toBe(
      "medium",
    );
  });

  it("handles partial first and last segments", () => {
    const eta = computeEta(150, 450, { hist: [], osrm: [36, 36, 36], liveKmh: null });
    expect(eta.p50S).toBe(30);
  });
});
