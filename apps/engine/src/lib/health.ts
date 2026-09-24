import { ALERTS } from "@busmitra/config";
import type { PresenceState } from "@busmitra/contracts";
import {
  groupInfo,
  readFleet,
  streamLength,
  type FleetEntry,
  type GroupInfo,
  type Keys,
  type Redis,
} from "@busmitra/redis";
import { meter } from "@busmitra/telemetry";

/**
 * The live pipeline's health, read from Redis alone (BUILD_PLAN Stage 8): consumer-group lag on
 * every stream, the persister's dead letters, and the fleet by presence state. One definition,
 * two readers — the engine exports it as OTel gauges for Grafana, and the gateway serves it to
 * the TD console's observability page, which works with no Grafana account at all.
 */

export interface FleetHealth {
  byState: Record<PresenceState, number>;
  /** buses DARK longer than ALERTS.DARK_S on a trip that has not ended */
  darkTooLong: { busId: string; darkForS: number }[];
}

/** DARK is judged by the age of the last fix: the bus went dark 9 cadences after it. */
export function summariseFleet(fleet: Record<string, FleetEntry>, now: number): FleetHealth {
  const byState: Record<PresenceState, number> = { LIVE: 0, DEGRADED: 0, DARK: 0, ENDED: 0 };
  const darkTooLong: FleetHealth["darkTooLong"] = [];
  for (const [busId, e] of Object.entries(fleet)) {
    byState[e.state] = (byState[e.state] ?? 0) + 1;
    const silentS = (now - Date.parse(e.ts)) / 1000;
    // ENDED by timeout (`dark_timeout`) is a bus still silent on an open trip: it counts
    const dark = e.state === "DARK" || (e.state === "ENDED" && e.flag === "dark_timeout");
    if (dark && silentS >= ALERTS.DARK_S)
      darkTooLong.push({ busId, darkForS: Math.round(silentS) });
  }
  return { byState, darkTooLong };
}

export interface PipelineHealth {
  groups: GroupInfo[];
  deadLetters: number;
  fleet: FleetHealth;
}

export async function pipelineHealth(
  redis: Redis,
  keys: Keys,
  now: number,
): Promise<PipelineHealth> {
  const [pings, events, notify, deadLetters, fleet] = await Promise.all([
    groupInfo(redis, keys.streamPings),
    groupInfo(redis, keys.streamEvents),
    groupInfo(redis, keys.streamNotify),
    streamLength(redis, keys.streamPingsDead),
    readFleet(redis, keys),
  ]);
  return {
    groups: [...pings, ...events, ...notify].map((g) => ({
      ...g,
      // registry names, not namespaced keys: dashboards must not depend on a test namespace
      stream: g.stream.slice(keys.ns.length),
    })),
    deadLetters,
    fleet: summariseFleet(fleet, now),
  };
}

/**
 * Register the engine's observable gauges. Read once per export (15 s by default), in one Redis
 * round of five commands — nothing is polled when telemetry is off.
 */
export function registerEngineGauges(deps: { redis: Redis; keys: Keys }): void {
  const m = meter();
  const lag = m.createObservableGauge("busmitra.stream.lag", {
    description: "entries not yet delivered to a consumer group",
  });
  const pending = m.createObservableGauge("busmitra.stream.pending", {
    description: "entries delivered to a consumer group but not acknowledged",
  });
  const dead = m.createObservableGauge("busmitra.stream.dead_letters", {
    description: "pings the persister could not write (stream:pings:dead)",
  });
  const buses = m.createObservableGauge("busmitra.fleet.buses", {
    description: "buses in fleet:live by presence state",
  });
  const darkLong = m.createObservableGauge("busmitra.fleet.dark_too_long", {
    description: `buses DARK for ${ALERTS.DARK_S / 60}+ minutes on an open trip`,
  });
  m.addBatchObservableCallback(
    async (obs) => {
      const h = await pipelineHealth(deps.redis, deps.keys, Date.now());
      for (const g of h.groups) {
        const attrs = { stream: g.stream, group: g.group };
        if (g.lag !== null) obs.observe(lag, g.lag, attrs);
        obs.observe(pending, g.pending, attrs);
      }
      obs.observe(dead, h.deadLetters);
      for (const [state, n] of Object.entries(h.fleet.byState)) obs.observe(buses, n, { state });
      obs.observe(darkLong, h.fleet.darkTooLong.length);
    },
    [lag, pending, dead, buses, darkLong],
  );
}
