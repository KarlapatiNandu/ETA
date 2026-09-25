import { createServer, type Server, type Socket } from "node:net";
import { ack, decode, FrameReader, PROTO } from "./gt06.ts";
import { DeviceUplink, UPLINK, type DeviceConfig } from "./uplink.ts";

/**
 * The adapter's TCP side (BUILD_PLAN Stage 9): GT06 trackers connect, log in with their IMEI,
 * and stream fixes. One `DeviceUplink` per IMEI, shared across reconnects — a tracker on a weak
 * cell drops and redials constantly, and its buffer and trip must survive that.
 *
 * A device that is not in the devices file is not answered and is disconnected: its login is
 * never acknowledged, so it cannot believe it is being tracked.
 */

export interface AdapterOptions {
  gateway: string;
  devices: Record<string, DeviceConfig>;
  /** sockets silent this long are closed (GT06 heartbeats every 3 min by default) */
  idleTimeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** tests shorten the ignition-off wait */
  tripEndAfterAccOffS?: number;
}

export function startAdapter(port: number, o: AdapterOptions) {
  const log = o.log ?? (() => undefined);
  const uplinks = new Map<string, DeviceUplink>();
  const uplinkFor = (imei: string) => {
    let u = uplinks.get(imei);
    if (!u) {
      u = new DeviceUplink(imei, o.devices[imei]!, o.gateway, {
        fetch: o.fetch,
        now: o.now,
        log,
        tripEndAfterAccOffS: o.tripEndAfterAccOffS,
      });
      uplinks.set(imei, u);
    }
    return u;
  };
  const stats = { connections: 0, frames: 0, badFrames: 0, fixes: 0, unknownDevices: 0 };

  const server: Server = createServer((socket: Socket) => {
    stats.connections++;
    const reader = new FrameReader();
    let imei: string | null = null;
    socket.setTimeout(o.idleTimeoutMs ?? 6 * 60_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("data", (chunk) => {
      for (const f of reader.push(chunk)) {
        if (!f.ok) {
          stats.badFrames++;
          continue;
        }
        stats.frames++;
        const m = decode(f);
        if (m.kind === "login") {
          if (!o.devices[m.imei]) {
            stats.unknownDevices++;
            log("adapter: unknown device refused", { imei: m.imei });
            socket.destroy();
            return;
          }
          imei = m.imei;
          socket.write(ack(PROTO.LOGIN, m.serial));
          continue;
        }
        if (!imei) continue; // nothing before a login counts
        const up = uplinkFor(imei);
        if (m.kind === "location") {
          stats.fixes++;
          up.onFix(m.fix);
          if (m.protocol === PROTO.ALARM) socket.write(ack(PROTO.ALARM, m.serial));
        } else if (m.kind === "status") {
          up.onAcc(m.acc);
          socket.write(ack(PROTO.STATUS, m.serial));
        }
      }
    });
  });
  server.listen(port);

  const timer = setInterval(() => {
    for (const u of uplinks.values()) void u.tick();
  }, UPLINK.BATCH_EVERY_MS / 5);

  return {
    server,
    stats,
    uplinks,
    close: async () => {
      clearInterval(timer);
      // one last flush, so a deploy does not strand a batch
      await Promise.all([...uplinks.values()].map((u) => u.tick()));
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
