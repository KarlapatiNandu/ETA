import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Confirmation,
  EventDayUploadParams,
  parseEventDayCsv,
  type Cohort,
} from "@busmitra/contracts";
import { withContext, type Queryable } from "@busmitra/db";
import { countAudience } from "@busmitra/engine/audience";
import {
  applyEventDay,
  diffEventDay,
  loadEventDay,
  resolveEventDay,
  summariseEventDay,
} from "@busmitra/engine/event-day";
import type { AppDeps } from "../../../app.ts";
import { contextOf, requireAdmin } from "../../../plugins/auth.ts";
import { checkConfirmation, conflict, Id, iso, notFound, ring } from "./common.ts";

/**
 * Event-day bus lists (BUILD_PLAN Stage 7): drop a CSV → parse → validate bus numbers and
 * routes against the database → rendered diff (added / changed / removed / unchanged) and the
 * number of students it will notify → explicit confirm → apply → a cohort-segmented T2.
 *
 * Nothing is written to `event_day_buses` and nobody is notified until apply. A file with any
 * error is rejected whole. Re-uploading the same content (`content_hash`) says so in the
 * preview, and applying it changes nothing and notifies nobody: only cohorts whose list
 * actually changed are told (ARCH §1 failure mode 4, SCHEMA §7).
 */

async function preview(q: Queryable, csv: string, date: string, cohort: Cohort | "both") {
  const parsed = parseEventDayCsv(csv, cohort);
  if (parsed.errors.length) return { errors: parsed.errors, warnings: [], rows: [], diff: null };
  const resolved = await resolveEventDay(q, parsed.rows);
  if (resolved.errors.length)
    return { errors: resolved.errors, warnings: resolved.warnings, rows: [], diff: null };
  const diff = diffEventDay(await loadEventDay(q, date), resolved.rows);
  return { errors: [], warnings: resolved.warnings, rows: resolved.rows, diff };
}

const notifyCount = (q: Queryable, cohorts: Cohort[]) =>
  cohorts.length ? countAudience(q, { kind: "cohorts", cohorts }) : Promise.resolve(0);

