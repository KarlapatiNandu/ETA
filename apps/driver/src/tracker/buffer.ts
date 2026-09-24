import type { Ping } from "@busmitra/contracts";
import { request, STORES, transact } from "../lib/idb.ts";

/**
 * The offline ring buffer (BUILD_PLAN Stage 2). Every ping is written here *before* the network
 * is tried, so a dead zone, a crash or a reload loses nothing: whatever is in the buffer is
 * sent on reconnect with its original recorded_at.
 *
 * Bounded: at 5 s per ping, 20,000 is more than a day of driving. If it ever fills, the oldest
 * pings go first — the newest are the ones a student waiting now needs.
 */
export const BUFFER_CAPACITY = 20_000;

export interface PingBuffer {
  push(tripId: string, ping: Ping): Promise<void>;
  /** the oldest `n` pings for the trip, with the keys needed to remove them */
  peek(tripId: string, n: number): Promise<{ keys: IDBValidKey[]; pings: Ping[] }>;
  remove(keys: readonly IDBValidKey[]): Promise<void>;
  count(tripId?: string): Promise<number>;
}

export function idbPingBuffer(db: IDBDatabase, capacity = BUFFER_CAPACITY): PingBuffer {
  return {
    async push(tripId, ping) {
      await transact(db, STORES.pings, "readwrite", async (t) => {
        const store = t.objectStore(STORES.pings);
        await request(store.add({ tripId, ping }));
        const n = await request(store.count());
        if (n > capacity) {
          // evict the oldest (lowest auto-increment keys)
          let excess = n - capacity;
          await new Promise<void>((resolve, reject) => {
            const cur = store.openCursor();
            cur.onsuccess = () => {
              const c = cur.result;
              if (!c || excess <= 0) return resolve();
              c.delete();
              excess--;
              c.continue();
            };
            cur.onerror = () => reject(cur.error);
          });
        }
      });
    },

    peek(tripId, n) {
      return transact(db, STORES.pings, "readonly", (t) => {
        const keys: IDBValidKey[] = [];
        const pings: Ping[] = [];
        return new Promise<{ keys: IDBValidKey[]; pings: Ping[] }>((resolve, reject) => {
          // the index walks in (tripId, primary key) order: oldest first within the trip
          const cur = t
            .objectStore(STORES.pings)
            .index("trip")
            .openCursor(IDBKeyRange.only(tripId));
          cur.onsuccess = () => {
            const c = cur.result;
            if (!c || pings.length >= n) return resolve({ keys, pings });
            keys.push(c.primaryKey);
            pings.push((c.value as { ping: Ping }).ping);
            c.continue();
          };
          cur.onerror = () => reject(cur.error);
        });
      });
    },

    async remove(keys) {
      if (!keys.length) return;
      await transact(db, STORES.pings, "readwrite", async (t) => {
        const store = t.objectStore(STORES.pings);
        await Promise.all(keys.map((k) => request(store.delete(k))));
      });
    },

    count(tripId) {
      return transact(db, STORES.pings, "readonly", (t) => {
        const store = t.objectStore(STORES.pings);
        return request(
          tripId ? store.index("trip").count(IDBKeyRange.only(tripId)) : store.count(),
        );
      });
    },
  };
}

/** In-memory buffer with the same contract, for tests and for browsers without IndexedDB. */
export function memoryPingBuffer(capacity = BUFFER_CAPACITY): PingBuffer {
  let seq = 0;
  const rows: { key: number; tripId: string; ping: Ping }[] = [];
  return {
    async push(tripId, ping) {
      rows.push({ key: ++seq, tripId, ping });
      while (rows.length > capacity) rows.shift();
    },
    async peek(tripId, n) {
      const mine = rows.filter((r) => r.tripId === tripId).slice(0, n);
      return { keys: mine.map((r) => r.key), pings: mine.map((r) => r.ping) };
    },
    async remove(keys) {
      const set = new Set(keys);
      for (let i = rows.length - 1; i >= 0; i--) if (set.has(rows[i]!.key)) rows.splice(i, 1);
    },
    async count(tripId) {
      return tripId ? rows.filter((r) => r.tripId === tripId).length : rows.length;
    },
  };
}
