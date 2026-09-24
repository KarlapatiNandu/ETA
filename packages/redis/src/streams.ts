import type { Redis } from "ioredis";

/**
 * Redis Streams with consumer groups: durable, replayable ingest (ADR-0002). Each consumer
 * group keeps its own cursor, so the persister can lag or crash while the geo worker keeps
 * the live map current, and nothing is lost in between.
 *
 * Every entry carries a field `d` holding JSON: one parse per entry, and the schema lives in
 * @busmitra/contracts rather than in field-name conventions. An entry may also carry `tp`, the
 * W3C traceparent of the span that wrote it (Stage 8), so one trace follows a fix from ingest to
 * the student's phone. It is metadata only: nothing reads behaviour from it.
 */

export interface StreamEntry<T> {
  id: string;
  data: T;
  /** W3C traceparent of the span that wrote it (Stage 8), when telemetry is on */
  tp?: string;
}

/** Append entries in one round trip. MAXLEN ~ trims approximately, which is O(1). */
export async function appendEntries(
  redis: Redis,
  stream: string,
  items: readonly unknown[],
  maxLen: number,
  tp?: string | ((item: unknown, index: number) => string | undefined),
): Promise<string[]> {
  if (items.length === 0) return [];
  const pipe = redis.pipeline();
  items.forEach((item, i) => {
    const trace = typeof tp === "function" ? tp(item, i) : tp;
    if (trace)
      pipe.xadd(stream, "MAXLEN", "~", maxLen, "*", "d", JSON.stringify(item), "tp", trace);
    else pipe.xadd(stream, "MAXLEN", "~", maxLen, "*", "d", JSON.stringify(item));
  });
  const res = (await pipe.exec()) ?? [];
  return res.map(([err, id]) => {
    if (err) throw err;
    return id as string;
  });
}

/** Create the group if it does not exist. New groups start at the beginning of the stream. */
export async function ensureGroup(redis: Redis, stream: string, group: string): Promise<void> {
  try {
    await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
  } catch (err) {
    if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
  }
}

type RawEntries = [id: string, fields: string[]][];

/**
 * Decode entries; anything that is not `d` = valid JSON can never be processed, so it is
 * acknowledged here instead of sitting in the group's pending list for ever.
 */
async function decode<T>(
  redis: Redis,
  stream: string,
  group: string,
  raw: RawEntries,
): Promise<StreamEntry<T>[]> {
  const out: StreamEntry<T>[] = [];
  const poison: string[] = [];
  for (const [id, fields] of raw) {
    const i = fields.indexOf("d");
    try {
      if (i === -1 || fields[i + 1] === undefined) throw new Error("no d field");
      const t = fields.indexOf("tp");
      const tp = t === -1 ? undefined : fields[t + 1];
      out.push({ id, data: JSON.parse(fields[i + 1]!) as T, ...(tp ? { tp } : {}) });
    } catch {
      poison.push(id);
    }
  }
  if (poison.length) await redis.xack(stream, group, ...poison);
  return out;
}

/**
 * Read for `consumer`. `pending: true` re-reads this consumer's own delivered-but-unacked
 * entries (id "0") — what a restarted worker must do first, or those entries sit in the
 * pending list forever. Otherwise reads new entries (">"), blocking up to `blockMs`.
 */
export async function readGroup<T>(
  redis: Redis,
  opts: {
    stream: string;
    group: string;
    consumer: string;
    count: number;
    blockMs?: number;
    pending?: boolean;
  },
): Promise<StreamEntry<T>[]> {
  const args: (string | number)[] = ["GROUP", opts.group, opts.consumer, "COUNT", opts.count];
  if (!opts.pending && opts.blockMs !== undefined) args.push("BLOCK", opts.blockMs);
  args.push("STREAMS", opts.stream, opts.pending ? "0" : ">");
  const res = (await redis.call("XREADGROUP", ...args)) as [string, RawEntries][] | null;
  if (!res || !res[0]) return [];
  return decode<T>(redis, opts.stream, opts.group, res[0][1]);
}

/**
 * Take over entries another consumer was delivered but never acknowledged (it crashed), once
 * they have been idle for `minIdleMs`. This is how a dead worker's in-flight pings get
 * processed instead of waiting for a consumer name that will never come back.
 */
export async function claimStale<T>(
  redis: Redis,
  opts: { stream: string; group: string; consumer: string; minIdleMs: number; count: number },
): Promise<StreamEntry<T>[]> {
  const res = (await redis.call(
    "XAUTOCLAIM",
    opts.stream,
    opts.group,
    opts.consumer,
    opts.minIdleMs,
    "0",
    "COUNT",
    opts.count,
  )) as [string, RawEntries, string[]?];
  return decode<T>(redis, opts.stream, opts.group, res[1] ?? []);
}

