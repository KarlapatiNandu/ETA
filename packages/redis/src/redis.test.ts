import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  readFleet,
  readFleetEntry,
  setFleetState,
  writeFleetIfNewer,
  type FleetEntry,
} from "./fleet.ts";
import { keys, keyspace, STREAMS } from "./keys.ts";
import {
  ack,
  appendEntries,
  claimStale,
  ensureGroup,
  groupInfo,
  pendingCount,
  readGroup,
  streamLength,
} from "./streams.ts";
import { createTestRedis, redisAvailable, type TestRedis } from "./testing.ts";

describe("key registry (invariant 15)", () => {
  it("prefixes every key with the namespace, and production has none", () => {
    const k = keyspace("t:");
    expect(k.fleetLive).toBe("t:fleet:live");
    expect(k.tripGeo("x")).toBe("t:trip:x:geo");
    expect(k.sseConnMatch("u")).toBe("t:sse:conn:u:*");
    expect(keys.streamPings).toBe("stream:pings");
    expect(keys.ingestRate("dev", 7)).toBe("ratelimit:ingest:dev:7");
  });

  it("no source file outside keys.ts builds a Redis key inline", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const prefixes =
      /["'`](fleet:live|bus:|trip:|route:|stream:(pings|events)|sse:conn|search:stops|ingest:nonce|ratelimit:)/;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (
          /\.(ts|tsx)$/.test(name) &&
          !/\.test\.tsx?$/.test(name) &&
          !p.endsWith("keys.ts")
        ) {
          readFileSync(p, "utf8")
            .split("\n")
            .forEach((line, i) => {
              const code = line.trim();
              if (code.startsWith("*") || code.startsWith("//") || code.startsWith("/*")) return;
              if (prefixes.test(line)) offenders.push(`${p.slice(root.length + 1)}:${i + 1}`);
            });
        }
      }
    };
    for (const top of ["apps", "packages"]) {
      for (const pkg of readdirSync(join(root, top))) {
        const src = join(root, top, pkg, "src");
        try {
          if (statSync(src).isDirectory()) walk(src);
        } catch {
          /* package without src */
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

const live = await redisAvailable();

describe.skipIf(!live)("fleet:live", () => {
  let t: TestRedis;
  beforeAll(async () => void (t = await createTestRedis()));
  afterAll(() => t.close());

  const entry = (ts: string, extra: Partial<FleetEntry> = {}): FleetEntry => ({
    lat: 17.4,
    lng: 78.5,
    spd: 30,
    hdg: 90,
    s: 1200,
    seq: 2,
    tripId: "trip-1",
    ts,
    state: "LIVE",
    cadence: 5,
    ...extra,
  });

  it("a backfilled (older) fix never overwrites a newer live entry (invariant 4)", async () => {
    expect(
      await writeFleetIfNewer(t.redis, t.keys, "bus-1", entry("2026-09-22T02:00:10.000Z")),
    ).toBe(true);
    expect(
      await writeFleetIfNewer(
        t.redis,
        t.keys,
        "bus-1",
        entry("2026-09-22T01:59:00.000Z", { s: 1 }),
      ),
    ).toBe(false);
    // replaying the same fix is also a no-op
    expect(
      await writeFleetIfNewer(t.redis, t.keys, "bus-1", entry("2026-09-22T02:00:10.000Z")),
    ).toBe(false);
    expect((await readFleetEntry(t.redis, t.keys, "bus-1"))!.s).toBe(1200);
    expect(
      await writeFleetIfNewer(
        t.redis,
        t.keys,
        "bus-1",
        entry("2026-09-22T02:00:15.000Z", { s: 1250 }),
      ),
    ).toBe(true);
    expect((await readFleetEntry(t.redis, t.keys, "bus-1"))!.s).toBe(1250);
  });

  it("marks a trip ENDED without moving the bus, and ignores a stale trip id", async () => {
    expect(await setFleetState(t.redis, t.keys, "bus-1", "other-trip", "ENDED")).toBe(false);
    expect(await setFleetState(t.redis, t.keys, "bus-1", "trip-1", "ENDED")).toBe(true);
    const e = (await readFleet(t.redis, t.keys))["bus-1"]!;
    expect(e.state).toBe("ENDED");
    expect(e.s).toBe(1250);
    expect(await setFleetState(t.redis, t.keys, "no-bus", "trip-1", "ENDED")).toBe(false);
    expect(await readFleetEntry(t.redis, t.keys, "no-bus")).toBeNull();
  });

  it("a trip that has ended stays ended, even when a late flush arrives", async () => {
    // the driver pressed END inside a dead zone; the buffered pings land afterwards and are
    // newer than the last fix we saw — they must not put the bus back on the map as LIVE
    await writeFleetIfNewer(t.redis, t.keys, "bus-3", entry("2026-09-22T02:00:00.000Z"));
    expect(await setFleetState(t.redis, t.keys, "bus-3", "trip-1", "ENDED")).toBe(true);
    expect(
      await writeFleetIfNewer(
        t.redis,
        t.keys,
        "bus-3",
        entry("2026-09-22T02:00:30.000Z", { s: 99 }),
      ),
    ).toBe(false);
    const after = (await readFleetEntry(t.redis, t.keys, "bus-3"))!;
    expect(after.state).toBe("ENDED");
    expect(after.s).toBe(1200);
    // the next trip on the same bus writes normally
    expect(
      await writeFleetIfNewer(
        t.redis,
        t.keys,
        "bus-3",
        entry("2026-09-22T02:05:00.000Z", { tripId: "trip-2", s: 10 }),
      ),
    ).toBe(true);
    expect((await readFleetEntry(t.redis, t.keys, "bus-3"))!.state).toBe("LIVE");
  });

  it("keeps a null offset null (off-route is never fabricated)", async () => {
    await writeFleetIfNewer(
      t.redis,
      t.keys,
      "bus-2",
      entry("2026-09-22T02:00:00.000Z", { s: null }),
    );
    expect((await readFleetEntry(t.redis, t.keys, "bus-2"))!.s).toBeNull();
  });
});

describe.skipIf(!live)("streams", () => {
  let t: TestRedis;
  beforeAll(async () => void (t = await createTestRedis()));
  afterAll(() => t.close());

  it("delivers each entry once per group, independently per group", async () => {
    const s = t.keys.streamPings;
    await ensureGroup(t.redis, s, STREAMS.GROUP_GEO);
    await ensureGroup(t.redis, s, STREAMS.GROUP_GEO); // idempotent
    await appendEntries(t.redis, s, [{ n: 1 }, { n: 2 }, { n: 3 }], 1000);
    await ensureGroup(t.redis, s, STREAMS.GROUP_PERSIST); // created later, still sees everything
    const geo = await readGroup<{ n: number }>(t.redis, {
      stream: s,
      group: STREAMS.GROUP_GEO,
      consumer: "g1",
      count: 10,
      blockMs: 10,
    });
    const per = await readGroup<{ n: number }>(t.redis, {
      stream: s,
      group: STREAMS.GROUP_PERSIST,
      consumer: "p1",
      count: 10,
      blockMs: 10,
    });
    expect(geo.map((e) => e.data.n)).toEqual([1, 2, 3]);
    expect(per.map((e) => e.data.n)).toEqual([1, 2, 3]);
    expect(await appendEntries(t.redis, s, [], 1000)).toEqual([]);
  });

  it("carries a traceparent beside the payload, per call or per entry (Stage 8)", async () => {
    const s = t.keys.streamEvents;
    await ensureGroup(t.redis, s, STREAMS.GROUP_ETA);
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await appendEntries(t.redis, s, [{ n: 1 }], 1000, tp);
    await appendEntries(t.redis, s, [{ n: 2 }, { n: 3 }], 1000, (_, i) => (i ? tp : undefined));
    const got = await readGroup<{ n: number }>(t.redis, {
      stream: s,
      group: STREAMS.GROUP_ETA,
      consumer: "e1",
      count: 10,
      blockMs: 10,
    });
    expect(got.map((e) => [e.data.n, e.tp ?? null])).toEqual([
      [1, tp],
      [2, null],
      [3, tp],
    ]);
  });

  it("reports each group's lag and pending count (Stage 8 consumer-lag alert)", async () => {
    const s = t.keys.streamNotify;
    expect(await groupInfo(t.redis, s)).toEqual([]); // no stream yet: no groups, no error
    await ensureGroup(t.redis, s, STREAMS.GROUP_NOTIFY);
    await appendEntries(t.redis, s, [{ n: 1 }, { n: 2 }, { n: 3 }], 1000);
    await readGroup(t.redis, {
      stream: s,
      group: STREAMS.GROUP_NOTIFY,
      consumer: "n1",
      count: 1,
      blockMs: 10,
    });
    expect(await groupInfo(t.redis, s)).toEqual([
      { stream: s, group: STREAMS.GROUP_NOTIFY, lag: 2, pending: 1, consumers: 1 },
    ]);
    expect(await streamLength(t.redis, s)).toBe(3);
  });

  it("a restarted consumer re-reads its own unacked entries first; ack clears them", async () => {
    const s = t.keys.streamPings;
    expect(await pendingCount(t.redis, s, STREAMS.GROUP_GEO)).toBe(3);
    const mine = await readGroup<{ n: number }>(t.redis, {
      stream: s,
      group: STREAMS.GROUP_GEO,
      consumer: "g1",
      count: 10,
      pending: true,
    });
    expect(mine.map((e) => e.data.n)).toEqual([1, 2, 3]);
    await ack(
      t.redis,
      s,
      STREAMS.GROUP_GEO,
      mine.map((e) => e.id),
    );
    expect(await pendingCount(t.redis, s, STREAMS.GROUP_GEO)).toBe(0);
    await ack(t.redis, s, STREAMS.GROUP_GEO, []);
  });

  it("another consumer claims a crashed consumer's stale entries", async () => {
    const s = t.keys.streamPings;
    const stale = await claimStale<{ n: number }>(t.redis, {
      stream: s,
      group: STREAMS.GROUP_PERSIST,
      consumer: "p2",
      minIdleMs: 0,
      count: 10,
    });
    expect(stale.map((e) => e.data.n)).toEqual([1, 2, 3]);
  });

  it("returns nothing when the block times out", async () => {
    const r = t.connect();
    const none = await readGroup(r, {
      stream: t.keys.streamPings,
      group: STREAMS.GROUP_GEO,
      consumer: "g1",
      count: 10,
      blockMs: 20,
    });
    expect(none).toEqual([]);
  });

  it("acknowledges malformed entries instead of crashing or leaving them pending", async () => {
    const s = t.keys.streamPings;
    await t.redis.xadd(s, "*", "other", "x");
    await t.redis.xadd(s, "*", "d", "{not json");
    const got = await readGroup(t.redis, {
      stream: s,
      group: STREAMS.GROUP_GEO,
      consumer: "g1",
      count: 10,
      blockMs: 10,
    });
    expect(got).toEqual([]);
    expect(await pendingCount(t.redis, s, STREAMS.GROUP_GEO)).toBe(0);
  });
});
