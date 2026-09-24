import { describe, expect, it } from "vitest";
import {
  contextFrom,
  inSpan,
  instruments,
  RollingWindow,
  startTelemetry,
  traceparentOf,
} from "./index.ts";

describe("RollingWindow", () => {
  it("reports nearest-rank percentiles over the window only", () => {
    const w = new RollingWindow(60_000);
    for (let i = 1; i <= 100; i++) w.add(i, 1000 + i);
    expect(w.snapshot(2000)).toEqual({ n: 100, p50: 50, p95: 95, max: 100 });
    // a minute later the first 40 have aged out
    const later = w.snapshot(1000 + 40 + 60_000 + 1);
    expect(later.n).toBe(60);
    expect(later.p50).toBe(70);
    expect(new RollingWindow(1000).snapshot(0)).toEqual({ n: 0, p50: null, p95: null, max: null });
  });

  it("is bounded by count, oldest first, and compacts its memory", () => {
    const w = new RollingWindow(10 ** 9, 1000);
    for (let i = 0; i < 20_000; i++) w.add(i, i);
    const s = w.snapshot(20_000);
    expect(s.n).toBe(1000);
    expect(s.max).toBe(19_999);
    expect(s.p50).toBe(19_499);
  });
});

describe("telemetry off (no OTLP endpoint)", () => {
  it("starts as a no-op, and spans, traceparents and instruments cost nothing", async () => {
    const t = await startTelemetry({ service: "test", env: {} });
    expect(t.enabled).toBe(false);
    await t.shutdown();
    expect(traceparentOf()).toBeUndefined();
    expect(contextFrom(undefined)).toBeDefined();
    const out = await inSpan(
      "x",
      { parent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
      () => 42,
    );
    expect(out).toBe(42);
    await expect(
      inSpan("boom", {}, () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    instruments.pingToFrame().record(1.5);
    instruments.ingestPings().add(3, { result: "accepted" });
  });
});
