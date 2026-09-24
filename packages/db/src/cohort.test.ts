import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedStudent, type TestDb } from "./testing/index.ts";

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(() => db.close());

const derive = async (year: number, asOf: string) =>
  (await db.query<{ c: string }>("SELECT derive_cohort($1::smallint, $2::date) c", [year, asOf]))
    .rows[0]!.c;

describe("derive_cohort — academic year starts 1 August, first-years are juniors (pending TD)", () => {
  it("keeps a 2025 admit junior on the last day of their first year", async () => {
    expect(await derive(2025, "2026-07-31")).toBe("junior");
  });
  it("makes the same student senior on 1 August", async () => {
    expect(await derive(2025, "2026-08-01")).toBe("senior");
  });
  it("treats a student admitted this calendar year before term as junior", async () => {
    expect(await derive(2026, "2026-07-15")).toBe("junior");
    expect(await derive(2026, "2026-08-01")).toBe("junior");
  });
  it("crosses the calendar-year boundary without flipping", async () => {
    expect(await derive(2026, "2026-12-31")).toBe("junior");
    expect(await derive(2026, "2027-01-01")).toBe("junior");
    expect(await derive(2026, "2027-08-01")).toBe("senior");
  });
  it("accepts a different rule without code changes", async () => {
    const { rows } = await db.query<{ c: string }>(
      "SELECT derive_cohort(2025::smallint, '2026-08-01', 6, 2) c",
    );
    expect(rows[0]!.c).toBe("junior");
  });
});

describe("promote_cohorts", () => {
  it("promotes roster and profile together on the boundary, and is idempotent", async () => {
    const { userId } = await seedStudent(db, { rollNo: "P1", admissionYear: 2025 });
    await db.query(
      `UPDATE roster_students SET cohort = derive_cohort(2025::smallint, '2026-07-31')`,
    );
    await db.query(`UPDATE profiles SET cohort = 'junior'`);

    expect(
      (await db.query<{ n: number }>("SELECT promote_cohorts('2026-07-31') n")).rows[0]!.n,
    ).toBe(0);
    expect(
      (await db.query<{ n: number }>("SELECT promote_cohorts('2026-08-01') n")).rows[0]!.n,
    ).toBe(1);
    expect(
      (await db.query<{ n: number }>("SELECT promote_cohorts('2026-08-01') n")).rows[0]!.n,
    ).toBe(0);

    const p = await db.query<{ cohort: string }>("SELECT cohort FROM profiles WHERE id = $1", [
      userId,
    ]);
    expect(p.rows[0]!.cohort).toBe("senior");
  });
});