export async function ack(redis: Redis, stream: string, group: string, ids: readonly string[]) {
  if (ids.length) await redis.xack(stream, group, ...ids);
}

/** Entries delivered to the group but not yet acknowledged — the consumer-lag signal. */
export async function pendingCount(redis: Redis, stream: string, group: string): Promise<number> {
  const res = (await redis.xpending(stream, group)) as [number, ...unknown[]];
  return Number(res[0] ?? 0);
}

/**
 * Entries strictly after `afterId`, oldest first — the Last-Event-ID replay (ARCH §7).
 * `truncated` is true when `afterId` is older than the oldest entry still in the stream
 * (MAXLEN trimmed past it): the caller cannot replay a complete history and must say so.
 */
export async function readAfter<T>(
  redis: Redis,
  stream: string,
  afterId: string,
  count: number,
): Promise<{ entries: StreamEntry<T>[]; truncated: boolean }> {
  const raw = (await redis.xrange(stream, `(${afterId}`, "+", "COUNT", count)) as RawEntries;
  // Entries were trimmed (entries-added > length) and the client's id is older than the oldest
  // survivor: some of what it missed may be gone. Conservative — it can flag a resume that lost
  // nothing, which costs only a flag, never a missing warning.
  const info = await streamInfo(redis, stream);
  const truncated =
    info !== null &&
    info.entriesAdded > info.length &&
    info.firstId !== null &&
    compareIds(afterId, info.firstId) < 0;
  const entries: StreamEntry<T>[] = [];
  for (const [id, fields] of raw) {
    const i = fields.indexOf("d");
    try {
      entries.push({ id, data: JSON.parse(fields[i + 1]!) as T });
    } catch {
      // an undecodable entry is skipped for replay; it was never sendable live either
    }
  }
  return { entries, truncated };
}

/** The id the next XADD will follow — where a new tailer starts. */
export async function lastId(redis: Redis, stream: string): Promise<string> {
  const res = (await redis.xrevrange(stream, "+", "-", "COUNT", 1)) as RawEntries;
  return res[0]?.[0] ?? "0-0";
}

/** Stream ids are `ms-seq`; order them numerically, not as text. */
export function compareIds(a: string, b: string): number {
  const [am = 0, as = 0] = a.split("-").map(Number);
  const [bm = 0, bs = 0] = b.split("-").map(Number);
  return am !== bm ? am - bm : as - bs;
}

/** A syntactically valid stream id (what a client may send as Last-Event-ID). */
export function isStreamId(v: string): boolean {
  return /^\d{1,15}-\d{1,10}$/.test(v);
}

/** The parts of XINFO STREAM the replay needs; null when the stream does not exist. */
export async function streamInfo(
  redis: Redis,
  stream: string,
): Promise<{ length: number; entriesAdded: number; firstId: string | null } | null> {
  try {
    const info = (await redis.call("XINFO", "STREAM", stream)) as unknown[];
    const get = (name: string) => info[info.indexOf(name) + 1];
    const first = get("first-entry") as [string, unknown] | null;
    return {
      length: Number(get("length")),
      entriesAdded: Number(get("entries-added")),
      firstId: first ? first[0] : null,
    };
  } catch {
    return null;
  }
}

export interface GroupInfo {
  stream: string;
  group: string;
  /** entries not yet delivered to the group (Redis ≥ 7 `lag`; null when Redis cannot say) */
  lag: number | null;
  /** delivered but not acknowledged */
  pending: number;
  consumers: number;
}

/**
 * Consumer-group health for one stream (Stage 8 dashboards and alerts: "consumer lag > 1,000").
 * A stream that does not exist yet has no groups, not an error.
 */
export async function groupInfo(redis: Redis, stream: string): Promise<GroupInfo[]> {
  let raw: unknown[];
  try {
    raw = (await redis.call("XINFO", "GROUPS", stream)) as unknown[];
  } catch (err) {
    if (String((err as Error).message).includes("no such key")) return [];
    throw err;
  }
  return raw.map((g) => {
    const f = g as (string | number | null)[];
    const get = (k: string) => f[f.indexOf(k) + 1];
    const lag = get("lag");
    return {
      stream,
      group: String(get("name")),
      lag: lag === null || lag === undefined ? null : Number(lag),
      pending: Number(get("pending") ?? 0),
      consumers: Number(get("consumers") ?? 0),
    };
  });
}

export async function streamLength(redis: Redis, stream: string): Promise<number> {
  return redis.xlen(stream);
}
