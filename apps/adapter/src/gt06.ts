/**
 * GT06 (Concox) binary protocol — decoder and the few encoders a server needs (BUILD_PLAN
 * Stage 9 "hardware tracker adapter", ADR-0008). Pure: bytes in, messages out, no I/O and no
 * clock, so it is tested against the worked examples in the protocol manual.
 *
 * Frame: 0x78 0x78 | len(1) | protocol(1) | content | serial(2) | crc(2) | 0x0D 0x0A
 *        0x79 0x79 | len(2) | …  (the "long" form some firmware uses for large packets)
 * `len` counts protocol + content + serial + crc. The CRC is CRC-ITU (X.25) over len … serial.
 *
 * Messages this adapter understands (everything else is acknowledged if the manual says so, and
 * otherwise ignored):
 *   0x01 login (IMEI)           → must be answered, or the device reconnects for ever
 *   0x12 GPS + LBS location     (the original GT06)
 *   0x22 GPS + LBS location     (GT06N / Concox 2018+: adds ACC and the real-time / re-upload flag)
 *   0x13 status (heartbeat)     → answered; carries ACC, never a position
 *   0x16 alarm (GPS + LBS + status) → answered; its position is a position like any other
 */

export const PROTO = {
  LOGIN: 0x01,
  LOCATION: 0x12,
  STATUS: 0x13,
  ALARM: 0x16,
  LOCATION_2018: 0x22,
} as const;

const CRC_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x8408 : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** CRC-ITU / CRC-16/X-25: reflected 0x1021, init and xorout 0xFFFF. */
export function crcItu(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const b of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xff]!;
  return (crc ^ 0xffff) & 0xffff;
}

export interface Fix {
  /** UTC, from the device's clock */
  recordedAt: string;
  lat: number;
  lng: number;
  speedKmh: number;
  headingDeg: number;
  /** the receiver had a fix (bit 4 of course/status); an unpositioned report is not a position */
  positioned: boolean;
  satellites: number;
  /** 0x22 only: ignition. null when the packet does not say */
  acc: boolean | null;
  /** 0x22 only: the device is re-uploading buffered fixes (it was out of coverage) */
  reupload: boolean;
}

export type Message =
  | { kind: "login"; imei: string; serial: number }
  | { kind: "location"; fix: Fix; serial: number; protocol: number }
  | {
      kind: "status";
      acc: boolean;
      charging: boolean;
      voltageLevel: number;
      gsm: number;
      serial: number;
    }
  | { kind: "other"; protocol: number; serial: number };

/** One complete frame's protocol-to-serial bytes, or why a frame was dropped. */
export type Frame =
  | { ok: true; protocol: number; content: Uint8Array; serial: number }
  | { ok: false; reason: "crc" | "short" };

/**
 * A streaming splitter: TCP delivers arbitrary chunks, several frames per chunk or one frame over
 * several. Garbage before a start marker is skipped; a frame whose CRC fails is dropped (the
 * device resends what matters — logins and alarms — when it gets no answer).
 */
export class FrameReader {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    const out: Frame[] = [];
    for (;;) {
      let start = -1;
      for (let i = 0; i + 1 < this.buf.length; i++) {
        const a = this.buf[i];
        if ((a === 0x78 || a === 0x79) && this.buf[i + 1] === a) {
          start = i;
          break;
        }
      }
      if (start === -1) {
        // keep a trailing half marker
        this.buf = this.buf.slice(Math.max(0, this.buf.length - 1));
        return out;
      }
      const long = this.buf[start] === 0x79;
      const head = long ? 4 : 3;
      if (this.buf.length < start + head) break;
      const len = long ? (this.buf[start + 2]! << 8) | this.buf[start + 3]! : this.buf[start + 2]!;
      const total = head + len + 2; // + 0x0D 0x0A
      if (len < 5) {
        this.buf = this.buf.slice(start + 2); // not a frame: skip the marker
        out.push({ ok: false, reason: "short" });
        continue;
      }
      if (this.buf.length < start + total) break;
      const frame = this.buf.slice(start, start + total);
      const body = frame.slice(2, head + len - 2); // len … serial
      const crc = (frame[head + len - 2]! << 8) | frame[head + len - 1]!;
      const stop = frame[total - 2] === 0x0d && frame[total - 1] === 0x0a;
      if (!stop || crcItu(body) !== crc) {
        // a false start (line noise that looked like a marker) or a corrupted frame: resync one
        // byte on, so a real frame hiding inside the bytes we misread is not thrown away
        this.buf = this.buf.slice(start + 1);
        out.push({ ok: false, reason: "crc" });
        continue;
      }
      this.buf = this.buf.slice(start + total);
      const protocol = frame[head]!;
      const content = frame.slice(head + 1, head + len - 4);
      const serial = (frame[head + len - 4]! << 8) | frame[head + len - 3]!;
      out.push({ ok: true, protocol, content, serial });
    }
    return out;
  }
}

const u32 = (b: Uint8Array, i: number) =>
  ((b[i]! << 24) >>> 0) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!;

