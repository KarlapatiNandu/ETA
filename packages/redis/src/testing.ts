import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import { keyspace, type Keys } from "./keys.ts";

/**
 * A real Redis for tests (Streams, Lua and consumer groups are the behaviour under test, so a
 * mock would test the mock). Every test gets its own random key namespace and deletes it
 * afterwards, so suites can share one server — including a developer's running dev stack.
 *
 * TEST_REDIS_URL overrides the default local address. Without a reachable server the suite is
 * skipped locally, but in CI (CI=true) an unreachable Redis is a failure, never a skip.
 */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://127.0.0.1:6379";

export async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    connectTimeout: 1000,
  });
  try {
    await probe.connect();
    await probe.ping();
    return true;
  } catch {
    if (process.env.CI) throw new Error(`CI requires Redis at ${TEST_REDIS_URL}`);
    console.warn(`redis tests skipped: no Redis at ${TEST_REDIS_URL}`);
    return false;
  } finally {
    probe.disconnect();
  }
}

export interface TestRedis {
  redis: Redis;
  keys: Keys;
  /** a second connection, for blocking reads */
  connect(): Redis;
  close(): Promise<void>;
}

export async function createTestRedis(): Promise<TestRedis> {
  const ns = `test:${randomBytes(4).toString("hex")}:`;
  const opened: Redis[] = [];
  const connect = () => {
    const r = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
    opened.push(r);
    return r;
  };
  const redis = connect();
  return {
    redis,
    keys: keyspace(ns),
    connect,
    async close() {
      let cursor = "0";
      do {
        const [next, found] = await redis.scan(cursor, "MATCH", `${ns}*`, "COUNT", 500);
        if (found.length) await redis.del(...found);
        cursor = next;
      } while (cursor !== "0");
      for (const r of opened) r.disconnect();
    },
  };
}
