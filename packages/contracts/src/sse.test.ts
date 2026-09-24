import { describe, expect, it } from "vitest";
import { SseEvent, isBroadcast } from "./sse.ts";

const id = "0b6c7b6e-7a6f-4b8e-9c1a-2f7d5e3a1b2c";

describe("SseEvent", () => {
  it("parses a bus.status frame with its cadence", () => {
    const e = SseEvent.parse({
      type: "bus.status",
      data: { id, state: "DEGRADED", cadence: 15, lastSeenAt: "2026-09-22T02:10:00Z" },
    });
    expect(e.type).toBe("bus.status");
  });

  it("rejects an unknown presence state", () => {
    expect(
      SseEvent.safeParse({
        type: "bus.status",
        data: { id, state: "STALE", cadence: 5, lastSeenAt: "2026-09-22T02:10:00Z" },
      }).success,
    ).toBe(false);
  });

  it("marks only broadcast-class events as replayable (invariant 9)", () => {
    expect(isBroadcast("bus.position")).toBe(true);
    expect(isBroadcast("bus.status")).toBe(true);
    expect(isBroadcast("stop.reached")).toBe(true);
    expect(isBroadcast("eta.update")).toBe(false);
    expect(isBroadcast("notification")).toBe(false);
    expect(isBroadcast("fleet.snapshot")).toBe(false);
    expect(isBroadcast("ticket.update")).toBe(false);
  });
});
