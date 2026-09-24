import { describe, expect, it } from "vitest";
import { SseParser } from "./parse";

const id = "0b6c7b6e-7a6f-4b8e-9c1a-2f7d5e3a1b2c";
const pos = JSON.stringify({
  type: "bus.position",
  data: { id, lat: 17.4, lng: 78.5, spd: 20, hdg: 90, s: 100, ts: "2026-09-23T02:00:00Z" },
});

describe("SseParser", () => {
  it("splits frames across arbitrary chunk boundaries and keeps the id", () => {
    const p = new SseParser();
    const text = `id: 17-0\nevent: bus.position\ndata: ${pos}\n\n: hb\n\n`;
    const out = [...text].map((c) => p.push(c));
    const frames = out.flatMap((o) => o.frames);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe("17-0");
    expect(frames[0]!.event.type).toBe("bus.position");
    expect(out.reduce((n, o) => n + o.comments, 0)).toBe(1);
  });

  it("drops frames that fail the contract instead of guessing", () => {
    const p = new SseParser();
    const { frames } = p.push(`data: {"type":"bus.position","data":{}}\n\ndata: not json\n\n`);
    expect(frames).toEqual([]);
  });

  it("gives per-user frames no id", () => {
    const p = new SseParser();
    const ready = JSON.stringify({
      type: "stream.ready",
      data: { connId: "abcdefgh-1", heartbeatS: 15, serverTime: "2026-09-23T02:00:00Z" },
    });
    expect(p.push(`event: stream.ready\r\ndata: ${ready}\r\n\r\n`).frames[0]!.id).toBeNull();
  });
});
