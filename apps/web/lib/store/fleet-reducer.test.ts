import { describe, expect, it } from "vitest";
import type { SseEvent } from "@busmitra/contracts";
import { applyEvent, etaKey, initialFleet, remaining, type FleetState } from "./fleet-reducer";

const bus = "0b6c7b6e-7a6f-4b8e-9c1a-2f7d5e3a1b2c";
const trip = "1b6c7b6e-7a6f-4b8e-9c1a-2f7d5e3a1b2c";
const T = (s: number) => new Date(Date.UTC(2026, 8, 23, 2, 0, s)).toISOString();
const position = (s: number, off = 100): SseEvent => ({
  type: "bus.position",
  data: {
    id: bus,
    lat: 17.4,
    lng: 78.5,
    spd: 20,
    hdg: 90,
    s: off,
    ts: T(s),
    tripId: trip,
    cadence: 5,
  },
});
const status = (state: "DEGRADED" | "DARK" | "ENDED", lastSeen: number): SseEvent => ({
  type: "bus.status",
  data: { id: bus, state, cadence: 5, lastSeenAt: T(lastSeen), at: T(lastSeen + 15) },
});
// the clock sits just after the fixes most tests feed, so they are fresh unless a test says not
const run = (events: SseEvent[], from: FleetState = initialFleet(), now = T(12)) =>
  events.reduce((st, e) => applyEvent(st, e, Date.parse(now)), from);

describe("fleet reducer", () => {
  it("ignores a position older than the one it holds (replay, reordering)", () => {
    const st = run([position(10, 300), position(5, 200)]);
    expect(st.buses[bus]!.s).toBe(300);
  });

  it("ignores a status judged against an older fix — a replayed amber must not win", () => {
    const st = run([position(10), status("DEGRADED", 5)]);
    expect(st.buses[bus]!.state).toBe("LIVE");
    expect(run([position(10), status("DEGRADED", 10)]).buses[bus]!.state).toBe("DEGRADED");
  });

  it("a fresh fix makes a dark bus live again and drops its dead-zone note", () => {
    const dark: SseEvent = {
      type: "bus.status",
      data: {
        id: bus,
        state: "DARK",
        cadence: 5,
        lastSeenAt: T(10),
        deadZone: { label: "Underpass", avgOutageS: 90 },
      },
    };
    const st = run([position(10), dark, position(80)]);
    expect(st.buses[bus]).toMatchObject({ state: "LIVE", deadZone: null });
  });

  it("removes a bus on ENDED — never drawn frozen", () => {
    expect(run([position(10), status("ENDED", 10)]).buses[bus]).toBeUndefined();
  });

  it("takes membership from a snapshot, but keeps a newer fix it already holds", () => {
    const held = run([position(50, 900)]);
    const snap: SseEvent = {
      type: "fleet.snapshot",
      data: {
        buses: [
          {
            id: bus,
            lat: 1,
            lng: 1,
            spd: 1,
            hdg: 1,
            s: 10,
            ts: T(40),
            tripId: trip,
            state: "LIVE",
            cadence: 5,
          },
        ],
        serverTime: T(70),
      },
    };
    const st = run([snap], held, T(60));
    expect(st.buses[bus]!.s).toBe(900);
    expect(st.clockOffsetMs).toBe(10_000);
    const emptied = run([{ type: "fleet.snapshot", data: { buses: [] } }], st);
    expect(emptied.buses).toEqual({});
  });

  it("records stop events once per (seq, event), flagging backfill", () => {
    const reached: SseEvent = {
      type: "stop.reached",
      data: { tripId: trip, stopId: bus, seq: 3, event: "arrived", at: T(5), backfill: true },
    };
    const st = run([reached, reached]);
    expect(st.stops[trip]).toEqual([
      { seq: 3, stopId: bus, event: "arrived", at: T(5), backfill: true },
    ]);
  });

  it("keeps live ETAs per (trip, stop), counts them down, and drops them when withdrawn or DARK", () => {
    const stop = "2b6c7b6e-7a6f-4b8e-9c1a-2f7d5e3a1b2c";
    const eta = (p50: number, at: number, withdrawn?: boolean): SseEvent => ({
      type: "eta.update",
      data: {
        tripId: trip,
        stopId: stop,
        p50,
        p90: p50 + 60,
        confidence: "low",
        at: T(at),
        ...(withdrawn ? { withdrawn } : {}),
      },
    });
    const st = run([position(10), eta(300, 10), eta(500, 5)]);
    expect(st.etas[etaKey(trip, stop)]!.p50).toBe(300); // the older prediction lost
    expect(remaining(st.etas[etaKey(trip, stop)]!, Date.parse(T(70)))).toEqual({
      p50: 240,
      p90: 300,
    });
    expect(run([eta(0, 20, true)], st).etas).toEqual({});
    expect(run([status("DARK", 10)], st).etas).toEqual({});
    // a reconnect starts per-user state clean
    const ready: SseEvent = {
      type: "stream.ready",
      data: { connId: "abcdefgh-2", heartbeatS: 15, serverTime: T(80) },
    };
    expect(run([ready], st).etas).toEqual({});
  });

  it("draws an old fix from a reconnect flush as late, not LIVE (invariant 2)", () => {
    // the local clock (and gateway clock) is at T(60); a fix from T(10) is 50 s old at 5 s cadence
    const st = run([position(10)], initialFleet(), T(60));
    expect(st.buses[bus]!.state).toBe("DARK");
    const fresh = run([position(58)], initialFleet(), T(60));
    expect(fresh.buses[bus]!.state).toBe("LIVE");
    const late = run([position(40)], initialFleet(), T(60));
    expect(late.buses[bus]!.state).toBe("DEGRADED");
  });
});
