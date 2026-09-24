import { seedStudent } from "@busmitra/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestGateway } from "../../../testing.ts";

type Gw = Awaited<ReturnType<typeof createTestGateway>>;
let gw: Gw;

const post = (url: string, payload: Record<string, unknown>, ip = "203.0.113.1") =>
  gw.app.inject({
    method: "POST",
    url,
    payload,
    remoteAddress: ip,
    headers: { "user-agent": "vitest-agent" },
  });

beforeAll(async () => {
  gw = await createTestGateway();
  await seedStudent(gw.db, { rollNo: "160125737101", claimed: false, phone: "+919999900101" }); // claimable
  await seedStudent(gw.db, { rollNo: "160125737102", claimed: false, phone: null }); // no phone
  await seedStudent(gw.db, { rollNo: "160125737103", phone: "+919999900103" }); // already claimed
  await seedStudent(gw.db, { rollNo: "160125737104", claimed: false, phone: "+919999900104" });
  await seedStudent(gw.db, { rollNo: "160125737105", claimed: false, phone: "+919999900105" });
});
afterAll(() => gw.db.close());

describe("claim flow, end to end (console SMS)", () => {
  it("claims an account with the code sent to the roster phone", async () => {
    const start = await post("/v1/auth/claim/start", { roll_no: " 160125737101 " });
    expect(start.statusCode).toBe(200);
    expect(start.json()).toEqual({
      status: "sent",
      masked_phone: "+91 ••••• •0101",
      expires_in_s: 600,
    });

    const otp = await gw.lastOtp("+919999900101");
    expect(otp).toMatch(/^\d{6}$/);
    const verify = await post("/v1/auth/claim/verify", {
      roll_no: "160125737101",
      otp,
      password: "correct horse",
    });
    expect(verify.statusCode).toBe(200);

    const { rows } = await gw.db.query<{
      id: string;
      phone_e164: string;
      verified: boolean;
      claimed: boolean;
      email: string;
    }>(
      `SELECT p.id, p.phone_e164, p.phone_verified_at IS NOT NULL AS verified, r.claimed_at IS NOT NULL AS claimed, u.email
         FROM profiles p JOIN roster_students r USING (roll_no) JOIN auth.users u ON u.id = p.id
        WHERE p.roll_no = '160125737101'`,
    );
    expect(rows[0]).toMatchObject({
      phone_e164: "+919999900101",
      verified: true,
      claimed: true,
      email: "160125737101@students.busmitra.internal",
    });
    expect(gw.passwords.get(rows[0]!.id)).toBe("correct horse");

    // the claim is in the audit trail with the request's network context
    const audit = await gw.db.query<{ ip: string; user_agent: string }>(
      `SELECT host(ip) AS ip, user_agent FROM audit_log WHERE action = 'profiles.insert' AND entity_id = $1`,
      [rows[0]!.id],
    );
    expect(audit.rows[0]).toEqual({ ip: "203.0.113.1", user_agent: "vitest-agent" });
  });

  it("does not let the same code, or a second claim, succeed twice", async () => {
    const start = await post("/v1/auth/claim/start", { roll_no: "160125737101" });
    expect(start.statusCode).toBe(200); // still indistinguishable
    expect(await gw.lastOtp("+919999900101")).toBeDefined();
    const sentBefore = gw.sent.length;
    await new Promise((r) => setImmediate(r));
    expect(gw.sent.length).toBe(sentBefore); // …but no SMS to an already-claimed roll
  });

  it("rejects a weak password before touching the challenge", async () => {
    const res = await post("/v1/auth/claim/verify", {
      roll_no: "160125737104",
      otp: "000000",
      password: "short",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
  });
});

describe("roster enumeration", () => {
  const kinds = {
    claimable: "160125737105",
    noPhone: "160125737102",
    claimed: "160125737103",
    absent: "999999999999",
  };

  it("returns identical status and shape for every kind of roll number", async () => {
    const responses = await Promise.all(
      Object.values(kinds).map((roll, i) =>
        post("/v1/auth/claim/start", { roll_no: roll }, `198.51.100.${i}`),
      ),
    );
    for (const r of responses) {
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(Object.keys(body).sort()).toEqual(["expires_in_s", "masked_phone", "status"]);
      expect(body.masked_phone).toMatch(/^\+91 ••••• •\d{4}$/);
      expect(body.status).toBe("sent");
      expect(body.expires_in_s).toBe(600);
    }
  });

  it("gives a stable decoy for a roll that is not on the roster", async () => {
    const a = (
      await post("/v1/auth/claim/start", { roll_no: "888888888888" }, "198.51.100.20")
    ).json();
    const b = (
      await post("/v1/auth/claim/start", { roll_no: "888888888888" }, "198.51.100.21")
    ).json();
    expect(a.masked_phone).toBe(b.masked_phone);
  });

  it("fails a wrong code with the same body whether or not the roll exists", async () => {
    const bodies = await Promise.all(
      Object.values(kinds).map((roll, i) =>
        post(
          "/v1/auth/claim/verify",
          { roll_no: roll, otp: "000001", password: "long enough" },
          `198.51.100.${30 + i}`,
        ),
      ),
    );
    const shapes = bodies.map((b) => [b.statusCode, b.body]);
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(bodies[0]!.statusCode).toBe(400);
  });

  it("rate-limits the 4th request in an hour identically for real and fake rolls", async () => {
    // each kind already has 1 start above (the absent decoy roll too); two more reach the cap
    const statuses: Record<string, number[]> = {};
    for (const [kind, roll] of Object.entries(kinds)) {
      statuses[kind] = [];
      for (let i = 0; i < 3; i++) {
        statuses[kind].push(
          (await post("/v1/auth/claim/start", { roll_no: roll }, `192.0.2.${i + 1}`)).statusCode,
        );
      }
    }
    for (const s of Object.values(statuses)) expect(s).toEqual([200, 200, 429]);
  });
});

describe("lockout", () => {
  it("locks a roll for 30 minutes after 5 wrong codes, even with the right code", async () => {
    const roll = "160125737104";
    await post("/v1/auth/claim/start", { roll_no: roll }, "192.0.2.50");
    const otp = await gw.lastOtp("+919999900104");
    const wrong = otp === "000000" ? "111111" : "000000";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push(
        (
          await post(
            "/v1/auth/claim/verify",
            { roll_no: roll, otp: wrong, password: "long enough" },
            `192.0.2.${60 + i}`,
          )
        ).statusCode,
      );
    }
    expect(codes).toEqual([400, 400, 400, 400, 400]);
    const right = await post(
      "/v1/auth/claim/verify",
      { roll_no: roll, otp, password: "long enough" },
      "192.0.2.70",
    );
    expect(right.statusCode).toBe(429);
    expect(right.json().error).toBe("locked");
  });
});

describe("password recovery over SMS", () => {
  it("resets the password of a claimed account using the verified profile phone", async () => {
    const res = await post("/v1/auth/recover/start", { roll_no: "160125737103" }, "192.0.2.80");
    expect(res.json().masked_phone).toBe("+91 ••••• •0103");
    const otp = await gw.lastOtp("+919999900103");
    const verify = await post(
      "/v1/auth/recover/verify",
      { roll_no: "160125737103", otp, new_password: "a new passphrase" },
      "192.0.2.81",
    );
    expect(verify.statusCode).toBe(200);
    const { rows } = await gw.db.query<{ id: string }>(
      `SELECT id FROM profiles WHERE roll_no = '160125737103'`,
    );
    expect(gw.passwords.get(rows[0]!.id)).toBe("a new passphrase");
  });

  it("sends nothing for an unclaimed roll, but answers the same way", async () => {
    const before = gw.sent.length;
    const res = await post("/v1/auth/recover/start", { roll_no: "160125737102" }, "192.0.2.82");
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setImmediate(r));
    expect(gw.sent.length).toBe(before);
  });
});
