import { describe, expect, it, vi } from "vitest";
import { SmsError, createConsoleSms, createMsg91Sms } from "./sms.ts";

describe("console SMS", () => {
  it("prints the destination and variables", async () => {
    const log = vi.fn();
    await createConsoleSms(log).send({
      to: "+919999900001",
      template: "otp",
      vars: { otp: "123456" },
    });
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('to=+919999900001 template=otp {"otp":"123456"}'),
    );
  });
});

describe("MSG91 SMS", () => {
  const ok = () => new Response('{"type":"success","message":"x"}', { status: 200 });

  it("posts the flow template with the number in MSG91's format", async () => {
    const fetch = vi.fn(async () => ok());
    const sms = createMsg91Sms({ authKey: "k", templateIds: { otp: "tmpl-otp" }, fetch });
    await sms.send({ to: "+919999900001", template: "otp", vars: { otp: "123456" } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://control.msg91.com/api/v5/flow");
    expect((init.headers as Record<string, string>).authkey).toBe("k");
    expect(JSON.parse(init.body as string)).toEqual({
      template_id: "tmpl-otp",
      short_url: "0",
      recipients: [{ mobiles: "919999900001", otp: "123456" }],
    });
  });

  it("treats a 200 with an error body as a failure", async () => {
    const fetch = vi.fn(
      async () => new Response('{"type":"error","message":"template not approved"}'),
    );
    const sms = createMsg91Sms({ authKey: "k", templateIds: { otp: "t" }, fetch });
    await expect(
      sms.send({ to: "+919999900001", template: "otp", vars: {} }),
    ).rejects.toBeInstanceOf(SmsError);
  });

  it("surfaces HTTP failures", async () => {
    const fetch = vi.fn(async () => new Response("unauthorised", { status: 401 }));
    const sms = createMsg91Sms({ authKey: "k", templateIds: { otp: "t" }, fetch });
    await expect(sms.send({ to: "+919999900001", template: "otp", vars: {} })).rejects.toThrow(
      /HTTP 401/,
    );
  });
});
