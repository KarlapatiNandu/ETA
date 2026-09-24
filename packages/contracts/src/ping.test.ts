import { describe, expect, it } from "vitest";
import { PingBatch, batchCadence } from "./ping.ts";

const ping = { recorded_at: "2026-09-22T07:40:00+05:30", lat: 17.3924, lng: 78.3197 };
const batch = {
  device_uid: "phone-1",
  trip_id: "0b6c7b6e-7a6f-4b8e-9c1a-2f7d5e3a1b2c",
  cadence_s: 15,
  pings: [ping],
};

describe("PingBatch", () => {
  it("carries cadence_s through parsing", () => {
    expect(PingBatch.parse(batch).cadence_s).toBe(15);
  });

  it("falls back to 5 s when a tracker omits cadence_s (ARCH §5.7)", () => {
    const { cadence_s: _, ...noCadence } = batch;
    expect(batchCadence(PingBatch.parse(noCadence))).toBe(5);
    expect(batchCadence(PingBatch.parse(batch))).toBe(15);
  });

  it("rejects out-of-range coordinates", () => {
    expect(PingBatch.safeParse({ ...batch, pings: [{ ...ping, lat: 91 }] }).success).toBe(false);
  });

  it("rejects a timestamp without an offset — local time is never stored", () => {
    expect(
      PingBatch.safeParse({ ...batch, pings: [{ ...ping, recorded_at: "2026-09-22T07:40:00" }] })
        .success,
    ).toBe(false);
  });

  it("caps a batch at 500 pings (the reconnect flush size)", () => {
    expect(PingBatch.safeParse({ ...batch, pings: Array(501).fill(ping) }).success).toBe(false);
    expect(PingBatch.safeParse({ ...batch, pings: Array(500).fill(ping) }).success).toBe(true);
  });

  it("rejects an empty batch and a zero cadence", () => {
    expect(PingBatch.safeParse({ ...batch, pings: [] }).success).toBe(false);
    expect(PingBatch.safeParse({ ...batch, cadence_s: 0 }).success).toBe(false);
  });
});
