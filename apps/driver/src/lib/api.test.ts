import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signingPayload } from "@busmitra/contracts/signing";
import { hmacHex, NetworkError, parsePairing, signedClient } from "./api.ts";

describe("hmacHex (WebCrypto)", () => {
  it("matches the gateway's node:crypto HMAC byte for byte", async () => {
    const msg = signingPayload("sim-01", "1758506400", '{"pings":[1,2,3]}');
    const secret = "Zm9vYmFyYmF6cXV4LXNlY3JldC0zMi1ieXRlcw";
    expect(await hmacHex(secret, msg)).toBe(createHmac("sha256", secret).update(msg).digest("hex"));
  });
});

describe("parsePairing", () => {
  it("reads #pair=<uid>.<secret>, including uids with dashes and encoded characters", () => {
    expect(parsePairing("#pair=phone-14-a1b2c3.s3cr3t_-x")).toEqual({
      deviceUid: "phone-14-a1b2c3",
      secret: "s3cr3t_-x",
    });
    expect(parsePairing("#x=1&pair=bus%2014.abc")).toEqual({ deviceUid: "bus 14", secret: "abc" });
  });

  it("rejects anything else", () => {
    for (const h of ["", "#pair=", "#pair=nodot", "#pair=.secret", "#pair=uid."])
      expect(parsePairing(h)).toBeNull();
  });
});

describe("signedClient", () => {
  it("signs each request with a strictly increasing timestamp over the exact body sent", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
    const c = signedClient(
      "http://gw",
      { deviceUid: "d1", secret: "sec" },
      { fetch: fake, now: () => 1_758_506_400_000 },
    );
    await c.request("POST", "/v1/ingest", { a: 1 });
    await c.request("GET", "/v1/tracker/me");
    const h = (i: number) => calls[i]!.init.headers as Record<string, string>;
    expect(Number(h(1)["x-timestamp"])).toBe(Number(h(0)["x-timestamp"]) + 1);
    const expected = createHmac("sha256", "sec")
      .update(signingPayload("d1", h(0)["x-timestamp"]!, '{"a":1}'))
      .digest("hex");
    expect(h(0)["x-signature"]).toBe(expected);
    expect(h(1)["content-type"]).toBeUndefined();
    expect(calls[1]!.init.body).toBeUndefined();
  });

  it("turns a failed fetch into a NetworkError, and probes /healthz", async () => {
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    const c = signedClient("http://gw", { deviceUid: "d", secret: "s" }, { fetch: down });
    await expect(c.request("GET", "/x")).rejects.toBeInstanceOf(NetworkError);
    expect(await c.probe()).toBe(false);
    const up = (async () => new Response("{}", { status: 200 })) as typeof fetch;
    expect(
      await signedClient("http://gw", { deviceUid: "d", secret: "s" }, { fetch: up }).probe(),
    ).toBe(true);
  });
});
