import type { FastifyInstance } from "fastify";
import { AudienceSpec, PublishAnnouncement } from "@busmitra/contracts";
import { withContext, type Queryable } from "@busmitra/db";
import { countAudience, resolveRollNos, type Audience } from "@busmitra/engine/audience";
import type { AppDeps } from "../../../app.ts";
import { contextOf, requireAdmin } from "../../../plugins/auth.ts";
import { checkConfirmation, conflict, Id, notFound, ring } from "./common.ts";

/**
 * Announcements (BUILD_PLAN Stage 7): compose, pick an audience (All / Juniors / Seniors /
 * Route / Bus / Custom), see the live recipient count, confirm that exact number, and send now
 * or at a set time. The gateway re-resolves the audience on send and refuses a count that has
 * moved (invariant 11). A custom audience is stored as `announcement_recipients` — the list the
 * admin confirmed is the list that is notified, even if the roster changes before a scheduled send.
 */

const MAX_SCHEDULE_AHEAD_MS = 30 * 86_400_000;

async function resolveSpec(
  q: Queryable,
  spec: AudienceSpec,
): Promise<{ audience: Audience; count: number; unmatched: string[]; userIds?: string[] }> {
  if (spec.audience === "custom") {
    const r = await resolveRollNos(q, spec.roll_nos ?? []);
    return {
      audience: { kind: "users", userIds: r.userIds },
      count: r.userIds.length,
      unmatched: r.unmatched,
      userIds: r.userIds,
    };
  }
  const audience: Audience =
    spec.audience === "route"
      ? { kind: "route", routeId: spec.audience_ref! }
      : spec.audience === "bus"
        ? { kind: "bus", busId: spec.audience_ref! }
        : { kind: spec.audience };
  return { audience, count: await countAudience(q, audience), unmatched: [] };
}

export async function adminAnnouncementRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook("preHandler", requireAdmin(deps));

  /** The live recipient count under the composer. */
  app.post("/v1/admin/audience", async (req) => {
    const spec = AudienceSpec.parse(req.body);
    const r = await resolveSpec(deps.db, spec);
    return { count: r.count, unmatched: r.unmatched };
  });

  app.get("/v1/admin/announcements", async () => {
    const { rows } = await deps.db.query(
      `SELECT a.id, a.tier, a.audience, a.audience_ref, a.title, a.body_md, a.confirmed_count,
              a.scheduled_for, a.published_at, a.cancelled_at, a.created_at,
              p.full_name AS created_name,
              CASE a.audience WHEN 'bus' THEN (SELECT 'Bus ' || bus_number FROM buses WHERE id = a.audience_ref)
                              WHEN 'route' THEN (SELECT name || ' (' || direction || ')' FROM routes WHERE id = a.audience_ref)
              END AS audience_label,
              CASE WHEN a.cancelled_at IS NOT NULL THEN 'cancelled'
                   WHEN a.published_at IS NOT NULL THEN 'sent'
                   ELSE 'scheduled' END AS state,
              -- Stage 6 delivery: counts only, never who (SCHEMA §9)
              (SELECT json_build_object(
                        'recipients', count(*), 'pushed', count(*) FILTER (WHERE r.channel = 'push'),
                        'texted', count(*) FILTER (WHERE r.channel = 'sms'),
                        'in_app_only', count(*) FILTER (WHERE r.channel = 'inapp_only'),
                        'pending', count(*) FILTER (WHERE r.sent_at IS NULL), 'read', count(r.read_at))
                 FROM notification_recipients r WHERE r.notification_id = a.notification_id) AS delivery
         FROM announcements a JOIN profiles p ON p.id = a.created_by
        ORDER BY COALESCE(a.published_at, a.scheduled_for, a.created_at) DESC
        LIMIT 100`,
    );
    return { announcements: rows };
  });

  app.post("/v1/admin/announcements", async (req, reply) => {
    const body = PublishAnnouncement.parse(req.body);
    const now = Date.now();
    const at = body.scheduled_for ? Date.parse(body.scheduled_for) : null;
    if (at !== null && (at < now + 60_000 || at > now + MAX_SCHEDULE_AHEAD_MS)) {
      return reply.code(400).send({
        error: "invalid_request",
        message: "scheduled_for: pick a time at least a minute from now and within 30 days",
      });
    }
    const r = await resolveSpec(deps.db, body);
    if (r.count === 0) {
      return reply.code(400).send({
        error: "empty_audience",
        message: "Nobody is in this audience; nothing would be sent.",
      });
    }
    if (!checkConfirmation(reply, r.count, body, body.tier)) return;

    const id = await withContext(deps.db, contextOf(req), async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO announcements
           (tier, audience, audience_ref, title, body_md, confirmed_count, scheduled_for, published_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz,
                 CASE WHEN $7::timestamptz IS NULL THEN now() END, $8)
         RETURNING id`,
        [
          body.tier,
          body.audience,
          body.audience_ref ?? null,
          body.title,
          body.body_md,
          r.count,
          body.scheduled_for ?? null,
          req.user!.id,
        ],
      );
      const annId = rows[0]!.id;
      if (r.userIds?.length) {
        await q.query(
          `INSERT INTO announcement_recipients (announcement_id, user_id)
           SELECT $1, unnest($2::uuid[])`,
          [annId, r.userIds],
        );
      }
      return annId;
    });
    if (!body.scheduled_for) {
      await ring(deps, req, [
        { type: "announcement", announcementId: id, at: new Date().toISOString() },
      ]);
    }
    return reply.code(201).send({
      id,
      state: body.scheduled_for ? "scheduled" : "sent",
      recipients: r.count,
      unmatched: r.unmatched,
    });
  });

  /** A scheduled announcement can be withdrawn until the scheduler publishes it. */
  app.post("/v1/admin/announcements/:id/cancel", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { rows } = await withContext(deps.db, contextOf(req), (q) =>
      q.query(
        `UPDATE announcements SET cancelled_at = now()
          WHERE id = $1 AND published_at IS NULL AND cancelled_at IS NULL RETURNING id`,
        [id],
      ),
    );
    if (rows.length) return { id, state: "cancelled" };
    const exists = await deps.db.query(`SELECT 1 FROM announcements WHERE id = $1`, [id]);
    if (!exists.rows.length) return notFound(reply, "No such announcement.");
    return conflict(reply, "already_sent", "It has already been sent (or cancelled).");
  });
}
