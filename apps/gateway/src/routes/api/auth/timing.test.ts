import { seedStudent } from "@busmitra/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestGateway } from "../../../testing.ts";

/**
 * ADR-0006: a roll number on the roster must not be distinguishable from one that is not
 * by response *time* either. Both paths do the same queries plus one bcrypt; the SMS send is
 * fire-and-forget. Assert the medians stay within a margin far below bcrypt's own cost, which
 * is the step an attacker would need to see skipped.
 */
type Gw = Awaited<ReturnType<typeof createTestGateway>>;
let gw: Gw;
const N = 20;

beforeAll(async () => {
  gw = await createTestGateway();
  for (let i = 0; i < N; i++) {
    await seedStudent(gw.db, {
      rollNo: `1601257380${String(i).padStart(2, "0")}`,
      claimed: false,
      phone: `+9199999${String(10000 + i)}`,
    });
  }
});
afterAll(() => gw.db.close());

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function timeStart(roll: string, i: number): Promise<number> {
  const t0 = performance.now();
  const res = await gw.app.inject({
    method: "POST",
    url: "/v1/auth/claim/start",
    payload: { roll_no: roll },
    remoteAddress: `10.9.${i}.1`,
  });
  const dt = performance.now() - t0;
  expect(res.statusCode).toBe(200);
  return dt;
}

describe("claim start timing", () => {
  it("does not separate real from fake roll numbers", async () => {
    const real: number[] = [];
    const fake: number[] = [];
    await timeStart("WARMUP0001", 250); // first bcrypt/JIT warm-up is not a sample
    for (let i = 0; i < N; i++) {
      // interleave so drift (GC, JIT, the host) hits both populations equally
      real.push(await timeStart(`1601257380${String(i).padStart(2, "0")}`, i));
      fake.push(await timeStart(`9990000000${String(i).padStart(2, "0")}`, 100 + i));
    }
    const [mr, mf] = [median(real), median(fake)];
    const bcryptCost = Math.min(mr, mf); // one bcrypt(10) dominates both
    console.info(`claim/start median: real ${mr.toFixed(1)} ms, fake ${mf.toFixed(1)} ms`);
    // skipping the bcrypt would halve the time or more; allow ≤ 25% difference
    expect(Math.abs(mr - mf)).toBeLessThan(bcryptCost * 0.25);
  });
});