export async function adminEventDayRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook("preHandler", requireAdmin(deps));
  app.addContentTypeParser(
    ["text/csv", "text/plain"],
    { parseAs: "string", bodyLimit: 1024 * 1024 },
    (_r, body, done) => done(null, body),
  );

  /** The list students currently have for a date. */
  app.get("/v1/admin/event-day", async (req) => {
    const { date } = z.object({ date: z.iso.date() }).parse(req.query);
    const uploads = await deps.db.query(
      `SELECT u.id, u.original_name, u.status, u.applied_at, u.created_at, p.full_name AS uploaded_name,
              u.diff_summary
         FROM roster_uploads u JOIN profiles p ON p.id = u.uploaded_by
        WHERE u.kind = 'event_day_buses' AND u.service_date = $1::date
        ORDER BY u.created_at DESC LIMIT 20`,
      [date],
    );
    return { date, buses: await loadEventDay(deps.db, date), uploads: uploads.rows };
  });

  app.post("/v1/admin/event-day/uploads", async (req, reply) => {
    const params = EventDayUploadParams.parse(req.query);
    if (typeof req.body !== "string" || !req.body.trim()) {
      return reply.code(400).send({ error: "empty_file", message: "Upload a CSV file." });
    }
    const csv = req.body;
    const originalName = String(req.headers["x-filename"] ?? "event-day.csv").slice(0, 200);
    const contentHash = createHash("sha256").update(csv).digest("hex");
    const p = await preview(deps.db, csv, params.service_date, params.cohort);
    const notify = p.diff ? await notifyCount(deps.db, p.diff.notify_cohorts) : 0;
    const same = await deps.db.query<{ id: string; applied_at: Date }>(
      `SELECT id, applied_at FROM roster_uploads
        WHERE kind = 'event_day_buses' AND service_date = $1::date AND content_hash = $2
          AND status = 'applied'
        ORDER BY applied_at DESC LIMIT 1`,
      [params.service_date, contentHash],
    );
    const filePath = `event-day/${params.service_date}/${randomUUID()}.csv`;
    await deps.files.put(filePath, csv, "text/csv");
    const rejected = p.errors.length > 0;
    const summary = p.diff ? { ...summariseEventDay(p.diff), notify_count: notify } : null;
    const up = await withContext(deps.db, contextOf(req), (q) =>
      q.query<{ id: string }>(
        `INSERT INTO roster_uploads (kind, service_date, cohort, file_path, original_name, content_hash,
                                     row_count, status, diff_summary, error_log, uploaded_by)
         VALUES ('event_day_buses', $1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          params.service_date,
          params.cohort === "both" ? null : params.cohort,
          filePath,
          originalName,
          contentHash,
          p.rows.length,
          rejected ? "rejected" : "preview_ready",
          summary ? JSON.stringify(summary) : null,
          rejected ? JSON.stringify(p.errors) : null,
          req.user!.id,
        ],
      ),
    );
    return {
      id: up.rows[0]!.id,
      status: rejected ? "rejected" : "preview_ready",
      service_date: params.service_date,
      errors: p.errors,
      warnings: p.warnings,
      diff: p.diff,
      summary,
      /** the students a confirm would notify — 0 when nothing changed */
      notify_count: notify,
      identical_to: same.rows[0]
        ? { id: same.rows[0].id, applied_at: iso(same.rows[0].applied_at) }
        : null,
    };
  });

  /**
   * Apply re-reads the stored file and re-diffs against the list as it is *now*, so a preview
   * left open while a colleague applied another file cannot apply a stale diff — and the count
   * confirmed must still be the count (checkConfirmation).
   */
  app.post("/v1/admin/event-day/uploads/:id/apply", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = Confirmation.partial().parse(req.body ?? {});
    const found = await deps.db.query<{
      status: string;
      file_path: string;
      content_hash: string;
      service_date: Date | string;
      cohort: Cohort | null;
    }>(
      `SELECT status, file_path, content_hash, to_char(service_date, 'YYYY-MM-DD') AS service_date, cohort
         FROM roster_uploads WHERE id = $1 AND kind = 'event_day_buses'`,
      [id],
    );
    const up = found.rows[0];
    if (!up) return notFound(reply, "No such upload.");
    if (up.status !== "preview_ready")
      return conflict(reply, "not_applicable", `Upload is ${up.status}; nothing to apply.`);
    const csv = await deps.files.get(up.file_path);
    if (createHash("sha256").update(csv).digest("hex") !== up.content_hash)
      return conflict(reply, "file_changed", "Stored file does not match the preview.");
    const date = String(up.service_date);
    const p = await preview(deps.db, csv, date, up.cohort ?? "both");
    if (!p.diff)
      return conflict(
        reply,
        "no_longer_valid",
        "The fleet changed since the preview; upload the file again.",
      );
    const notify = await notifyCount(deps.db, p.diff.notify_cohorts);
    // an apply that changes nothing notifies nobody, so it needs no count
    if (p.diff.notify_cohorts.length && !checkConfirmation(reply, notify, body, 2)) return;

    const diff = p.diff;
    const summary = { ...summariseEventDay(diff), notify_count: notify };
    const out = await withContext(deps.db, contextOf(req), async (q) => {
      const locked = await q.query(
        `UPDATE roster_uploads SET status = 'applied', applied_by = $2, applied_at = now(), diff_summary = $3
          WHERE id = $1 AND status = 'preview_ready' RETURNING id`,
        [id, req.user!.id, JSON.stringify(summary)],
      );
      if (!locked.rows.length) return null;
      return applyEventDay(q, id, date, p.rows);
    });
    if (!out) return conflict(reply, "not_applicable", "Someone else applied this upload.");
    if (diff.notify_cohorts.length) {
      await ring(deps, req, [{ type: "event_day", uploadId: id, at: new Date().toISOString() }]);
    }
    return { id, status: "applied", summary, cancelled_trips: out.cancelledTrips };
  });
}
