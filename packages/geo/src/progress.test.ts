import { describe, expect, it } from "vitest";
import { enforceMonotonicProgress, ewma, maxPlausibleJump, PROGRESS } from "./progress.ts";

describe("enforceMonotonicProgress", () => {
  it("accepts the first fix of a trip", () => {
    expect(enforceMonotonicProgress(null, 812, 0, 0)).toEqual({
      decision: "accept",
      s: 812,
      backwardRun: 0,
    });
  });

  it("accepts forward progress", () => {
    expect(enforceMonotonicProgress(1000, 1040, 5, 0)).toMatchObject({
      decision: "accept",
      s: 1040,
    });
  });

  it("holds (never follows) jitter inside the backward tolerance", () => {
    const r = enforceMonotonicProgress(1000, 985, 5, 2);
    expect(r).toEqual({ decision: "accept", s: 1000, backwardRun: 0 });
  });

  it("rejects a fix more than 30 m behind as jitter", () => {
    const r = enforceMonotonicProgress(1000, 960, 5, 0);
    expect(r).toEqual({ decision: "reject_backward", s: 1000, backwardRun: 1 });
  });

  it("re-snaps on the 4th consecutive backward fix — a real reversal, not jitter", () => {
    let run = 0;
    const decisions: string[] = [];
    for (const s of [900, 850, 800, 750]) {
      const r = enforceMonotonicProgress(1000, s, 5, run);
      decisions.push(r.decision);
      run = r.backwardRun;
    }
    expect(decisions).toEqual(["reject_backward", "reject_backward", "reject_backward", "resnap"]);
    expect(run).toBe(0);
    expect(PROGRESS.RESNAP_AFTER_BACKWARD).toBe(4);
  });

  it("an accepted fix clears the backward run", () => {
    expect(enforceMonotonicProgress(1000, 1010, 5, 3).backwardRun).toBe(0);
  });

  it("rejects a GPS spike further ahead than the bus could have driven", () => {
    const r = enforceMonotonicProgress(1000, 1000 + maxPlausibleJump(5) + 1, 5, 1);
    expect(r).toEqual({ decision: "reject_spike", s: 1000, backwardRun: 1 });
  });

  it("the spike budget grows with time since the last accepted fix", () => {
    // 1 km ahead is a spike after 5 s, but plausible after a 60 s dead zone
    expect(enforceMonotonicProgress(1000, 2000, 5, 0).decision).toBe("reject_spike");
    expect(enforceMonotonicProgress(1000, 2000, 60, 0).decision).toBe("accept");
    expect(maxPlausibleJump(-3)).toBe(PROGRESS.JUMP_SLACK_M);
  });
});

describe("ewma", () => {
  it("seeds from the first sample and weights new samples by α = 0.3", () => {
    expect(ewma(null, 30)).toBe(30);
    expect(ewma(30, 40)).toBeCloseTo(33, 9);
    expect(ewma(30, 40, 0.5)).toBe(35);
  });
});
