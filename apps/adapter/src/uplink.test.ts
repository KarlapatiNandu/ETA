import { describe, expect, it } from "vitest";
import type { Fix } from "./gt06.ts";
import { DeviceUplink, UPLINK } from "./uplink.ts";

const fix = (over: Partial<Fix> = {}): Fix => ({
  recordedAt: "2026-10-06T02:30:00.000Z",
  lat: 17.37,
  lng: 78.52,
  speedKmh: 20,
  headingDeg: 90,
  positioned: true,
  satellites: 9,
  acc: true,
  reupload: false,
  ...over,
});
const cfg = { secret: "s".repeat(32), movingIntervalS: 10, idleIntervalS: 60 };

describe("DeviceUplink (no gateway needed)", () => {
  it("never turns a report without a satellite fix into a position (invariant 2)", () => {
    const u = new DeviceUplink("868120301234567", cfg, "http://gw");
    u.onFix(fix({ positioned: false }));
    expect(u.pending).toBe(0);
    u.onFix(fix());
    expect(u.pending).toBe(1);
  });

  it("advertises the idle cadence with the ignition off, the moving one otherwise", () => {
    const u = new DeviceUplink("868120301234567", cfg, "http://gw");
    expect(u.cadenceS).toBe(10); // unknown ignition: assume moving (the stricter presence)
    u.onAcc(false);
    expect(u.cadenceS).toBe(60);
    u.onFix(fix({ acc: true }));
    expect(u.cadenceS).toBe(10);
  });

  it("keeps at most a day of fixes, dropping the oldest", () => {
    const u = new DeviceUplink("868120301234567", cfg, "http://gw");
    for (let i = 0; i < UPLINK.MAX_BUFFER + 5; i++) u.onFix(fix());
    expect(u.pending).toBe(UPLINK.MAX_BUFFER);
  });

  it("backs off and keeps the fixes when the gateway is down (503)", async () => {
    let calls = 0;
    const u = new DeviceUplink("868120301234567", cfg, "http://gw", {
      fetch: (async () => {
        calls++;
        return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
      }) as typeof fetch,
    });
    u.onFix(fix());
    await u.tick();
    await u.tick(); // inside the back-off window: no second call
    expect(calls).toBe(1);
    expect(u.pending).toBe(1);
  });
});
