import { describe, expect, it } from "vitest";
import type { FleetEntry } from "@busmitra/redis";
import { summariseFleet } from "./health.ts";

const NOW = Date.parse("2026-10-06T02:30:00Z");
const at = (agoS: number, state: FleetEntry["state"], flag: string | null = null): FleetEntry => ({
  lat: 17.4,
  lng: 78.5,
  spd: 0,
  hdg: 0,
  s: 100,
  seq: 1,
  tripId: "t",
  ts: new Date(NOW - agoS * 1000).toISOString(),
  state,
  cadence: 5,
  flag,
});

describe("summariseFleet (Stage 8 'any bus DARK > 15 min' alert)", () => {
  it("counts states and flags only buses silent 15+ minutes on an open trip", () => {
    const h = summariseFleet(
      {
        a: at(3, "LIVE"),
        b: at(20, "DEGRADED"),
        c: at(300, "DARK"),
        d: at(16 * 60, "DARK"),
        e: at(40 * 60, "ENDED", "dark_timeout"), // off the map, trip still open: still silent
        f: at(40 * 60, "ENDED", "trip_end"), // the driver ended it: not an alarm
      },
      NOW,
    );
    expect(h.byState).toEqual({ LIVE: 1, DEGRADED: 1, DARK: 2, ENDED: 2 });
    expect(h.darkTooLong).toEqual([
      { busId: "d", darkForS: 960 },
      { busId: "e", darkForS: 2400 },
    ]);
  });
});
