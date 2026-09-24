/**
 * Keeps the screen on while a trip or survey runs (BUILD_PLAN Stage 2).
 *
 * The Screen Wake Lock is released by the browser whenever the page loses visibility — the
 * notification shade, an incoming call, a moment of screen-off — and it does NOT come back by
 * itself. So it is re-acquired on every `visibilitychange` back to visible. Without that, the
 * tracker dies quietly the first time the driver's phone rings (BUILD_PLAN "Watch for").
 */

export type WakeState = "off" | "held" | "released" | "unsupported" | "error";

interface Sentinel {
  release(): Promise<void>;
  addEventListener(type: "release", fn: () => void): void;
}

export interface WakeEnv {
  request?: () => Promise<Sentinel>;
  visible: () => boolean;
  onVisibilityChange: (fn: () => void) => () => void;
}

export function browserWakeEnv(): WakeEnv {
  const wl = (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<Sentinel> } })
    .wakeLock;
  return {
    request: wl ? () => wl.request("screen") : undefined,
    visible: () => document.visibilityState === "visible",
    onVisibilityChange: (fn) => {
      document.addEventListener("visibilitychange", fn);
      return () => document.removeEventListener("visibilitychange", fn);
    },
  };
}

export class WakeLockKeeper {
  state: WakeState = "off";
  /** times the lock was re-acquired after being lost — shown in the UI, useful in the field */
  reacquired = 0;
  private sentinel: Sentinel | null = null;
  private wanted = false;
  private unlisten: (() => void) | null = null;
  private readonly env: WakeEnv;
  private readonly onChange: (s: WakeState) => void;

  constructor(env: WakeEnv, onChange: (s: WakeState) => void = () => {}) {
    this.env = env;
    this.onChange = onChange;
  }

  private set(s: WakeState) {
    this.state = s;
    this.onChange(s);
  }

  async enable(): Promise<void> {
    this.wanted = true;
    if (!this.env.request) return this.set("unsupported");
    this.unlisten ??= this.env.onVisibilityChange(() => {
      if (this.wanted && this.env.visible() && this.state !== "held") {
        this.reacquired++;
        void this.acquire();
      }
    });
    await this.acquire();
  }

  private async acquire(): Promise<void> {
    if (!this.env.request || !this.env.visible()) return;
    try {
      const s = await this.env.request();
      this.sentinel = s;
      s.addEventListener("release", () => {
        this.sentinel = null;
        if (this.wanted) this.set("released");
      });
      this.set("held");
    } catch {
      this.set("error"); // e.g. battery saver; retried on the next visibility change
    }
  }

  async disable(): Promise<void> {
    this.wanted = false;
    this.unlisten?.();
    this.unlisten = null;
    const s = this.sentinel;
    this.sentinel = null;
    await s?.release().catch(() => {});
    this.set("off");
  }
}
