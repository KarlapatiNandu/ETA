import { describe, expect, it } from "vitest";
import { WakeLockKeeper, type WakeEnv } from "./wakelock.ts";

/** A fake browser: visibility can be flipped, and the lock is released on hide like the real one. */
function fakeEnv(opts: { supported?: boolean; fail?: boolean } = {}) {
  let visible = true;
  const listeners: (() => void)[] = [];
  const held: { released: boolean; onRelease: (() => void)[] }[] = [];
  let requests = 0;
  const env: WakeEnv = {
    request:
      opts.supported === false
        ? undefined
        : async () => {
            requests++;
            if (opts.fail) throw new Error("NotAllowedError");
            const s = { released: false, onRelease: [] as (() => void)[] };
            held.push(s);
            return {
              release: async () => void (s.released = true),
              addEventListener: (_t: "release", fn: () => void) => void s.onRelease.push(fn),
            };
          },
    visible: () => visible,
    onVisibilityChange: (fn) => {
      listeners.push(fn);
      return () => listeners.splice(listeners.indexOf(fn), 1);
    },
  };
  const setVisible = async (v: boolean) => {
    visible = v;
    if (!v) {
      // losing visibility releases every held lock, exactly as the browser does
      for (const s of held.filter((x) => !x.released)) {
        s.released = true;
        s.onRelease.forEach((f) => f());
      }
    }
    listeners.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 0));
  };
  return { env, setVisible, requests: () => requests, listeners };
}

describe("WakeLockKeeper", () => {
  it("re-acquires the lock every time the page becomes visible again (the phone rang)", async () => {
    const f = fakeEnv();
    const k = new WakeLockKeeper(f.env);
    await k.enable();
    expect(k.state).toBe("held");
    await f.setVisible(false);
    expect(k.state).toBe("released");
    await f.setVisible(true);
    expect(k.state).toBe("held");
    await f.setVisible(false);
    await f.setVisible(true);
    expect(f.requests()).toBe(3);
    expect(k.reacquired).toBe(2);
  });

  it("stops re-acquiring once disabled", async () => {
    const f = fakeEnv();
    const k = new WakeLockKeeper(f.env);
    await k.enable();
    await k.disable();
    expect(k.state).toBe("off");
    expect(f.listeners).toHaveLength(0);
    await f.setVisible(false);
    await f.setVisible(true);
    expect(f.requests()).toBe(1);
  });

  it("reports unsupported browsers and refused requests honestly", async () => {
    const none = new WakeLockKeeper(fakeEnv({ supported: false }).env);
    await none.enable();
    expect(none.state).toBe("unsupported");
    const refused = new WakeLockKeeper(fakeEnv({ fail: true }).env);
    await refused.enable();
    expect(refused.state).toBe("error");
  });
});
