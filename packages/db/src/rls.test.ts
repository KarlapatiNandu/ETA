import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, seedStudent, type TestDb } from "./testing/index.ts";

/**
 * RLS is the security boundary (BUILD_PLAN Stage 4 "Test explicitly"). Cross-user reads must
 * return zero rows, never an error — an error leaks that the row exists.
 */

/** Tables that are deliberately service-role only: RLS on, zero policies. */
const SERVICE_ONLY = new Set(["claim_challenges"]);

let db: TestDb;
let a: string, b: string, admin: string;

beforeAll(async () => {
  db = await createTestDb();
  a = (await seedStudent(db, { rollNo: "160125737001" })).userId!;
  b = (await seedStudent(db, { rollNo: "160125737002", phone: "+919999900002" })).userId!;
  admin = (await seedStudent(db, { rollNo: "TDADMIN01", role: "td_admin", phone: "+919999900099" }))
    .userId!;
  await seedStudent(db, { rollNo: "160125737003", claimed: false });
});
afterAll(() => db.close());

describe("coverage", () => {
  it("has RLS enabled on 100% of application tables", async () => {
    // extension-owned tables (PostGIS spatial_ref_sys) are excluded: not ours, no user data
    const { rows } = await db.query<{
      tablename: string;
      rowsecurity: boolean;
      policies: number;
      partition: boolean;
    }>(`
      SELECT c.relname AS tablename, c.relrowsecurity AS rowsecurity, c.relispartition AS partition,
             (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')`);
    expect(rows.length).toBeGreaterThanOrEqual(14);
    expect(rows.filter((r) => !r.rowsecurity).map((r) => r.tablename)).toEqual([]);
    // partitions are reached only through their parent's policies (see below)
    const policyless = rows.filter((r) => r.policies === 0 && !r.partition).map((r) => r.tablename);
    expect(policyless.filter((t) => !SERVICE_ONLY.has(t))).toEqual([]);
  });

  it("gives clients no privilege on any partition — reading one directly would bypass the parent's RLS", async () => {
    // count, not an array: node-pg returns information_schema's domain arrays as raw text
    const { rows } = await db.query<{ tablename: string; grants: number }>(`
      SELECT c.relname AS tablename,
             (SELECT count(*)::int FROM information_schema.role_table_grants g
               WHERE g.table_name = c.relname AND g.grantee IN ('anon','authenticated')) AS grants
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relispartition AND c.relkind = 'r'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.grants > 0)).toEqual([]);
    const part = rows[0]!.tablename;
    await expect(db.as(admin, (q) => q.query(`SELECT * FROM ${part}`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it("leaves service-only tables unreadable by any client role", async () => {
    await db.query(
      `INSERT INTO claim_challenges (roll_no, otp_hash, expires_at) VALUES ('X', 'h', now() + interval '10 min')`,
    );
    for (const who of [a, admin, null]) {
      await expect(db.as(who, (q) => q.query("SELECT * FROM claim_challenges"))).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});

describe("student A against student B", () => {
  it("sees only their own profile — B's row returns zero rows, not an error", async () => {
    const own = await db.as(a, (q) => q.query<{ id: string }>("SELECT id FROM profiles"));
    expect(own.rows.map((r) => r.id)).toEqual([a]);
    const other = await db.as(a, (q) => q.query("SELECT * FROM profiles WHERE id = $1", [b]));
    expect(other.rows).toEqual([]);
  });

  it("cannot update B's profile (silently affects zero rows)", async () => {
    const res = await db.as(a, (q) =>
      q.query("UPDATE profiles SET max_tier = 0 WHERE id = $1 RETURNING id", [b]),
    );
    expect(res.rows).toEqual([]);
  });

  it("can update own preferences", async () => {
    const res = await db.as(a, (q) =>
      q.query<{ max_tier: number }>(
        "UPDATE profiles SET max_tier = 2 WHERE id = $1 RETURNING max_tier",
        [a],
      ),
    );
    expect(res.rows).toEqual([{ max_tier: 2 }]);
  });

  it("cannot promote themselves, or rewrite roll number, cohort or phone", async () => {
    for (const col of [
      "role = 'super_admin'",
      "roll_no = 'X'",
      "cohort = 'senior'",
      "phone_e164 = '+911'",
    ]) {
      await expect(
        db.as(a, (q) => q.query(`UPDATE profiles SET ${col} WHERE id = $1`, [a])),
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("cannot read the roster (the student directory) — zero rows", async () => {
    const res = await db.as(a, (q) => q.query("SELECT * FROM roster_students"));
    expect(res.rows).toEqual([]);
  });

  it("cannot read uploads or the audit log", async () => {
    expect((await db.as(a, (q) => q.query("SELECT * FROM roster_uploads"))).rows).toEqual([]);
    expect((await db.as(a, (q) => q.query("SELECT * FROM audit_log"))).rows).toEqual([]);
  });

  it("cannot insert into the roster", async () => {
    await expect(
      db.as(a, (q) =>
        q.query(
          `INSERT INTO roster_students (roll_no, full_name, admission_year, cohort) VALUES ('Z', 'z', 2025, 'junior')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("anonymous", () => {
  it("has no access to anything", async () => {
    for (const t of [
      "profiles",
      "roster_students",
      "roster_uploads",
      "audit_log",
      "routes",
      "stops",
      "buses",
      "trackers",
      "trips",
      "positions",
      "route_surveys",
    ]) {
      await expect(db.as(null, (q) => q.query(`SELECT * FROM ${t}`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});

describe("TD admin", () => {
  it("reads every profile and the whole roster", async () => {
    const p = await db.as(admin, (q) => q.query("SELECT id FROM profiles"));
    expect(p.rows).toHaveLength(3);
    const r = await db.as(admin, (q) => q.query("SELECT roll_no FROM roster_students"));
    expect(r.rows).toHaveLength(4);
  });

  it("may not change anyone's role, including their own", async () => {
    await expect(
      db.as(admin, (q) => q.query(`UPDATE profiles SET role = 'super_admin' WHERE id = $1`, [a])),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot edit a student's preferences", async () => {
    const res = await db.as(admin, (q) =>
      q.query("UPDATE profiles SET max_tier = 0 WHERE id = $1 RETURNING id", [a]),
    );
    expect(res.rows).toEqual([]);
  });

  it("can fill a missing phone in the roster work queue", async () => {
    const res = await db.as(admin, (q) =>
      q.query<{ roll_no: string }>(
        `UPDATE roster_students SET phone_e164 = '+919999900003' WHERE roll_no = '160125737003' RETURNING roll_no`,
      ),
    );
    expect(res.rows).toHaveLength(1);
  });
});

describe("JWT role claim", () => {
  it("stamps user_role from profiles into the access token", async () => {
    const { rows } = await db.query<{ claims: { user_role: string } }>(
      `SELECT custom_access_token_hook(jsonb_build_object('user_id', $1::text, 'claims', '{}'::jsonb))->'claims' AS claims`,
      [admin],
    );
    expect(rows[0]!.claims.user_role).toBe("td_admin");
  });

  it("is not callable by clients", async () => {
    await expect(
      db.as(a, (q) => q.query(`SELECT custom_access_token_hook('{"user_id":null,"claims":{}}')`)),
    ).rejects.toThrow(/permission denied/);
  });
});
