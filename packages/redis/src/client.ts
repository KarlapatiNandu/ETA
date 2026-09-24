import { Redis } from "ioredis";

export type { Redis };

/**
 * One client per process role. Blocking reads (XREADGROUP BLOCK) need their own connection,
 * or every other command on it queues behind the block — call this again for consumers.
 */
export function createRedis(url: string, name: string): Redis {
  return new Redis(url, {
    connectionName: `busmitra:${name}`,
    // the gateway must answer 503 quickly when Redis is gone (ARCH §11), not queue forever
    maxRetriesPerRequest: 2,
    enableOfflineQueue: true,
    lazyConnect: false,
  });
}
