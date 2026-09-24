import { seedStudent } from "@busmitra/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestGateway } from "../../../testing.ts";

type Gw = Awaited<ReturnType<typeof createTestGateway>>;
let gw: Gw;
let adminToken: string, studentToken: string;

const CSV = [
  "Roll No,Name,Admission Year,Mobile,Branch",
  "160125737201,Asha K,2025,9999900201,IT",
  "160125737202,Ravi P,2025,,IT",
].join("\n");

const upload = (token: string | null, body = CSV) =>
  gw.app.inject({
    method: "POST",
    url: "/v1/admin/roster/uploads",
    payload: body,
    headers: {
      "content-type": "text/csv",
      "x-filename": "roster.csv",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });

beforeAll(async () => {
  gw = await createTestGateway();
  adminToken = await gw.tokenFor(
    (await seedStudent(gw.db, { rollNo: "TDADMIN01", role: "td_admin" })).userId!,
  );
  studentToken = await gw.tokenFor((await seedStudent(gw.db, { rollNo: "STUDENT01" })).userId!);
});
afterAll(() => gw.db.close());

describe("admin surfaces", () => {
  it("answer 404 — not 403, not a redirect — to students and anonymous callers", async () => {
    for (const token of [studentToken, null, "not-a-jwt"]) {
      const res = await upload(token);
      expect(res.statusCode).toBe(404);
    }
    const q = await gw.app.inject({
      method: "GET",
      url: "/v1/admin/roster/missing-phone",
      headers: { authorization: `Bearer ${studentToken}` },
    });
    expect(q.statusCode).toBe(404);
  });
});

describe("roster import", () => {
  it("previews without writing, then applies on confirm", async () => {
    const preview = await upload(adminToken);
    expect(preview.statusCode).toBe(200);
    const body = preview.json();
    expect(body.status).toBe("preview_ready");
    expect(body.summary).toMatchObject({ added: 2, changed: 0, missing_phone: 1 });
    const before = await gw.db.query(
      `SELECT 1 FROM roster_students WHERE roll_no LIKE '1601257372%'`,
    );
    expect(before.rows).toHaveLength(0); // preview wrote nothing to the roster

    const apply = await gw.app.inject({
      method: "POST",
      url: `/v1/admin/roster/uploads/${body.id}/apply`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(apply.statusCode).toBe(200);
    const after = await gw.db.query(
      `SELECT roll_no FROM roster_students WHERE roll_no LIKE '1601257372%'`,
    );
    expect(after.rows).toHaveLength(2);

    const again = await gw.app.inject({
      method: "POST",
      url: `/v1/admin/roster/uploads/${body.id}/apply`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(again.statusCode).toBe(409); // applying twice is refused
  });

  it("shows an identical re-upload as all-unchanged", async () => {
    const res = (await upload(adminToken)).json();
    expect(res.summary).toMatchObject({ added: 0, changed: 0, unchanged: 2 });
  });

  it("rejects a malformed file at preview with per-row, per-column errors and cannot be applied", async () => {
    const res = await upload(adminToken, "roll_no,name,admission_year\n160125737301,,20x5\n");
    const body = res.json();
    expect(body.status).toBe("rejected");
    expect(body.errors).toEqual([
      { row: 2, column: "full_name", message: "is required" },
      { row: 2, column: "admission_year", message: "must be a year" },
    ]);
    const apply = await gw.app.inject({
      method: "POST",
      url: `/v1/admin/roster/uploads/${body.id}/apply`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(apply.statusCode).toBe(409);
  });

  it("lists phone-less students in the work queue and lets the TD fill them in", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const queue = await gw.app.inject({
      method: "GET",
      url: "/v1/admin/roster/missing-phone",
      headers: auth,
    });
    expect(queue.json().students.map((s: { roll_no: string }) => s.roll_no)).toEqual([
      "160125737202",
    ]);

    const bad = await gw.app.inject({
      method: "PATCH",
      url: "/v1/admin/roster/students/160125737202",
      headers: auth,
      payload: { phone: "12345" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await gw.app.inject({
      method: "PATCH",
      url: "/v1/admin/roster/students/160125737202",
      headers: auth,
      payload: { phone: "99999 00202" },
    });
    expect(ok.json()).toEqual({ roll_no: "160125737202", phone_e164: "+919999900202" });

    const audit = await gw.db.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_log a JOIN profiles p ON p.id = a.actor_id
        WHERE p.roll_no = 'TDADMIN01' AND a.entity = 'roster_students'`,
    );
    expect(audit.rows[0]!.n).toBeGreaterThanOrEqual(3); // 2 inserts + the phone fix
  });

  it("removes an unclaimed student explicitly, never a claimed one", async () => {
    const auth = { authorization: `Bearer ${adminToken}` };
    const del = (roll: string) =>
      gw.app.inject({ method: "DELETE", url: `/v1/admin/roster/students/${roll}`, headers: auth });
    expect((await del("160125737201")).json()).toEqual({ roll_no: "160125737201", removed: true });
    expect((await del("160125737201")).statusCode).toBe(404);
    expect((await del("STUDENT01")).statusCode).toBe(409); // claimed: would orphan the account
    const audit = await gw.db.query<{ n: number }>(
      `SELECT count(*)::int n FROM audit_log WHERE action = 'roster_students.delete'`,
    );
    expect(audit.rows[0]!.n).toBe(1);
  });
});
