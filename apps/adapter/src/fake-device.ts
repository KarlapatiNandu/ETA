import { connect, type Socket } from "node:net";
import { encodeLocation, encodeLogin, encodeStatus, FrameReader, PROTO, type Fix } from "./gt06.ts";

/**
 * A GT06 tracker in software: the same bytes a Concox unit sends, over a real TCP socket. The
 * adapter's tests and `pnpm sim hardware` drive it; the Stage 9 exit ("validated against one
 * physical tracker") is the same test with the real box instead.
 */
export class FakeGt06 {
  private socket!: Socket;
  private serial = 1;
  private readonly reader = new FrameReader();
  /** acknowledgements received, by protocol number */
  readonly acks: number[] = [];

  async connect(port: number, host = "127.0.0.1"): Promise<void> {
    this.socket = connect(port, host);
    this.socket.on("data", (c) => {
      for (const f of this.reader.push(c)) if (f.ok) this.acks.push(f.protocol);
    });
    await new Promise<void>((ok, fail) => {
      this.socket.once("connect", () => ok());
      this.socket.once("error", fail);
    });
  }

  get closed(): boolean {
    return this.socket.destroyed;
  }

  private send(bytes: Uint8Array) {
    this.socket.write(bytes);
    this.serial = (this.serial + 1) & 0xffff;
  }

  login(imei: string) {
    this.send(encodeLogin(imei, this.serial));
  }

  status(acc: boolean) {
    this.send(encodeStatus(acc, this.serial));
  }

  fix(
    f: Pick<Fix, "recordedAt" | "lat" | "lng" | "speedKmh" | "headingDeg"> & {
      acc?: boolean;
      reupload?: boolean;
    },
  ) {
    this.send(encodeLocation(f, this.serial, PROTO.LOCATION_2018));
  }

  /** raw bytes, for the fuzz-ish tests (split frames, garbage, a bad CRC) */
  raw(bytes: Uint8Array) {
    this.socket.write(bytes);
  }

  async waitForAcks(n: number, ms = 5000) {
    const until = Date.now() + ms;
    while (this.acks.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  }

  close() {
    this.socket.end();
  }
}
