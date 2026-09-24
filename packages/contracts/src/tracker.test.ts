import { describe, expect, it } from "vitest";
import { CADENCE, initialCadence, nextCadence, pingDue } from "./tracker.ts";

describe("tracker cadence", () => {
  it("stays at 5 s while moving and through a short stop at a signal", () => {
    let s = initialCadence();
    s = nextCadence(s, 8, 0);
    s = nextCadence(s, 0, 1000);
    s = nextCadence(s, 0, 25_000);
    expect(s.cadenceS).toBe(CADENCE.MOVING_S);
  });

  it("drops to 15 s after 30 s standing still, and back to 5 s the moment it moves", () => {
    let s = initialCadence();
    s = nextCadence(s, 0, 0);
    s = nextCadence(s, 0.5, 30_000);
    expect(s.cadenceS).toBe(CADENCE.STATIONARY_S);
    s = nextCadence(s, 3, 31_000);
    expect(s).toEqual({ cadenceS: CADENCE.MOVING_S, stillSince: null });
  });

  it("treats an unknown speed as moving", () => {
    expect(nextCadence({ cadenceS: 15, stillSince: 0 }, null, 60_000).cadenceS).toBe(5);
  });

  it("says when the next fix is due, with slack for callback jitter", () => {
    expect(pingDue(null, 0, 5)).toBe(true);
    expect(pingDue(0, 4_800, 5)).toBe(true);
    expect(pingDue(0, 4_700, 5)).toBe(false);
    expect(pingDue(0, 14_000, 15)).toBe(false);
  });

  it("keeps the promise the last ping made when slowing down, and speeds up at once", () => {
    // the last ping went out at 5 s; the tracker has just slowed to 15 s: the next is still
    // owed at 5 s, or a parked bus reads as three missed pings (ARCH §5.7)
    expect(pingDue(0, 5_000, 15, 5)).toBe(true);
    // the last ping went out at 15 s and the bus is moving again: do not wait 15 s
    expect(pingDue(0, 5_000, 5, 15)).toBe(true);
    expect(pingDue(0, 5_000, 15, 15)).toBe(false);
  });
});
