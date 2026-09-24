import { describe, expect, it } from "vitest";
import {
  decide,
  dedupeKey,
  endOfServiceDay,
  quietUntil,
  serviceDate,
  type AlertPrefs,
} from "./tiers.ts";

// 2026-09-24 07:40 IST
const T = Date.parse("2026-09-24T02:10:00Z");
const base: AlertPrefs = {
  alerts_paused_until: null,
  max_tier: 3,
  critical_breakthrough: true,
  quiet_start_min: null,
  quiet_duration_min: null,
};

describe("decide — ARCHITECTURE §6.3 per-user filters, in order", () => {
  it("delivers T0–T3 by default and keeps T4 in-app", () => {
    for (const t of [0, 1, 2, 3] as const) expect(decide(t, base, T)).toEqual({ kind: "now" });
    expect(decide(4, base, T)).toEqual({ kind: "suppress", reason: "tier_4" });
  });

  it("kill switch: suppresses everything but T0, which breaks through unless turned off", () => {
    const paused = { ...base, alerts_paused_until: new Date(T + 3600_000) };
    expect(decide(3, paused, T)).toEqual({ kind: "suppress", reason: "paused" });
    expect(decide(1, paused, T)).toEqual({ kind: "suppress", reason: "paused" });
    expect(decide(0, paused, T)).toEqual({ kind: "now" });
    expect(decide(0, { ...paused, critical_breakthrough: false }, T)).toEqual({
      kind: "suppress",
      reason: "paused",
    });
    // an expired pause is no pause
    expect(decide(3, { ...base, alerts_paused_until: new Date(T - 1) }, T)).toEqual({
      kind: "now",
    });
  });

  it("'Not today' mutes that bus; max_tier = 2 suppresses T3 (max, not min — SCHEMA §1)", () => {
    expect(decide(1, { ...base, bus_muted_until: new Date(T + 1000) }, T)).toEqual({
      kind: "suppress",
      reason: "muted",
    });
    expect(decide(3, { ...base, max_tier: 2 }, T)).toEqual({
      kind: "suppress",
      reason: "above_max_tier",
    });
    expect(decide(2, { ...base, max_tier: 2 }, T)).toEqual({ kind: "now" });
  });

  it("quiet hours defer non-T0 to the end of the window, across midnight", () => {
    // 22:00 for 8 h → 06:00; at 23:30 IST
    const night = { ...base, quiet_start_min: 22 * 60, quiet_duration_min: 480 };
    const at2330 = Date.parse("2026-09-24T18:00:00Z");
    expect(decide(2, night, at2330)).toEqual({
      kind: "defer",
      until: new Date("2026-09-25T00:30:00Z"),
    });
    expect(decide(0, night, at2330)).toEqual({ kind: "now" });
    // 05:59 IST still inside, 06:00 outside
    expect(quietUntil(night, Date.parse("2026-09-25T00:29:00Z"))).toEqual(
      new Date("2026-09-25T00:30:00Z"),
    );
    expect(quietUntil(night, Date.parse("2026-09-25T00:30:00Z"))).toBeNull();
    expect(quietUntil(night, T)).toBeNull(); // 07:40 IST
  });
});

describe("dedupe and the operating day", () => {
  it("is stable for the same event and user, different otherwise", () => {
    const k = {
      userId: "u",
      eventType: "stop_reached",
      busId: "b",
      stopId: "s",
      serviceDate: "2026-09-24",
      content: "trip:3",
    };
    expect(dedupeKey(k)).toBe(dedupeKey({ ...k }));
    expect(dedupeKey(k)).not.toBe(dedupeKey({ ...k, userId: "v" }));
    expect(dedupeKey(k)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the IST day, and 'not today' ends at 23:59:59 IST", () => {
    expect(serviceDate(Date.parse("2026-09-24T19:00:00Z"))).toBe("2026-09-25"); // 00:30 IST
    expect(endOfServiceDay(T).toISOString()).toBe("2026-09-24T18:29:59.000Z");
  });
});
