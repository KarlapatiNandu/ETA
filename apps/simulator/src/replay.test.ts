import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CADENCE } from "@busmitra/contracts/tracker";
import { replayTrace } from "./model.ts";

/**
 * The fixtures corpus (tests/fixtures): traces replay deterministically, which is what makes a
 * failure seen once reproducible for ever (BUILD_PLAN Stage 1).
 */
const file = resolve(
  import.meta.dirname,
  "../../../tests/fixtures/traces/dilsukhnagar-malakpet-synthetic.json",
);
const fixture = JSON.parse(readFileSync(file, "utf8")) as {
  synthetic: boolean;
  pings: { t: string; lat: number; lng: number; speed_kmh: number; accuracy_m: number }[];
};

describe("trace fixture", () => {
  it("is inside the Hyderabad extract and monotonic in time", () => {
    expect(fixture.pings.length).toBeGreaterThan(50);
    let last = -Infinity;
    for (const p of fixture.pings) {
      expect(p.lat).toBeGreaterThan(17.15);
      expect(p.lat).toBeLessThan(17.7);
      expect(p.lng).toBeGreaterThan(78.15);
      expect(p.lng).toBeLessThan(78.8);
      const t = Date.parse(p.t);
      expect(t).toBeGreaterThan(last);
      last = t;
    }
  });

  it("replays to the same batches every time, shifted to the given start", () => {
    const t0 = Date.UTC(2026, 8, 30, 2, 0, 0);
    const a = replayTrace(fixture, t0);
    const b = replayTrace(fixture, t0);
    expect(JSON.stringify(a.batches)).toBe(JSON.stringify(b.batches));
    expect(a.pings[0]!.recorded_at).toBe(new Date(t0).toISOString());
    expect(a.batches.every((x) => x.pings.length <= CADENCE.MAX_BATCH)).toBe(true);
    // every fix is sent exactly once
    expect(a.batches.flatMap((x) => x.pings.map((p) => p.recorded_at))).toEqual(
      a.pings.map((p) => p.recorded_at),
    );
  });

  it("buffers and flushes when the fixture's own dead zone is replayed as an offline window", () => {
    const t0 = Date.UTC(2026, 8, 30, 2, 0, 0);
    const r = replayTrace(fixture, t0, { offline: [[60_000, 180_000]] });
    const flush = r.batches.find((x) => x.kind === "flush")!;
    expect(flush.pings.length).toBeGreaterThan(5);
    expect(Date.parse(flush.pings[0]!.recorded_at)).toBeLessThan(flush.sendAt - 60_000);
  });
});
