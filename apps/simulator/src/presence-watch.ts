import { PRESENCE } from "@busmitra/config";
import { SseEvent } from "@busmitra/contracts";
import type { Queryable } from "@busmitra/db";
import { lastId, type Keys, type Redis } from "@busmitra/redis";

/**
 * `sim watch` — the Stage 3 presence exit criterion, measured from the outside: tail
 * `stream:events` while a fleet runs and judge every bus.status the sweeper announces.
 *
 *  - timing: each DEGRADED / DARK / ENDED must fire at 3× / 9× / 9× + 600 s of the cadence the
 *    last fix reported — never before, and within one sweep (5 s) after;
 *  - false alarms: a bus that was never cut off (not in --airplane, and --no-dead-zones) must
 *    never go amber or red — at either cadence. A parked bus at 15 s staying green is the case
 *    the ARCH §5.7 design exists for.
 */

export interface PresenceVerdict {
  ok: boolean;
  minutes: number;
  positions: { total: number; atStationaryCadence: number };
  transitions: {
    bus: string;
    state: string;
    reason: string | null;
    cadence: number;
    ageS: number;
    expectedS: number;
    lateS: number;
  }[];
  falseAlarms: { bus: string; state: string; cadence: number; ageS: number }[];
  badTiming: number;
  recovered: string[];
}

const SWEEP_SLACK_S = 6;

export async function watchPresence(
  redis: Redis,
  keys: Keys,
  db: Queryable,
  opts: { minutes: number; cutOff: string[]; log: (m: string) => void },
): Promise<PresenceVerdict> {
  const names = new Map<string, string>();
  const { rows } = await db.query<{ id: string; bus_number: string }>(
    `SELECT id, bus_number FROM buses`,
  );
  for (const r of rows) names.set(r.id, r.bus_number);
  const reader = redis.duplicate();
  let cursor = await lastId(reader, keys.streamEvents);
  const until = Date.now() + opts.minutes * 60_000;
  const v: PresenceVerdict = {
    ok: false,
    minutes: opts.minutes,
    positions: { total: 0, atStationaryCadence: 0 },
    transitions: [],
    falseAlarms: [],
    badTiming: 0,
    recovered: [],
  };
  let lastLog = Date.now();
  try {
    while (Date.now() < until) {
      const res = (await reader.xread(
        "COUNT",
        500,
        "BLOCK",
        2000,
        "STREAMS",
        keys.streamEvents,
        cursor,
      )) as [string, [string, string[]][]][] | null;
      for (const [id, fields] of res?.[0]?.[1] ?? []) {
        cursor = id;
        const parsed = SseEvent.safeParse(JSON.parse(fields[fields.indexOf("d") + 1] ?? "null"));
        if (!parsed.success) continue;
        const e = parsed.data;
        if (e.type === "bus.position") {
          v.positions.total++;
          if (e.data.cadence === 15) v.positions.atStationaryCadence++;
        }
        if (e.type !== "bus.status") continue;
        const bus = names.get(e.data.id) ?? e.data.id;
        const reason = e.data.reason ?? null;
        if (reason === "recovered") {
          v.recovered.push(bus);
          continue;
        }
        if (reason === "trip_end" || !e.data.at) continue;
        const c = e.data.cadence;
        const ageS = (Date.parse(e.data.at) - Date.parse(e.data.lastSeenAt)) / 1000;
        const expectedS =
          e.data.state === "DEGRADED"
            ? PRESENCE.DEGRADED_CADENCE_MULTIPLE * c
            : e.data.state === "DARK"
              ? PRESENCE.DARK_CADENCE_MULTIPLE * c
              : PRESENCE.DARK_CADENCE_MULTIPLE * c + PRESENCE.ENDED_AFTER_DARK_S;
        const lateS = Math.round((ageS - expectedS) * 10) / 10;
        v.transitions.push({
          bus,
          state: e.data.state,
          reason,
          cadence: c,
          ageS: Math.round(ageS * 10) / 10,
          expectedS,
          lateS,
        });
        if (lateS < 0 || lateS > SWEEP_SLACK_S) v.badTiming++;
        if (!opts.cutOff.includes(bus))
          v.falseAlarms.push({ bus, state: e.data.state, cadence: c, ageS });
        opts.log(
          `presence: ${bus} → ${e.data.state} (${reason}) at ${ageS.toFixed(1)} s, cadence ${c} s`,
        );
      }
      if (Date.now() - lastLog > 60_000) {
        lastLog = Date.now();
        opts.log(
          `watch: ${v.positions.total} positions (${v.positions.atStationaryCadence} at 15 s), ${v.transitions.length} transitions`,
        );
      }
    }
  } finally {
    reader.disconnect();
  }
  v.ok = v.falseAlarms.length === 0 && v.badTiming === 0 && v.positions.atStationaryCadence > 0;
  return v;
}
