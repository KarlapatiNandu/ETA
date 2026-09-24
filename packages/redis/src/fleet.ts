import type { Redis } from "ioredis";
import type { Keys } from "./keys.ts";

/** One bus in `fleet:live` (SCHEMA §10). */
export interface FleetEntry {
  lat: number;
  lng: number;
  spd: number | null;
  hdg: number | null;
  /** route offset, metres; null while off-route (never fabricated — invariant 2) */
  s: number | null;
  /** highest stop index reached */
  seq: number;
  tripId: string | null;
  /** recorded_at of the fix, ISO-8601 UTC (always toISOString(), so it sorts as text) */
  ts: string;
  state: "LIVE" | "DEGRADED" | "DARK" | "ENDED";
  /** the tracker's reported cadence, seconds — presence thresholds derive from it (§5.7) */
  cadence: number;
  /** why the entry says what it says, e.g. "off_route", "resnapped", "trip_end", "dark_timeout" */
  flag?: string | null;
  /** the route the trip runs on, so a client can dead-reckon along it (ARCH §4) */
  routeId?: string | null;
  /** set by the presence sweeper when the bus went dark inside a known dead zone (ARCH §5.7) */
  deadZone?: { label: string | null; avgOutageS: number } | null;
}

// Compare-and-set on `ts`: a backfilled ping must never overwrite a newer live entry
// (invariant 4). Done in Lua so the read and the write are one atomic step — two geo workers
// racing on the same bus cannot interleave a stale write between them.
const WRITE_IF_NEWER = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local ok, obj = pcall(cjson.decode, cur)
  if ok and type(obj) == 'table' then
    if obj.ts and obj.ts >= ARGV[2] then
      return 0
    end
    -- a trip that has ended stays ended: pings flushed from a buffer after the driver pressed
    -- END are newer than the last one we saw, and must not put the bus back on the map as LIVE.
    -- The one exception is ENDED by the presence sweeper's timeout (DARK for 10 minutes): the
    -- trip was never closed, and a tracker that comes back is a bus that is really there.
    if obj.state == 'ENDED' and obj.tripId == ARGV[4] and obj.flag ~= 'dark_timeout' then
      return 0
    end
  end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;

// Change only the presence state of the trip's entry (e.g. ENDED on an explicit trip end),
// leaving the last known position in place. No-op if the bus has moved on to another trip.
// ARGV[5], when set, is the fix the caller judged: if a newer one has landed since, the
// judgement is stale and nothing is written (the presence sweeper's compare-and-set).
const SET_STATE = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if not cur then return 0 end
local ok, obj = pcall(cjson.decode, cur)
if not ok or type(obj) ~= 'table' or obj.tripId ~= ARGV[2] then return 0 end
if ARGV[5] ~= '' and obj.ts ~= ARGV[5] then return 0 end
-- already there: not a transition, so the caller must not announce one (two sweepers racing)
if obj.state == ARGV[3] and (ARGV[4] == '' or obj.flag == ARGV[4]) then return 0 end
obj.state = ARGV[3]
if ARGV[4] ~= '' then obj.flag = ARGV[4] end
if ARGV[6] ~= '' then
  obj.deadZone = cjson.decode(ARGV[6])
elseif ARGV[3] == 'LIVE' then
  obj.deadZone = nil
end
redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(obj))
return 1
`;

/** Write the bus's live entry unless a newer one is already there. Returns whether it wrote. */
export async function writeFleetIfNewer(
  redis: Redis,
  k: Keys,
  busId: string,
  entry: FleetEntry,
): Promise<boolean> {
  const res = await redis.eval(
    WRITE_IF_NEWER,
    1,
    k.fleetLive,
    busId,
    entry.ts,
    JSON.stringify(entry),
    entry.tripId ?? "",
  );
  return res === 1;
}

export async function setFleetState(
  redis: Redis,
  k: Keys,
  busId: string,
  tripId: string,
  state: FleetEntry["state"],
  opts: {
    flag?: string;
    /** only if the entry still holds this fix (compare-and-set on ts) */
    expectTs?: string;
    deadZone?: FleetEntry["deadZone"];
  } = {},
): Promise<boolean> {
  const res = await redis.eval(
    SET_STATE,
    1,
    k.fleetLive,
    busId,
    tripId,
    state,
    opts.flag ?? "",
    opts.expectTs ?? "",
    opts.deadZone ? JSON.stringify(opts.deadZone) : "",
  );
  return res === 1;
}

export async function readFleet(redis: Redis, k: Keys): Promise<Record<string, FleetEntry>> {
  const raw = await redis.hgetall(k.fleetLive);
  return Object.fromEntries(
    Object.entries(raw).map(([id, v]) => [id, JSON.parse(v) as FleetEntry]),
  );
}

export async function readFleetEntry(
  redis: Redis,
  k: Keys,
  busId: string,
): Promise<FleetEntry | null> {
  const v = await redis.hget(k.fleetLive, busId);
  return v ? (JSON.parse(v) as FleetEntry) : null;
}
