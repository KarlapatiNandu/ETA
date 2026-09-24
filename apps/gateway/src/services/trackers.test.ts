import { describe, expect, it } from "vitest";
import type { Queryable } from "@busmitra/db";
import { createTrackerDirectory, newSecret, TRACKERS } from "./trackers.ts";

/** A Queryable that returns one tracker row, counts calls, and can be made to fail. */
function fakeDb(row: Record<string, unknown> | null) {
  const state = { calls: 0, down: false };
  const db: Queryable = {
    async query<T>() {
      state.calls++;
      if (state.down)
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return { rows: (row ? [row] : []) as T[] };
    },
  };
  return { db, state };
}

describe("tracker directory", () => {
  const T = 1_800_000_000_000;

  it("accepts the previous secret only inside the 10-minute rotation overlap", async () => {
    const row = { id: "t1", bus_id: "b1", secret: "new", prev: "old", rotated_at: new Date(T) };
    let now = T + TRACKERS.ROTATION_OVERLAP_MS - 1000;
    const dir = createTrackerDirectory(fakeDb(row).db, "k", () => now);
    expect((await dir.get("d"))!.secrets).toEqual(["new", "old"]);
    now = T + TRACKERS.ROTATION_OVERLAP_MS + TRACKERS.CACHE_TTL_MS + 1;
    expect((await dir.get("d"))!.secrets).toEqual(["new"]);
  });

  it("caches hits, and serves a stale hit when Postgres is down (ingest keeps flowing)", async () => {
    const f = fakeDb({ id: "t1", bus_id: "b1", secret: "s", prev: null, rotated_at: null });
    let now = T;
    const dir = createTrackerDirectory(f.db, "k", () => now);
    await dir.get("d");
    await dir.get("d");
    expect(f.state.calls).toBe(1);
    now += TRACKERS.CACHE_TTL_MS + 1;
    f.state.down = true;
    expect((await dir.get("d"))!.trackerId).toBe("t1");
    dir.forget("d");
    await expect(dir.get("d")).rejects.toThrow(/ECONNREFUSED/);
  });

  it("remembers an unknown device briefly, so forged ids cannot hammer the database", async () => {
    const f = fakeDb(null);
    let now = T;
    const dir = createTrackerDirectory(f.db, "k", () => now);
    expect(await dir.get("ghost")).toBeNull();
    expect(await dir.get("ghost")).toBeNull();
    expect(f.state.calls).toBe(1);
    now += TRACKERS.NEGATIVE_TTL_MS + 1;
    await dir.get("ghost");
    expect(f.state.calls).toBe(2);
  });

  it("re-reads on a signature miss at most once per 5 s per device (a rotation on another instance)", async () => {
    const row = { id: "t1", bus_id: "b1", secret: "old", prev: null, rotated_at: null };
    const f = fakeDb(row);
    let now = T;
    const dir = createTrackerDirectory(f.db, "k", () => now);
    await dir.get("d");
    // within 5 s of the last read, a miss does not touch Postgres: forged floods stay cheap
    now += TRACKERS.REFRESH_ON_MISS_MS - 1;
    expect((await dir.refresh("d"))!.secrets).toEqual(["old"]);
    expect(f.state.calls).toBe(1);
    // the secret was rotated elsewhere; the next miss after 5 s picks it up
    row.secret = "new";
    now += 2;
    expect((await dir.refresh("d"))!.secrets).toEqual(["new"]);
    expect(f.state.calls).toBe(2);
    // and with Postgres down the stale entry is kept, not dropped
    now += TRACKERS.REFRESH_ON_MISS_MS + 1;
    f.state.down = true;
    expect((await dir.refresh("d"))!.secrets).toEqual(["new"]);
  });

  it("issues 256-bit secrets", () => {
    const s = newSecret();
    expect(Buffer.from(s, "base64url")).toHaveLength(32);
    expect(newSecret()).not.toBe(s);
  });
});
