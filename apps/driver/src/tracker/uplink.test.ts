import { describe, expect, it } from "vitest";
import type { Ping } from "@busmitra/contracts";
import { NetworkError, type ApiResponse, type SignedClient } from "../lib/api.ts";
import { memoryPingBuffer } from "./buffer.ts";
import { Uplink, UPLINK } from "./uplink.ts";

const ping = (i: number): Ping => ({
  recorded_at: new Date(1_758_506_400_000 + i * 5000).toISOString(),
  lat: 17.4,
  lng: 78.5,
});

/** A scripted gateway: answers from a queue (or a function), and records every batch. */
function fakeGateway(answer: (body: { pings: Ping[] }) => ApiResponse<unknown> | "network") {
  const batches: Ping[][] = [];
  let probes = 0;
  let probeOk = true;
  const client: SignedClient = {
    async request<T>(_m: string, _p: string, body?: unknown) {
      const b = body as { pings: Ping[] };
      const a = answer(b);
      if (a === "network") throw new NetworkError(new TypeError("Failed to fetch"));
      batches.push(b.pings);
      return a as ApiResponse<T>;
    },
    async probe() {
      probes++;
      return probeOk;
    },
  };
  return { client, batches, probes: () => probes, setProbe: (ok: boolean) => void (probeOk = ok) };
}

const ok = (b: { pings: Ping[] }): ApiResponse<unknown> => ({
  status: 200,
  json: { accepted: b.pings.length, rejected: [] },
});

async function setup(
  answer: Parameters<typeof fakeGateway>[0],
  n: number,
  extra: { online?: () => boolean } = {},
) {
  const buffer = memoryPingBuffer();
  for (let i = 0; i < n; i++) await buffer.push("trip", ping(i));
  let clock = 1_000_000;
  const gw = fakeGateway(answer);
  const up = new Uplink({
    buffer,
    client: gw.client,
    deviceUid: "d",
    tripId: () => "trip",
    cadenceS: () => 5,
    isOnline: extra.online,
    now: () => clock,
    random: () => 1,
  });
  return { up, buffer, gw, advance: (ms: number) => void (clock += ms) };
}

describe("Uplink", () => {
  it("sends and removes, and counts what the gateway accepted", async () => {
    const { up, buffer, gw } = await setup(ok, 3);
    await up.tick();
    expect(gw.batches).toHaveLength(1);
    expect(await buffer.count()).toBe(0);
    expect(up.stats).toMatchObject({ sent: 3, buffered: 0, lastError: null });
  });

  it("flushes a reconnect backlog in ≤500-ping requests, oldest first, back to back", async () => {
    const { up, gw } = await setup(ok, 1200);
    await up.tick();
    expect(gw.batches.map((b) => b.length)).toEqual([500, 500, 200]);
    expect(gw.batches[0]![0]!.recorded_at).toBe(ping(0).recorded_at);
    expect(gw.batches[2]!.at(-1)!.recorded_at).toBe(ping(1199).recorded_at);
  });

  it("keeps everything on a network failure, backs off, and probes before trying again", async () => {
    let down = true;
    const { up, buffer, gw, advance } = await setup((b) => (down ? "network" : ok(b)), 4);
    await up.tick();
    expect(await buffer.count()).toBe(4);
    expect(up.stats.lastError).toMatch(/buffer/);
    await up.tick(); // still inside the backoff window: no attempt
    expect(gw.probes()).toBe(0);
    down = false;
    gw.setProbe(false);
    advance(UPLINK.BASE_BACKOFF_MS * 2 + 1);
    await up.tick(); // probe fails: still not sent
    expect(gw.probes()).toBe(1);
    expect(await buffer.count()).toBe(4);
    gw.setProbe(true);
    up.reconnected(); // the 'online' event skips the backoff
    await new Promise((r) => setTimeout(r, 0));
    await up.tick();
    expect(await buffer.count()).toBe(0);
  });

  it("does nothing while the browser reports offline", async () => {
    const { up, gw } = await setup(ok, 2, { online: () => false });
    await up.tick();
    expect(gw.batches).toHaveLength(0);
    expect(up.stats.online).toBe(false);
  });

  it("backs off exponentially (with jitter) on 503 and 429, capped", async () => {
    const { up, gw, advance } = await setup(() => ({ status: 503, json: {} }), 1);
    for (let i = 0; i < 12; i++) {
      await up.tick();
      advance(UPLINK.MAX_BACKOFF_MS + 1);
    }
    expect(gw.batches.length).toBe(12);
    expect(up.stats.lastError).toMatch(/503/);
    const r = await setup(() => ({ status: 429, json: {} }), 1);
    await r.up.tick();
    expect(r.up.stats.lastError).toMatch(/slowing/);
  });

  it("treats a 409 replay as delivered and drops a 400 batch that can never succeed", async () => {
    const replay = await setup(() => ({ status: 409, json: { error: "replay" } }), 2);
    await replay.up.tick();
    expect(await replay.buffer.count()).toBe(0);
    const bad = await setup(() => ({ status: 400, json: { message: "pings: too big" } }), 2);
    await bad.up.tick();
    expect(await bad.buffer.count()).toBe(0);
    expect(bad.up.stats.lastError).toMatch(/too big/);
  });

  it("keeps the pings on a 401 and tells the driver why (clock, pairing)", async () => {
    const clock = await setup(() => ({ status: 401, json: { error: "stale_timestamp" } }), 2);
    await clock.up.tick();
    expect(await clock.buffer.count()).toBe(2);
    expect(clock.up.stats.lastError).toMatch(/clock/);
    const pair = await setup(() => ({ status: 401, json: { error: "bad_signature" } }), 1);
    await pair.up.tick();
    expect(pair.up.stats.lastError).toMatch(/paired/);
  });

  it("stops when the server says the trip is closed", async () => {
    const { up, buffer } = await setup(
      () => ({ status: 409, json: { error: "trip_not_live" } }),
      3,
    );
    await up.tick();
    expect(up.stats.tripClosed).toBe(true);
    expect(await buffer.count()).toBe(0);
    up.reset();
    expect(up.stats.tripClosed).toBe(false);
  });

  it("reports pings the gateway refused individually", async () => {
    const { up } = await setup(
      (b) => ({
        status: 200,
        json: {
          accepted: b.pings.length - 1,
          rejected: [{ index: 0, reason: "future_timestamp" }],
        },
      }),
      2,
    );
    await up.tick();
    expect(up.stats.lastError).toMatch(/future_timestamp/);
    expect(up.stats.sent).toBe(1);
  });

  it("start/stop manage the 5 s timer", () => {
    const u = new Uplink({
      buffer: memoryPingBuffer(),
      client: fakeGateway(ok).client,
      deviceUid: "d",
      tripId: () => null,
      cadenceS: () => 5,
    });
    u.start();
    u.start();
    u.stop();
    u.stop();
  });
});