function decodeGps(c: Uint8Array, at: number): Omit<Fix, "acc" | "reupload"> {
  const [yy, mo, dd, hh, mi, ss] = [
    c[at]!,
    c[at + 1]!,
    c[at + 2]!,
    c[at + 3]!,
    c[at + 4]!,
    c[at + 5]!,
  ];
  const recordedAt = new Date(Date.UTC(2000 + yy, mo - 1, dd, hh, mi, ss)).toISOString();
  const satellites = c[at + 6]! & 0x0f;
  let lat = u32(c, at + 7) / 1_800_000;
  let lng = u32(c, at + 11) / 1_800_000;
  const speedKmh = c[at + 15]!;
  const cs = (c[at + 16]! << 8) | c[at + 17]!;
  const positioned = !!(cs & 0x1000);
  if (cs & 0x0800) lng = -lng; // west
  if (!(cs & 0x0400)) lat = -lat; // bit set = north
  return {
    recordedAt,
    lat: Math.round(lat * 1e7) / 1e7,
    lng: Math.round(lng * 1e7) / 1e7,
    speedKmh,
    headingDeg: (cs & 0x03ff) % 360,
    positioned,
    satellites,
  };
}

export function decode(f: Extract<Frame, { ok: true }>): Message {
  const c = f.content;
  switch (f.protocol) {
    case PROTO.LOGIN: {
      // 8 bytes of BCD; the IMEI is the last 15 digits
      const digits = [...c.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return { kind: "login", imei: digits.slice(-15), serial: f.serial };
    }
    case PROTO.LOCATION:
    case PROTO.ALARM:
    case PROTO.LOCATION_2018: {
      const gps = decodeGps(c, 0);
      // after 18 GPS bytes: LBS (MCC 2, MNC 1, LAC 2, cell 3 = 8), then 0x22's extras
      const extras = 18 + 8;
      const is2018 = f.protocol === PROTO.LOCATION_2018 && c.length >= extras + 3;
      return {
        kind: "location",
        protocol: f.protocol,
        serial: f.serial,
        fix: {
          ...gps,
          acc: is2018 ? c[extras] === 1 : null,
          reupload: is2018 ? c[extras + 2] === 1 : false,
        },
      };
    }
    case PROTO.STATUS: {
      const info = c[0] ?? 0;
      return {
        kind: "status",
        acc: !!(info & 0x02),
        charging: !!(info & 0x04),
        voltageLevel: c[1] ?? 0,
        gsm: c[2] ?? 0,
        serial: f.serial,
      };
    }
    default:
      return { kind: "other", protocol: f.protocol, serial: f.serial };
  }
}

/** The short-form acknowledgement the device waits for (login, status, alarm). */
export function ack(protocol: number, serial: number): Uint8Array {
  return frame(protocol, new Uint8Array(0), serial);
}

/** Build a short frame — the server's answers, and the fake device's packets in tests. */
export function frame(protocol: number, content: Uint8Array, serial: number): Uint8Array {
  const len = 1 + content.length + 2 + 2;
  const body = new Uint8Array(1 + len - 2);
  body[0] = len;
  body[1] = protocol;
  body.set(content, 2);
  body[2 + content.length] = (serial >> 8) & 0xff;
  body[3 + content.length] = serial & 0xff;
  const crc = crcItu(body);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x78;
  out.set(body, 2);
  out[2 + body.length] = crc >> 8;
  out[3 + body.length] = crc & 0xff;
  out[4 + body.length] = 0x0d;
  out[5 + body.length] = 0x0a;
  return out;
}

/** Encode a fix as a device would (0x22 with ACC, or 0x12) — used by the fake device. */
export function encodeLocation(
  fix: Pick<Fix, "recordedAt" | "lat" | "lng" | "speedKmh" | "headingDeg"> & {
    acc?: boolean;
    reupload?: boolean;
    satellites?: number;
  },
  serial: number,
  protocol: number = PROTO.LOCATION_2018,
): Uint8Array {
  const d = new Date(fix.recordedAt);
  const c = new Uint8Array(protocol === PROTO.LOCATION_2018 ? 18 + 8 + 3 + 4 : 18 + 8);
  c.set([
    d.getUTCFullYear() - 2000,
    d.getUTCMonth() + 1,
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
  ]);
  c[6] = 0xc0 | ((fix.satellites ?? 9) & 0x0f);
  const put32 = (i: number, v: number) => {
    c[i] = (v >>> 24) & 0xff;
    c[i + 1] = (v >>> 16) & 0xff;
    c[i + 2] = (v >>> 8) & 0xff;
    c[i + 3] = v & 0xff;
  };
  put32(7, Math.round(Math.abs(fix.lat) * 1_800_000));
  put32(11, Math.round(Math.abs(fix.lng) * 1_800_000));
  c[15] = Math.min(255, Math.round(fix.speedKmh));
  const cs =
    0x1000 |
    (fix.lng < 0 ? 0x0800 : 0) |
    (fix.lat >= 0 ? 0x0400 : 0) |
    (Math.round(fix.headingDeg) & 0x3ff);
  c[16] = cs >> 8;
  c[17] = cs & 0xff;
  c.set([0x01, 0x94, 0x0a, 0x00, 0x01, 0x00, 0x00, 0x01], 18); // MCC 404 (India), MNC 10
  if (protocol === PROTO.LOCATION_2018) {
    c[26] = fix.acc === false ? 0 : 1;
    c[27] = 0; // upload mode: timed
    c[28] = fix.reupload ? 1 : 0;
  }
  return frame(protocol, c, serial);
}

export function encodeLogin(imei: string, serial: number): Uint8Array {
  const digits = imei.padStart(16, "0");
  const c = new Uint8Array(8);
  for (let i = 0; i < 8; i++) c[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return frame(PROTO.LOGIN, c, serial);
}

export function encodeStatus(acc: boolean, serial: number): Uint8Array {
  return frame(
    PROTO.STATUS,
    new Uint8Array([0x40 | (acc ? 0x02 : 0), 0x04, 0x04, 0x00, 0x01]),
    serial,
  );
}
