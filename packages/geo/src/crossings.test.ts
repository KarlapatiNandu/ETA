import { describe, expect, it } from "vitest";
import {
  CROSSING,
  detectCrossings,
  finishCrossings,
  initialCrossingState,
  reachedIndex,
  resetCrossings,
  type CrossingState,
  type RouteStop,
  type StopEvent,
} from "./crossings.ts";

const stops: RouteStop[] = [
  { seq: 1, stopId: "A", offset: 0 },
  { seq: 2, stopId: "B", offset: 1000 },
  { seq: 3, stopId: "C", offset: 2500 },
  { seq: 4, stopId: "D", offset: 4000 },
];

/** Feed (s, speed) samples 5 s apart; return every event and the final state. */
function run(
  samples: [number, number | null][],
  opts: { state?: CrossingState; distanceM?: number; t0?: number } = {},
) {
  let state = opts.state ?? initialCrossingState();
  let sPrev: number | null = null;
  let prevAt: number | null = null;
  const events: StopEvent[] = [];
  samples.forEach(([s, v], i) => {
    const at = (opts.t0 ?? 0) + i * 5000;
    const r = detectCrossings(state, stops, {
      sPrev,
      sNow: s,
      prevAt,
      at,
      speedKmh: v,
      distanceM: opts.distanceM ?? 5,
    });
    state = r.state;
    events.push(...r.events);
    sPrev = s;
    prevAt = at;
  });
  return { state, events, kinds: events.map((e) => `${e.kind}:${e.stopId}`) };
}

