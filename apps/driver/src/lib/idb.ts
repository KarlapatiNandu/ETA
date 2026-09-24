/**
 * The smallest IndexedDB wrapper that works: promises over requests and transactions, one
 * database, three stores. No library, on purpose — the driver bundle has to boot on a cheap
 * phone over a weak connection (ARCH §2.1).
 */

export const DB_NAME = "busmitra-driver";
export const STORES = {
  /** small key/value records: pairing, current trip, survey session */
  kv: "kv",
  /** the ping ring buffer, written before any network attempt */
  pings: "pings",
  /** survey-mode points (1 Hz), until uploaded */
  survey: "survey",
} as const;

export function openDb(factory: IDBFactory = indexedDB, name = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = factory.open(name, 1);
    open.onupgradeneeded = () => {
      const db = open.result;
      db.createObjectStore(STORES.kv);
      db.createObjectStore(STORES.pings, { autoIncrement: true }).createIndex("trip", "tripId");
      db.createObjectStore(STORES.survey, { autoIncrement: true });
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

export function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Run `fn` in one transaction; resolves with its result once the transaction commits. */
export function transact<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (t: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let out: T;
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error ?? new Error("transaction aborted"));
    Promise.resolve(fn(t)).then(
      (v) => void (out = v),
      (e) => {
        reject(e);
        try {
          t.abort();
        } catch {
          /* already finished */
        }
      },
    );
  });
}

export async function kvGet<T>(db: IDBDatabase, key: string): Promise<T | undefined> {
  return transact(db, STORES.kv, "readonly", (t) =>
    request(t.objectStore(STORES.kv).get(key)),
  ) as Promise<T | undefined>;
}

export async function kvSet(db: IDBDatabase, key: string, value: unknown): Promise<void> {
  await transact(db, STORES.kv, "readwrite", (t) =>
    request(t.objectStore(STORES.kv).put(value, key)),
  );
}

export async function kvDelete(db: IDBDatabase, key: string): Promise<void> {
  await transact(db, STORES.kv, "readwrite", (t) => request(t.objectStore(STORES.kv).delete(key)));
}
