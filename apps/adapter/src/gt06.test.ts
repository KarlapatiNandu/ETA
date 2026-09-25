import { describe, expect, it } from "vitest";
import {
  ack,
  crcItu,
  decode,
  encodeLocation,
  encodeLogin,
  encodeStatus,
  FrameReader,
  PROTO,
  type Frame,
} from "./gt06.ts";

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s/g, ""), "hex"));
const ok = (fs: Frame[]) => fs.filter((f): f is Extract<Frame, { ok: true }> => f.ok);

// worked examples from the GT06 protocol manual
const LOGIN = hex("78 78 0D 01 01 23 45 67 89 01 23 45 00 01 8C DD 0D 0A");
const LOGIN_ACK = hex("78 78 05 01 00 01 D9 DC 0D 0A");
const LOCATION = hex(
  "78 78 1F 12 0B 08 1D 11 2E 10 CF 02 7A C7 EB 0C 46 58 49 00 14 8F 01 CC 00 28 7D 00 1F B8 00 03 80 81 0D 0A",
);

describe("GT06 codec (the manual's worked examples)", () => {
  it("CRC-ITU matches the manual", () => {
    expect(crcItu(LOGIN.slice(2, -4))).toBe(0x8cdd);
    expect(crcItu(LOCATION.slice(2, -4))).toBe(0x8081);
  });

  it("decodes a login and answers it byte for byte as the manual does", () => {
    const [f] = ok(new FrameReader().push(LOGIN));
    expect(decode(f!)).toEqual({ kind: "login", imei: "123456789012345", serial: 1 });
    expect(Buffer.from(ack(PROTO.LOGIN, 1))).toEqual(Buffer.from(LOGIN_ACK));
  });

  it("decodes the manual's location packet", () => {
    const [f] = ok(new FrameReader().push(LOCATION));
    const m = decode(f!);
    expect(m).toMatchObject({ kind: "location", protocol: 0x12, serial: 3 });
    if (m.kind !== "location") throw new Error();
    expect(m.fix).toEqual({
      recordedAt: "2011-08-29T17:46:16.000Z",
      lat: 23.1116683,
      lng: 114.409285,
      speedKmh: 0,
      headingDeg: 143,
      positioned: true,
      satellites: 15,
      acc: null,
      reupload: false,
    });
  });

  it("round-trips a 0x22 fix in every hemisphere, with ACC and the re-upload flag", () => {
    for (const [lat, lng] of [
      [17.3688, 78.5247],
      [-33.8688, 151.2093],
      [40.7128, -74.006],
      [-22.9068, -43.1729],
    ] as const) {
      const bytes = encodeLocation(
        {
          recordedAt: "2026-10-06T02:30:05.000Z",
          lat,
          lng,
          speedKmh: 34,
          headingDeg: 271,
          acc: false,
          reupload: true,
        },
        77,
      );
      const [f] = ok(new FrameReader().push(bytes));
      const m = decode(f!);
      if (m.kind !== "location") throw new Error("not a location");
      expect(m.fix.lat).toBeCloseTo(lat, 5);
      expect(m.fix.lng).toBeCloseTo(lng, 5);
      expect(m.fix).toMatchObject({
        recordedAt: "2026-10-06T02:30:05.000Z",
        speedKmh: 34,
        headingDeg: 271,
        acc: false,
        reupload: true,
        positioned: true,
      });
    }
  });

  it("decodes the heartbeat's ACC bit, and the IMEI of a login it built", () => {
    const [on] = ok(new FrameReader().push(encodeStatus(true, 5)));
    expect(decode(on!)).toMatchObject({ kind: "status", acc: true, serial: 5 });
    const [off] = ok(new FrameReader().push(encodeStatus(false, 6)));
    expect(decode(off!)).toMatchObject({ kind: "status", acc: false });
    const [l] = ok(new FrameReader().push(encodeLogin("868120301234567", 9)));
    expect(decode(l!)).toEqual({ kind: "login", imei: "868120301234567", serial: 9 });
  });
});

describe("FrameReader (TCP gives arbitrary chunks)", () => {
  it("reassembles a frame split byte by byte, and splits two frames in one chunk", () => {
    const r = new FrameReader();
    const got: Frame[] = [];
    for (const b of LOCATION) got.push(...r.push(Uint8Array.of(b)));
    expect(ok(got)).toHaveLength(1);
    const both = new Uint8Array([...LOGIN, ...LOCATION]);
    expect(ok(new FrameReader().push(both)).map((f) => f.protocol)).toEqual([0x01, 0x12]);
  });

  it("skips line noise, drops a frame with a bad CRC, and recovers for the next", () => {
    const bad = LOGIN.slice();
    bad[5] = bad[5]! ^ 0xff;
    const r = new FrameReader();
    const got = r.push(new Uint8Array([0x00, 0x13, 0x55, ...bad, 0xaa, ...LOCATION]));
    expect(got.filter((f) => !f.ok).length).toBeGreaterThan(0);
    expect(ok(got).map((f) => f.protocol)).toEqual([0x12]);
  });

  it("resyncs after noise that looks like a start marker, without losing the next real frame", () => {
    // 78 78 0A … is a plausible header for a 10-byte frame that is not there
    const got = new FrameReader().push(
      new Uint8Array([0x78, 0x78, 0x0a, 0x01, 0x02, 0x03, ...LOGIN, ...LOCATION]),
    );
    expect(ok(got).map((f) => f.protocol)).toEqual([0x01, 0x12]);
  });

  it("skips an impossible length instead of waiting for ever", () => {
    const got = new FrameReader().push(new Uint8Array([0x78, 0x78, 0x02, ...LOGIN]));
    expect(got[0]).toEqual({ ok: false, reason: "short" });
    expect(ok(got).map((f) => f.protocol)).toEqual([0x01]);
  });
});