describe("detectCrossings", () => {
  it("origin stop: a bus parked at the first stop arrives on its first fix, departs when it pulls away", () => {
    const { kinds } = run([
      [3, 0],
      [4, 0],
      [60, 25],
    ]);
    expect(kinds).toEqual(["arrived:A", "departed:A"]);
  });

  it("confirms an arrival by the bus actually stopping within 60 s of the crossing", () => {
    const { kinds, events } = run([
      [900, 30],
      [990, 20],
      [1004, 4], // crossed D_B, then stopped
      [1006, 0],
      [1080, 25],
    ]);
    // first fix is 900 m past stop A, so A is skipped (a mid-route start), not arrived
    expect(kinds).toEqual(["skipped:A", "arrived:B", "departed:B"]);
    // interpolated to the moment the offset crossed 1000 m, between t = 5 s and t = 10 s
    const arrived = events.find((e) => e.kind === "arrived" && e.stopId === "B")!;
    expect(arrived.at).toBeGreaterThan(5000);
    expect(arrived.at).toBeLessThan(10000);
    expect(arrived.seq).toBe(2);
  });

  it("a stop slow *before* the crossing (bus halted short of the pole) still confirms", () => {
    const { kinds } = run([
      [980, 3],
      [990, 0],
      [1020, 15],
    ]);
    expect(kinds).toContain("arrived:B");
  });

  it("confirms a drive-through once the bus is 100 m past without stopping", () => {
    const { kinds } = run([
      [950, 40],
      [1010, 40], // crossed at speed: candidate only
      [1060, 40],
      [1105, 40], // D_B + 100: drove straight through
    ]);
    expect(kinds.slice(-2)).toEqual(["arrived:B", "departed:B"]);
  });

  it("fixture: 83 m ping gap at 60 km/h — a stop between two pings is not missed", () => {
    // 60 km/h × 5 s = 83.3 m; the stop sits in the middle of the gap
    const { kinds } = run([
      [958.4, 60],
      [1041.7, 60],
      [1125, 60],
    ]);
    expect(kinds).toContain("arrived:B");
    expect(kinds).not.toContain("skipped:B");
  });

  it("the skipped rule: a stop passed without a confirmable arrival is written off, and every later stop still arrives", () => {
    // dead zone spanning stop B: last fix 200 m before it, next fix 400 m past it
    const { kinds, events } = run([
      [800, 40],
      [1400, 40],
      [2450, 40],
      [2505, 5],
      [2600, 30],
    ]);
    expect(kinds).toEqual(["skipped:A", "skipped:B", "arrived:C", "departed:C"]);
    expect(events.find((e) => e.stopId === "B")!.seq).toBe(2);
  });

  it("a detour past a stop (never within 150 m of it) is a skip, not an arrival", () => {
    // offsets cross D_B, but the fixes are 160 m off the route line
    const first = run([[980, 30]]);
    const { kinds } = run(
      [
        [980, 30],
        [1030, 30],
        [1350, 30],
      ],
      { distanceM: 160, state: first.state },
    );
    expect(kinds).not.toContain("arrived:B");
    expect(kinds).toContain("skipped:B");
  });

  it("enforces sequence: a pending stop resolves before the next one is considered", () => {
    // B is crossed at speed (candidate, unconfirmed); the next fix is already past C
    const { kinds } = run([
      [990, 20],
      [1010, 20],
      [2600, 20],
    ]);
    expect(kinds).toEqual(["skipped:A", "arrived:B", "departed:B", "arrived:C", "departed:C"]);
  });

  it("stops closer together than the departure rule can resolve are departed by the next arrival", () => {
    const close: RouteStop[] = [
      { seq: 1, stopId: "P", offset: 500 },
      { seq: 2, stopId: "Q", offset: 530 },
    ];
    let state = initialCrossingState();
    const events: StopEvent[] = [];
    for (const [i, s, v] of [
      [0, 450, 20],
      [1, 505, 2],
      [2, 535, 2],
      [3, 700, 30],
    ] as const) {
      const r = detectCrossings(state, close, {
        sPrev: i === 0 ? null : [450, 505, 535][i - 1]!,
        sNow: s,
        prevAt: i === 0 ? null : (i - 1) * 5000,
        at: i * 5000,
        speedKmh: v,
        distanceM: 3,
      });
      state = r.state;
      events.push(...r.events);
    }
    expect(events.map((e) => `${e.kind}:${e.stopId}`)).toEqual([
      "arrived:P",
      "departed:P",
      "arrived:Q",
      "departed:Q",
    ]);
  });

  it("a mid-route start skips the stops behind the bus", () => {
    const { kinds, state } = run([[2600, 20]]);
    // 100 m past C at speed reads as a drive-through of C
    expect(kinds).toEqual(["skipped:A", "skipped:B", "arrived:C", "departed:C"]);
    expect(reachedIndex(state)).toBe(2);
  });

  it("does nothing between stops", () => {
    const r = detectCrossings(
      { next: 2, candidate: null, departing: null, lastSlowAt: null },
      stops,
      { sPrev: 1500, sNow: 1550, prevAt: 0, at: 5000, speedKmh: 30, distanceM: 4 },
    );
    expect(r.events).toEqual([]);
  });

  it("finishes cleanly at the last stop", () => {
    const { kinds, state } = run(
      [
        [3950, 20],
        [4002, 0],
        [4100, 20],
        [4500, 20],
      ],
      { state: { next: 3, candidate: null, departing: null, lastSlowAt: null } },
    );
    expect(kinds).toEqual(["arrived:D", "departed:D"]);
    expect(state.next).toBe(stops.length);
  });

  it("has thresholds that match ARCHITECTURE §5.4", () => {
    expect(CROSSING).toMatchObject({
      ARRIVE_SPEED_KMH: 8,
      DRIVE_THROUGH_M: 100,
      DEPART_SPEED_KMH: 12,
      DEPART_PAST_M: 50,
      SKIP_PAST_M: 300,
      MAX_APPROACH_M: 150,
    });
  });
});

describe("finishCrossings (explicit trip end)", () => {
  it("resolves a terminal stop that was crossed but could never reach the drive-through margin", () => {
    const pending: CrossingState = {
      next: 3,
      candidate: { index: 3, at: 42_000 },
      departing: 2,
      lastSlowAt: null,
    };
    const r = finishCrossings(pending, stops, 60_000);
    expect(r.events.map((e) => `${e.kind}:${e.stopId}@${e.at}`)).toEqual([
      "departed:C@42000",
      "arrived:D@42000",
      "departed:D@60000",
    ]);
    expect(r.state).toMatchObject({ next: 4, candidate: null, departing: null });
  });

  it("records nothing for stops the trip never reached", () => {
    const r = finishCrossings(
      { next: 1, candidate: null, departing: null, lastSlowAt: null },
      stops,
      1,
    );
    expect(r.events).toEqual([]);
  });
});

describe("resetCrossings", () => {
  it("resets the sequence to the stop implied by the new offset", () => {
    expect(resetCrossings(stops, 1200).next).toBe(2);
    expect(resetCrossings(stops, -10).next).toBe(0);
    expect(resetCrossings(stops, 9999).next).toBe(stops.length);
  });
});
