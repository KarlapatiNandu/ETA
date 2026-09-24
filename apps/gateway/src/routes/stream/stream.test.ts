import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SseEvent, type BroadcastEvent } from "@busmitra/contracts";
import { seedStudent } from "@busmitra/db/testing";
import { publishEvents, writeFleetIfNewer, type FleetEntry } from "@busmitra/redis";
import { createTestRedis, redisAvailable, type TestRedis } from "@busmitra/redis/testing";
import { createTestGateway } from "../../testing.ts";

/**
 * GET /v1/stream + POST /v1/stream/focus over a real socket (inject() cannot hold a stream).
 * BUILD_PLAN Stage 3 exits covered here: SIGKILL does not lock anyone out (phantom keys are
 * reclaimed or expire), and a dropped stream resumes by Last-Event-ID with only broadcast frames.
 */

const live = await redisAvailable();

interface Frame {
  id?: string;
  event: SseEvent;
}

/** A minimal SSE reader over fetch — the same shape the web client uses. */
function openStream(url: string, token: string | null, lastEventId?: string) {
  const ctrl = new AbortController();
  const frames: Frame[] = [];
  const comments: string[] = [];
  let resolveStatus!: (n: number) => void;
  const status = new Promise<number>((r) => (resolveStatus = r));
  const done = (async () => {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(lastEventId ? { "last-event-id": lastEventId } : {}),
      },
    });
    resolveStatus(res.status);
    if (res.status !== 200 || !res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let id: string | undefined;
        let data = "";
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) comments.push(line.slice(1).trim());
          else if (line.startsWith("id: ")) id = line.slice(4);
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (data) frames.push({ id, event: SseEvent.parse(JSON.parse(data)) });
      }
    }
  })().catch(() => undefined);
  const waitFor = async (pred: (f: Frame[]) => boolean, ms = 4000) => {
    const until = Date.now() + ms;
    while (!pred(frames)) {
      if (Date.now() > until)
        throw new Error(`timed out; frames: ${frames.map((f) => f.event.type).join(",")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { frames, comments, status, done, waitFor, close: () => ctrl.abort() };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)("SSE stream (Stage 3)", () => {
  let t: TestRedis;
  let gw: Awaited<ReturnType<typeof createTestGateway>>;
  let base: string;
  let userA: string;
  let userB: string;
  let tokenA: string;
  let tokenB: string;
  const busIn = "11111111-1111-4111-8111-111111111111";
  const busOut = "22222222-2222-4222-8222-222222222222";
  const trip = "33333333-3333-4333-8333-333333333333";

  const entry = (lat: number, lng: number, extra: Partial<FleetEntry> = {}): FleetEntry => ({
    lat,
    lng,
    spd: 20,
    hdg: 90,
    s: 100,
    seq: 0,
    tripId: trip,
    ts: new Date().toISOString(),
    state: "LIVE",
    cadence: 5,
    ...extra,
  });
  const position = (id: string, lat: number, lng: number): BroadcastEvent => ({
    type: "bus.position",
    data: { id, lat, lng, spd: 20, hdg: 90, s: 100, ts: new Date().toISOString() },
  });

  beforeAll(async () => {
    t = await createTestRedis();
    gw = await createTestGateway({
      redis: t,
      instanceId: "gw-test-1",
      sse: { heartbeatS: 1, connTtlS: 3 },
    });
    base = await gw.app.listen({ port: 0, host: "127.0.0.1" });
    userA = (await seedStudent(gw.db, { rollNo: "160125737101" })).userId!;
    userB = (await seedStudent(gw.db, { rollNo: "160125737102", phone: "+919999900002" })).userId!;
    tokenA = await gw.tokenFor(userA);
    tokenB = await gw.tokenFor(userB);
    await writeFleetIfNewer(t.redis, t.keys, busIn, entry(17.3688, 78.53));
    await writeFleetIfNewer(t.redis, t.keys, busOut, entry(17.45, 78.6));
    await writeFleetIfNewer(
      t.redis,
      t.keys,
      "44444444-4444-4444-8444-444444444444",
      entry(17.4, 78.5, { state: "ENDED", flag: "trip_end" }),
    );
  });
  afterAll(async () => {
    await gw.app.close();
    await gw.db.close();
    await t.close();
  });

  it("refuses an unauthenticated stream", async () => {
    const s = openStream(`${base}/v1/stream`, null);
    expect(await s.status).toBe(401);
  });

  it("opens with stream.ready and a snapshot of live buses — never an ENDED one", async () => {
    const s = openStream(`${base}/v1/stream`, tokenA);
    expect(await s.status).toBe(200);
    await s.waitFor((f) => f.length >= 2);
    expect(s.frames[0]!.event.type).toBe("stream.ready");
    expect(s.frames[0]!.id).toBeUndefined(); // per-user: no resumable id (invariant 9)
    const snap = s.frames[1]!;
    expect(snap.id).toBeUndefined();
    expect(snap.event.type).toBe("fleet.snapshot");
    if (snap.event.type === "fleet.snapshot") {
      expect(snap.event.data.buses.map((b) => b.id).sort()).toEqual([busIn, busOut].sort());
      expect(snap.event.data.serverTime).toBeTruthy();
    }
    s.close();
  });

  it("delivers broadcast events live, each with its stream id", async () => {
    const s = openStream(`${base}/v1/stream`, tokenA);
    await s.waitFor((f) => f.some((x) => x.event.type === "fleet.snapshot"));
    const [id] = await publishEvents(t.redis, t.keys, [position(busIn, 17.3689, 78.531)]);
    await s.waitFor((f) => f.some((x) => x.id === id));
    expect(s.frames.find((x) => x.id === id)!.event.type).toBe("bus.position");
    s.close();
  });

  it("caps a user at three streams, and a closed stream frees its slot at once", async () => {
    const opened = [0, 1, 2].map(() => openStream(`${base}/v1/stream`, tokenB));
    for (const o of opened) expect(await o.status).toBe(200);
    for (const o of opened) await o.waitFor((f) => f.length >= 2);
    const fourth = openStream(`${base}/v1/stream`, tokenB);
    expect(await fourth.status).toBe(429);
    opened[0]!.close();
    await sleep(150);
    const again = openStream(`${base}/v1/stream`, tokenB);
    expect(await again.status).toBe(200);
    again.close();
    opened[1]!.close();
    opened[2]!.close();
    await sleep(150);
  });

  it("refreshes the connection key on every heartbeat while the stream is open", async () => {
    const s = openStream(`${base}/v1/stream`, tokenA);
    await s.waitFor((f) => f.length >= 2);
    const connId = s.frames[0]!.event.type === "stream.ready" ? s.frames[0]!.event.data.connId : "";
    await sleep(4000); // longer than the 3 s TTL: only the heartbeat keeps it alive
    expect(await t.redis.exists(t.keys.sseConn(userA, connId))).toBe(1);
    expect(s.comments.filter((c) => c === "hb").length).toBeGreaterThanOrEqual(3);
    s.close();
    await sleep(150);
    expect(await t.redis.exists(t.keys.sseConn(userA, connId))).toBe(0);
  });

  it("after a SIGKILL, phantom keys expire on their own — nobody is locked out", async () => {
    // what a killed gateway leaves: three live-looking keys it will never refresh or delete
    for (const c of ["p1", "p2", "p3"])
      await t.redis.set(
        t.keys.sseConn(userB, c),
        JSON.stringify({ inst: "gw-dead", focus: null }),
        "EX",
        2,
      );
    expect(await openStream(`${base}/v1/stream`, tokenB).status).toBe(429);
    await sleep(2200);
    const s = openStream(`${base}/v1/stream`, tokenB);
    expect(await s.status).toBe(200);
    s.close();
    await sleep(150);
  });

  it("and a gateway restarted under the same instance id reclaims its own phantoms at boot", async () => {
    for (const c of ["q1", "q2", "q3"])
      await t.redis.set(
        t.keys.sseConn(userB, c),
        JSON.stringify({ inst: "gw-test-2", focus: null }),
        "EX",
        45,
      );
    const restarted = await createTestGateway({ redis: t, instanceId: "gw-test-2", db: gw.db });
    const url = await restarted.app.listen({ port: 0, host: "127.0.0.1" });
    const s = openStream(`${url}/v1/stream`, tokenB);
    expect(await s.status).toBe(200);
    s.close();
    await sleep(150);
    await restarted.app.close();
  });

  it("resumes by Last-Event-ID: missed broadcast frames replay in order, nothing per-user", async () => {
    const s = openStream(`${base}/v1/stream`, tokenA);
    await s.waitFor((f) => f.some((x) => x.event.type === "fleet.snapshot"));
    const [seen] = await publishEvents(t.redis, t.keys, [position(busIn, 17.369, 78.532)]);
    await s.waitFor((f) => f.some((x) => x.id === seen));
    s.close(); // the tunnel
    await sleep(100);

    const missed = await publishEvents(t.redis, t.keys, [
      position(busIn, 17.3691, 78.533),
      {
        type: "stop.reached",
        data: {
          tripId: trip,
          busId: busIn,
          stopId: busOut,
          seq: 2,
          event: "arrived",
          at: new Date().toISOString(),
        },
      },
      {
        type: "bus.status",
        data: { id: busOut, state: "DEGRADED", cadence: 5, lastSeenAt: new Date().toISOString() },
      },
    ]);
    // a per-user frame that should never be in this stream — if it is, it must not be replayed
    await t.redis.xadd(
      t.keys.streamEvents,
      "*",
      "d",
      JSON.stringify({
        type: "eta.update",
        data: { tripId: trip, stopId: busOut, p50: 60, p90: 90 },
      }),
    );

    const r = openStream(`${base}/v1/stream`, tokenA, seen);
    await r.waitFor((f) => f.some((x) => x.event.type === "fleet.snapshot"));
    const replayed = r.frames.filter((x) => x.id);
    expect(replayed.map((x) => x.id)).toEqual(missed);
    expect(r.frames.some((x) => x.event.type === "eta.update")).toBe(false);
    r.close();
  });

  it("says so when Last-Event-ID is older than the replay window", async () => {
    const [old] = await publishEvents(t.redis, t.keys, [position(busIn, 17.3692, 78.534)]);
    await publishEvents(t.redis, t.keys, [
      position(busIn, 17.3693, 78.535),
      position(busIn, 17.3694, 78.536),
    ]);
    // MAXLEN trims past the client's last id while it is away
    await t.redis.xtrim(t.keys.streamEvents, "MAXLEN", 1);
    const r = openStream(`${base}/v1/stream`, tokenA, old);
    await r.waitFor((f) => f.length >= 1);
    const ready = r.frames.find((x) => x.event.type === "stream.ready")!;
    expect(ready.event.type === "stream.ready" && ready.event.data.replayTruncated).toBe(true);
    r.close();
  });

  it("scopes to the posted focus: bbox plus pinned buses, with the frame that leaves the view", async () => {
    const s = openStream(`${base}/v1/stream`, tokenA);
    await s.waitFor((f) => f.some((x) => x.event.type === "fleet.snapshot"));
    const connId = s.frames[0]!.event.type === "stream.ready" ? s.frames[0]!.event.data.connId : "";
    const bbox = [78.52, 17.36, 78.54, 17.38];

    // another student cannot steer this stream
    const hijack = await fetch(`${base}/v1/stream/focus`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenB}`, "content-type": "application/json" },
      body: JSON.stringify({ connId, bbox, busIds: [] }),
    });
    expect(hijack.status).toBe(404);

    const res = await fetch(`${base}/v1/stream/focus`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ connId, bbox, busIds: [] }),
    });
    expect(res.status).toBe(204);
    // a fresh snapshot for the new focus: only the bus inside the box
    await s.waitFor((f) => f.filter((x) => x.event.type === "fleet.snapshot").length >= 2);
    const snap = s.frames.filter((x) => x.event.type === "fleet.snapshot").at(-1)!.event;
    expect(snap.type === "fleet.snapshot" && snap.data.buses.map((b) => b.id)).toEqual([busIn]);

    const ids = await publishEvents(t.redis, t.keys, [
      position(busOut, 17.45, 78.6), // outside, not pinned: not sent
      position(busIn, 17.5, 78.7), // leaves the box: sent once, so the client can move it
      position(busIn, 17.51, 78.71), // still outside: not sent
    ]);
    await sleep(400);
    const got = s.frames.filter((x) => x.id && ids.includes(x.id)).map((x) => x.id);
    expect(got).toEqual([ids[1]]);
    s.close();
  });

  it("sends eta.update only for the stops a connection asked for — never replayable (Stage 5)", async () => {
    const stopMine = "55555555-5555-4555-8555-555555555555";
    const stopOther = "66666666-6666-4666-8666-666666666666";
    const eta = (p50: number) =>
      JSON.stringify({ p50, p90: p50 + 60, confidence: "low", at: new Date().toISOString() });
    await t.redis.hset(t.keys.tripEta(trip), stopMine, eta(300));
    await t.redis.hset(t.keys.tripEta(trip), stopOther, eta(500));

    const s = openStream(`${base}/v1/stream`, tokenA);
    await s.waitFor((f) => f.some((x) => x.event.type === "fleet.snapshot"));
    const connId = s.frames[0]!.event.type === "stream.ready" ? s.frames[0]!.event.data.connId : "";
    await fetch(`${base}/v1/stream/focus`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ connId, busIds: [busIn, busOut], stopIds: [stopMine] }),
    });
    // re-derived from Redis on focus: the current ETA, for my stop only
    await s.waitFor((f) => f.some((x) => x.event.type === "eta.update"));
    const first = s.frames.filter((x) => x.event.type === "eta.update");
    expect(
      first.map((x) => x.event.type === "eta.update" && [x.event.data.stopId, x.event.data.p50]),
    ).toEqual([[stopMine, 300]]);
    expect(first.every((x) => x.id === undefined)).toBe(true);

    // a live change arrives over pub/sub; the other stop's does not reach this student
    await t.redis.publish(
      t.keys.etaChannel,
      JSON.stringify([
        { tripId: trip, stopId: stopOther, p50: 480, p90: 540 },
        { tripId: trip, stopId: stopMine, p50: 0, p90: 0, withdrawn: true },
      ]),
    );
    await s.waitFor((f) => f.filter((x) => x.event.type === "eta.update").length >= 2);
    const last = s.frames.filter((x) => x.event.type === "eta.update").at(-1)!;
    expect(last.event.type === "eta.update" && last.event.data).toMatchObject({
      stopId: stopMine,
      withdrawn: true,
    });
    expect(
      s.frames.some((x) => x.event.type === "eta.update" && x.event.data.stopId === stopOther),
    ).toBe(false);
    s.close();
  });

  it("delivers a notification frame to the student it names and to no one else, without an id (Stage 6)", async () => {
    const a = openStream(`${base}/v1/stream`, tokenA);
    const b = openStream(`${base}/v1/stream`, tokenB);
    await a.waitFor((f) => f.some((x) => x.event.type === "fleet.snapshot"));
    await b.waitFor((f) => f.some((x) => x.event.type === "fleet.snapshot"));
    await t.redis.publish(
      t.keys.notifyChannel,
      JSON.stringify({
        userIds: [userA],
        frame: {
          type: "notification",
          data: {
            id: "55555555-5555-4555-8555-555555555555",
            tier: 1,
            title: "Leave now",
            body: "Bus 14 in 8 min",
            createdAt: new Date().toISOString(),
          },
        },
      }),
    );
    await a.waitFor((f) => f.some((x) => x.event.type === "notification"));
    await sleep(300);
    expect(b.frames.some((x) => x.event.type === "notification")).toBe(false);
    const n = a.frames.find((x) => x.event.type === "notification")!;
    expect(n.id).toBeUndefined(); // per-user: never replayable (invariant 9)
    a.close();
    b.close();
  });
});
