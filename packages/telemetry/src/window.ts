/**
 * A time-bounded sample window with percentiles — the in-process half of the Stage 8
 * dashboards. The admin console's observability page reads it directly, so the TD sees the
 * live-latency number without a Grafana account; OTel exports the same samples as a histogram.
 *
 * Bounded twice: by age (`windowMs`) and by count (`maxSamples`, oldest dropped first), so a
 * burst cannot grow it without limit. Samples arrive in time order; `now` is explicit.
 */
export class RollingWindow {
  private readonly at: number[] = [];
  private readonly values: number[] = [];
  private head = 0;

  private readonly windowMs: number;
  private readonly maxSamples: number;

  constructor(windowMs: number, maxSamples = 50_000) {
    this.windowMs = windowMs;
    this.maxSamples = maxSamples;
  }

  add(value: number, now: number): void {
    this.at.push(now);
    this.values.push(value);
    if (this.at.length - this.head > this.maxSamples) this.head++;
    this.compact(now);
  }

  private compact(now: number): void {
    while (this.head < this.at.length && this.at[this.head]! < now - this.windowMs) this.head++;
    // reclaim memory once the dead prefix is large
    if (this.head > 4096 && this.head * 2 > this.at.length) {
      this.at.splice(0, this.head);
      this.values.splice(0, this.head);
      this.head = 0;
    }
  }

  snapshot(now: number): { n: number; p50: number | null; p95: number | null; max: number | null } {
    this.compact(now);
    const live = this.values.slice(this.head).sort((a, b) => a - b);
    const n = live.length;
    const q = (p: number) => (n ? live[Math.min(n - 1, Math.ceil(p * n) - 1)]! : null);
    return { n, p50: q(0.5), p95: q(0.95), max: n ? live[n - 1]! : null };
  }
}
