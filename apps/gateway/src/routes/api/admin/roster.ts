import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { normalisePhone, parseRosterCsv } from "@busmitra/contracts";
import { withContext } from "@busmitra/db";
import { applyRoster, diffRoster, loadRoster, summarise } from "@busmitra/engine/roster";
import type { AppDeps } from "../../../app.ts";
import { contextOf, requireAdmin } from "../../../plugins/auth.ts";

/**
 * Roster import, two-phase (ARCH §10): upload → preview (nothing written to the roster)
 * → explicit apply. Apply re-reads the stored file and re-diffs against the roster as it
 * is *now*, so a preview left open overnight cannot apply a stale diff.
 */
export async function adminRosterRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook("preHandler", requireAdmin(deps));
  app.addContentTypeParser(
    ["text/csv", "text/plain"],
    { parseAs: "string", bodyLimit: 5 * 1024 * 1024 },
    (_r, body, done) => done(null, body),
  );

  app.post("/v1/admin/roster/uploads", async (req, reply) => {
    if (typeof req.body !== "string" || !req.body.trim()) {
      return reply.code(400).send({ error: "empty_file", message: "Upload a CSV file." });
    }
    const csv = req.body;
    const originalName = String(req.headers["x-filename"] ?? "roster.csv").slice(0, 200);
    const contentHash = createHash("sha256").update(csv).digest("hex");
    const { rows, errors } = parseRosterCsv(csv);
    const filePath = `roster/${randomUUID()}.csv`;
    await deps.files.put(filePath, csv, "text/csv");

    return withContext(deps.db, contextOf(req), async (q) => {
      const diff = errors.length ? null : diffRoster(await loadRoster(q), rows);
      const { rows: up } = await q.query<{ id: string; status: string }>(
        `INSERT INTO roster_uploads
           (kind, file_path, original_name, content_hash, row_count, status, diff_summary, error_log, uploaded_by)
         VALUES ('student_roster', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, status`,
        [
          filePath,
          originalName,
          contentHash,
          rows.length + new Set(errors.map((e) => e.row)).size,
          errors.length ? "rejected" : "preview_ready",
          diff ? JSON.stringify(summarise(diff)) : null,
          errors.length ? JSON.stringify(errors) : null,
          req.user!.id,
        ],
      );
      return {
        id: up[0]!.id,
        status: up[0]!.status,
        summary: diff && summarise(diff),
        diff,
        errors,
      };
    });
  });

  app.post("/v1/admin/roster/uploads/:id/apply", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return withContext(deps.db, contextOf(req), async (q) => {
      const { rows } = await q.query<{ status: string; file_path: string; content_hash: string }>(
        `SELECT status, file_path, content_hash FROM roster_uploads WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const up = rows[0];
      if (!up) return reply.code(404).send({ error: "not_found", message: "No such upload." });
      if (up.status !== "preview_ready") {
        return reply
          .code(409)
          .send({ error: "not_applicable", message: `Upload is ${up.status}; nothing to apply.` });
      }
      const csv = await deps.files.get(up.file_path);
      if (createHash("sha256").update(csv).digest("hex") !== up.content_hash) {
        return reply
          .code(409)
          .send({ error: "file_changed", message: "Stored file does not match the preview." });
      }
      const diff = diffRoster(await loadRoster(q), parseRosterCsv(csv).rows);
      await applyRoster(q, id, diff);
      await q.query(
        `UPDATE roster_uploads SET status = 'applied', applied_by = $2, applied_at = now(), diff_summary = $3
          WHERE id = $1`,
        [id, req.user!.id, JSON.stringify(summarise(diff))],
      );
      return { id, status: "applied", summary: summarise(diff) };
    });
  });

  /** The work queue: roster rows that cannot be claimed until the TD supplies a phone. */
  app.get("/v1/admin/roster/missing-phone", async () => {
    const { rows } = await deps.db.query(
      `SELECT roll_no, full_name, admission_year, branch FROM roster_students
        WHERE phone_e164 IS NULL AND claimed_at IS NULL ORDER BY roll_no`,
    );
    return { students: rows };
  });

  /**
   * Explicit removal (uploads never delete — engine/roster.ts). Only an unclaimed row: removing a
   * claimed student would orphan their account, which is a different, deliberate operation.
   */
  app.delete("/v1/admin/roster/students/:rollNo", async (req, reply) => {
    const { rollNo } = z.object({ rollNo: z.string().min(1) }).parse(req.params);
    return withContext(deps.db, contextOf(req), async (q) => {
      const { rows } = await q.query<{ claimed: boolean }>(
        `SELECT claimed_at IS NOT NULL AS claimed FROM roster_students WHERE roll_no = upper($1)`,
        [rollNo],
      );
      if (!rows[0])
        return reply.code(404).send({ error: "not_found", message: "No such student." });
      if (rows[0].claimed)
        return reply.code(409).send({
          error: "claimed",
          message:
            "This student has claimed their account; it cannot be removed from the roster here.",
        });
      await q.query(
        `DELETE FROM roster_students WHERE roll_no = upper($1) AND claimed_at IS NULL`,
        [rollNo],
      );
      return { roll_no: rollNo.toUpperCase(), removed: true };
    });
  });

  app.patch("/v1/admin/roster/students/:rollNo", async (req, reply) => {
    const { rollNo } = z.object({ rollNo: z.string().min(1) }).parse(req.params);
    const { phone } = z.object({ phone: z.string() }).parse(req.body);
    const e164 = normalisePhone(phone);
    if (!e164)
      return reply
        .code(400)
        .send({ error: "invalid_phone", message: "Not a valid Indian mobile number." });
    return withContext(deps.db, contextOf(req), async (q) => {
      const { rows } = await q.query(
        `UPDATE roster_students SET phone_e164 = $2 WHERE roll_no = upper($1) AND claimed_at IS NULL RETURNING roll_no`,
        [rollNo, e164],
      );
      if (!rows[0])
        return reply
          .code(404)
          .send({ error: "not_found", message: "No unclaimed student with that roll number." });
      return { roll_no: rows[0].roll_no, phone_e164: e164 };
    });
  });
}
