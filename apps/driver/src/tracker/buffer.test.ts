import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import type { Ping } from "@busmitra/contracts";
import { openDb } from "../lib/idb.ts";
import { idbPingBuffer, memoryPingBuffer, type PingBuffer } from "./buffer.ts";

const ping = (i: number): Ping => ({
  recorded_at: new Date(1_758_506_400_000 + i * 5000).toISOString(),
  lat: 17.4,
  lng: 78.5,
});

let dbn = 0;
const impls: [string, () => Promise<PingBuffer>, (cap: number) => Promise<PingBuffer>][] = [
  [
    "IndexedDB",
    async () => idbPingBuffer(await openDb(indexedDB, `t${++dbn}`)),
    async (c) => idbPingBuffer(await openDb(indexedDB, `t${++dbn}`), c),
  ],
  ["memory", async () => memoryPingBuffer(), async (c) => memoryPingBuffer(c)],
];

describe.each(impls)("%s ping buffer", (_name, make, makeCapped) => {
  it("returns a trip's pings oldest first, and removes exactly what was sent", async () => {
    const b = await make();
    for (let i = 0; i < 5; i++) await b.push("trip-a", ping(i));
    await b.push("trip-b", ping(99));
    const first = await b.peek("trip-a", 3);
    expect(first.pings.map((p) => p.recorded_at)).toEqual(
      [0, 1, 2].map((i) => ping(i).recorded_at),
    );
    await b.remove(first.keys);
    expect(await b.count("trip-a")).toBe(2);
    expect(await b.count()).toBe(3);
    expect((await b.peek("trip-a", 10)).pings[0]!.recorded_at).toBe(ping(3).recorded_at);
    await b.remove([]);
  });

  it("is a ring: past capacity the oldest pings are evicted, never the newest", async () => {
    const b = await makeCapped(4);
    for (let i = 0; i < 6; i++) await b.push("t", ping(i));
    expect(await b.count()).toBe(4);
    expect((await b.peek("t", 10)).pings.map((p) => p.recorded_at)).toEqual(
      [2, 3, 4, 5].map((i) => ping(i).recorded_at),
    );
  });
});

describe("persistence", () => {
  it("survives closing and reopening the database (an app reload mid-dead-zone)", async () => {
    const db1 = await openDb(indexedDB, "persist");
    await idbPingBuffer(db1).push("trip", ping(1));
    db1.close();
    const db2 = await openDb(indexedDB, "persist");
    expect(await idbPingBuffer(db2).count("trip")).toBe(1);
  });
});
