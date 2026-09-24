"use client";
import { SseParser, type ParsedFrame } from "./parse";

/**
 * The live stream client (ARCH §7): fetch-based rather than `EventSource`, because the stream
 * is JWT-authenticated and EventSource cannot send an Authorization header. It does what
 * EventSource would have done, explicitly:
 *
 *  - remembers the last broadcast id and sends it back as `Last-Event-ID` on reconnect, so a
 *    tunnel on the student's commute does not lose a stop arrival;
 *  - reconnects with exponential backoff and jitter (1 s → 30 s), immediately on `online`;
 *  - treats silence as death: no byte for 2.5 heartbeats means the connection is gone even if
 *    TCP has not noticed (a phone switching cells), so it aborts and reconnects;
 *  - fetches a fresh token for every attempt — the gateway closes a stream when its token expires.
 */

export type ConnectionState = "connecting" | "live" | "reconnecting" | "offline";

export interface StreamOptions {
  url: string;
  getToken: () => Promise<string | null>;
  onFrame: (f: ParsedFrame) => void;
  onState: (s: ConnectionState, detail?: string) => void;
  heartbeatS?: number;
}

export class LiveStream {
  private lastEventId: string | null = null;
  private ctrl: AbortController | null = null;
  private stopped = false;
  private attempt = 0;
  private wake: (() => void) | null = null;
  private readonly o: StreamOptions;

  constructor(o: StreamOptions) {
    this.o = o;
  }

  start() {
    const onOnline = () => this.wake?.();
    const onOffline = () => this.ctrl?.abort();
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    void this.loop().finally(() => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    });
    return () => this.stop();
  }

  stop() {
    this.stopped = true;
    this.ctrl?.abort();
    this.wake?.();
  }

  private sleep(ms: number) {
    return new Promise<void>((resolve) => {
      const t = setTimeout(() => ((this.wake = null), resolve()), ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  private async loop() {
    while (!this.stopped) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        this.o.onState("offline");
        await this.sleep(30_000); // woken by the `online` event
        continue;
      }
      this.o.onState(this.attempt === 0 ? "connecting" : "reconnecting");
      const why = await this.once().catch((err: Error) => err.message);
      if (this.stopped) break;
      this.attempt++;
      const base = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt - 1, 5));
      const wait = base / 2 + Math.random() * (base / 2);
      this.o.onState(navigator.onLine === false ? "offline" : "reconnecting", why ?? undefined);
      await this.sleep(wait);
    }
  }

  /** One connection, until it ends. Returns why it ended. */
  private async once(): Promise<string> {
    const token = await this.o.getToken();
    if (!token) return "signed out";
    this.ctrl = new AbortController();
    const res = await fetch(this.o.url, {
      signal: this.ctrl.signal,
      cache: "no-store",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "text/event-stream",
        ...(this.lastEventId ? { "last-event-id": this.lastEventId } : {}),
      },
    });
    if (res.status !== 200 || !res.body) return `HTTP ${res.status}`;

    const parser = new SseParser();
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    const silenceMs = (this.o.heartbeatS ?? 15) * 2500;
    let watchdog = setTimeout(() => this.ctrl?.abort(), silenceMs);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return "closed by server";
        clearTimeout(watchdog);
        watchdog = setTimeout(() => this.ctrl?.abort(), silenceMs);
        for (const f of parser.push(value).frames) {
          if (f.id) this.lastEventId = f.id;
          if (f.event.type === "stream.ready") {
            this.attempt = 0;
            this.o.onState("live");
          }
          this.o.onFrame(f);
        }
      }
    } finally {
      clearTimeout(watchdog);
    }
  }
}
