import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TrackerMe } from "@busmitra/contracts";
import { NetworkError, type SignedClient } from "../lib/api.ts";
import { kvGet, openDb } from "../lib/idb.ts";
import { memoryPingBuffer } from "../tracker/buffer.ts";
import type { Fix } from "../tracker/sampler.ts";
import { WakeLockKeeper } from "../tracker/wakelock.ts";
import { TripSession, type ActiveTrip } from "./session.ts";

const T0 = 1_758_506_400_000;

function world(dbName: string) {
  let online = true;
  const calls: string[] = [];
  let onFix: ((f: Fix) => void) | null = null;
  const client: SignedClient = {
    async request<T>(method: string, path: string, body?: unknown) {
      if (!online) throw new NetworkError(new Error("offline"));
      calls.push(`${method} ${path}`);
      if (path === "/v1/tracker/trips")
        return {
          status: 200,
          json: {
            trip_id: "trip-1",
            route_id: "r1",
            resumed: false,
            started_at: new Date(T0).toISOString(),
          } as T,
        };
      if (path === "/v1/ingest")
        return {
          status: 200,
          json: { accepted: (body as { pings: unknown[] }).pings.length, rejected: [] } as T,
        };
      return { status: 200, json: {} as T };
    },
    probe: async () => online,
  };
  return {
    calls,
    setOnline: (v: boolean) => void (online = v),
    feed: (sec: number) =>
      onFix?.({
        timestamp: T0 + sec * 1000,
        lat: 17.4 + sec * 1e-4,
        lng: 78.5,
        accuracy: 5,
        speed: 8,
        heading: 0,
      }),
    async make() {
      const db = await openDb(indexedDB, dbName);
      const buffer = memoryPingBuffer();
      const s = new TripSession({
        db,
        buffer,
        client,
        deviceUid: "d",
        wake: new WakeLockKeeper({ visible: () => true, onVisibilityChange: () => () => {} }),
        watchGps: (f) => {
          onFix = f;
          return () => void (onFix = null);
        },
        isOnline: () => online,
        onUpdate: () => {},
      });
      return { s, db, buffer };
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("TripSession", () => {
  it("START persists the trip; fixes land in the buffer before any network attempt", async () => {
    const w = world("sess-a");
    const { s, db, buffer } = await w.make();
    await s.start({ id: "r1", name: "Route 1" });
    expect((await kvGet<ActiveTrip>(db, "trip"))!.tripId).toBe("trip-1");
    w.setOnline(false);
    for (let t = 0; t <= 20; t += 1) w.feed(t);
    await new Promise((r) => setTimeout(r, 0));
    expect(await buffer.count("trip-1")).toBe(5);
  });

  it("END inside a dead zone waits for the buffer to drain, then closes the trip", async () => {
    const w = world("sess-b");
    const { s, db, buffer } = await w.make();
    await s.start({ id: "r1", name: "Route 1" });
    w.setOnline(false);
    for (let t = 0; t <= 10; t++) w.feed(t);
    await new Promise((r) => setTimeout(r, 0));
    await s.end();
    expect(s.trip?.ending).toBe(true);
    expect(w.calls.some((c) => c.endsWith("/end"))).toBe(false);
    w.setOnline(true);
    s.reconnected();
    await new Promise((r) => setTimeout(r, 10));
    // the drain timer would do this every 5 s; drive it directly
    await (s as unknown as { maybeFinishEnding(): Promise<void> }).maybeFinishEnding();
    expect(await buffer.count("trip-1")).toBe(0);
    const order = w.calls.filter((c) => c.includes("ingest") || c.endsWith("/end"));
    expect(order.at(-1)).toBe("POST /v1/tracker/trips/trip-1/end");
    expect(order.indexOf("POST /v1/ingest")).toBeLessThan(order.length - 1);
    expect(s.trip).toBeNull();
    expect(await kvGet(db, "trip")).toBeUndefined();
  });

  it("resumes a trip after a reload when the server still has it open, and forgets it otherwise", async () => {
    const w = world("sess-c");
    const first = await w.make();
    await first.s.start({ id: "r1", name: "Route 1" });
    const me = (live: boolean): TrackerMe => ({
      device_uid: "d",
      bus: { id: "b", bus_number: "1" },
      routes: [],
      live_trip: live
        ? { id: "trip-1", route_id: "r1", started_at: new Date(T0).toISOString() }
        : null,
      server_time: new Date(T0).toISOString(),
    });
    const second = await w.make();
    await second.s.restore(me(true));
    expect(second.s.trip?.tripId).toBe("trip-1");
    const third = await w.make();
    await third.s.restore(me(false));
    expect(third.s.trip).toBeNull();
    expect(await kvGet(third.db, "trip")).toBeUndefined();
  });
});
