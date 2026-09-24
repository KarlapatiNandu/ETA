import { parseRosterCsv } from "@busmitra/contracts";
import { withContext } from "@busmitra/db";
import { createTestDb, seedStudent, type TestDb } from "@busmitra/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyRoster, diffRoster, loadRoster, summarise } from "./roster.ts";

const csv = (lines: string[]) =>
  parseRosterCsv(["roll_no,name,admission_year,phone,branch", ...lines].join("\n")).rows;

describe("diffRoster", () => {
  const existing = [
    {
      roll_no: "R000A1",
      full_name: "Asha",
      admission_year: 2025,
      phone_e164: "+919999900001",
      branch: "IT",
      claimed: true,
    },
    {
      roll_no: "R000B2",
      full_name: "Ravi",
      admission_year: 2025,
      phone_e164: null,
      branch: "IT",
      claimed: false,
    },
    {
      roll_no: "R000C3",
      full_name: "Gone",
      admission_year: 2024,
      phone_e164: null,
      branch: null,
      claimed: false,
    },
  ];

  it("classifies added / changed / removed / unchanged", () => {
    const d = diffRoster(
      existing,
      csv(["R000A1,Asha,2025,9999900001,IT", "R000B2,Ravi Kumar,2025,,IT", "R000D4,New,2026,,CSE"]),
    );
    expect(summarise(d)).toEqual({
      added: 1,
      changed: 1,
      removed: 1,
      unchanged: 1,
      missing_phone: 2,
    });
    expect(d.changed[0]).toEqual({
      roll_no: "R000B2",
      claimed: false,
      fields: { full_name: { from: "Ravi", to: "Ravi Kumar" } },
    });
    expect(d.removed).toEqual([{ roll_no: "R000C3", claimed: false }]);
  });

  it("never lets a blank phone in the file erase a known one", () => {
    const d = diffRoster(existing, csv(["R000A1,Asha,2025,,IT"]));
    expect(d.changed).toEqual([]);
    expect(d.unchanged).toBe(1);
  });

  it("is empty for an identical re-upload", () => {
    const d = diffRoster(
      existing,
      csv(["R000A1,Asha,2025,9999900001,IT", "R000B2,Ravi,2025,,IT", "R000C3,Gone,2024,,"]),
    );
    expect(summarise(d)).toMatchObject({ added: 0, changed: 0, removed: 0, unchanged: 3 });
  });
});

describe("applyRoster", () => {
  let db: TestDb;
  let admin: string;
  beforeAll(async () => {
    db = await createTestDb();
    admin = (await seedStudent(db, { rollNo: "TDADMIN01", role: "td_admin" })).userId!;
  });
  afterAll(() => db.close());

  it("imports phone-less rows, recomputes cohort on a year change, deletes nothing, audits all", async () => {
    await seedStudent(db, { rollNo: "OLD01", admissionYear: 2020, claimed: false });
    const { rows: up } = await db.query<{ id: string }>(
      `INSERT INTO roster_uploads (kind, file_path, original_name, content_hash, uploaded_by)
       VALUES ('student_roster', 'x', 'r.csv', 'h', $1) RETURNING id`,
      [admin],
    );
    const incoming = csv(["NEW01,Nisha,2026,,IT", "TDADMIN01,Test TDADMIN01,2026,9999900001,"]);
    const ctx = { actorId: admin, ip: "10.0.0.1", userAgent: "vitest" };
    const diff = await withContext(db, ctx, async (q) => {
      const d = diffRoster(await loadRoster(q), incoming);
      await applyRoster(q, up[0]!.id, d);
      return d;
    });
    expect(summarise(diff)).toMatchObject({ added: 1, changed: 1, removed: 1 });

    const { rows } = await db.query<{ roll_no: string; phone_e164: string | null; cohort: string }>(
      "SELECT roll_no, phone_e164, cohort FROM roster_students ORDER BY roll_no",
    );
    expect(rows.map((r) => r.roll_no)).toEqual(["NEW01", "OLD01", "TDADMIN01"]);
    expect(rows.find((r) => r.roll_no === "NEW01")!.phone_e164).toBeNull();
    // admission year moved 2025 → 2026: cohort follows the NEW year, on roster and profile
    const expected = (
      await db.query<{ c: string }>("SELECT derive_cohort(2026::smallint, operating_date()) c")
    ).rows[0]!.c;
    expect(rows.find((r) => r.roll_no === "TDADMIN01")!.cohort).toBe(expected);
    const prof = await db.query<{ cohort: string }>("SELECT cohort FROM profiles WHERE id = $1", [
      admin,
    ]);
    expect(prof.rows[0]!.cohort).toBe(expected);

    const audit = await db.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_log WHERE entity = 'roster_students' AND actor_id = $1 AND host(ip) = '10.0.0.1'`,
      [admin],
    );
    expect(audit.rows[0]!.n).toBe(2);
  });
});
