import { describe, expect, it } from "vitest";
import { formatAge, formatClock, formatEtaRange, PRESENCE_STYLE } from "./index.ts";

describe("ui tokens", () => {
  it("gives every presence state a shape and a word, not only a colour", () => {
    const shapes = new Set(Object.values(PRESENCE_STYLE).map((s) => s.shape));
    expect(shapes.size).toBeGreaterThanOrEqual(3);
    for (const s of Object.values(PRESENCE_STYLE)) expect(s.label.length).toBeGreaterThan(2);
  });

  it("formats ages the way the degraded states print them", () => {
    expect(formatAge(34.9)).toBe("34 s");
    expect(formatAge(134)).toBe("2 min 14 s");
    expect(formatAge(120)).toBe("2 min");
    expect(formatAge(3780)).toBe("1 h 3 min");
    expect(formatAge(-5)).toBe("0 s");
  });

  it("prints clock times in IST regardless of the device timezone", () => {
    expect(formatClock("2026-09-23T02:12:00Z")).toBe("07:42");
  });

  it("reports an ETA as a range", () => {
    expect(formatEtaRange(240, 360)).toBe("4–6 min");
    expect(formatEtaRange(20, 50)).toBe("<1–1 min");
    expect(formatEtaRange(10, 20)).toBe("under 1 min");
    expect(formatEtaRange(300, 310)).toBe("5 min");
  });
});
