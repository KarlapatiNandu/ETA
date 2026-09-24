import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { NewTicket, TicketAction } from "@busmitra/contracts";
import { withContext, type Queryable } from "@busmitra/db";
import { countAudience } from "@busmitra/engine/audience";
import type { AppDeps } from "../../../app.ts";
import { contextOf, requireAdmin } from "../../../plugins/auth.ts";
import { checkConfirmation, conflict, Id, notFound, ring } from "./common.ts";

/**
 * The ticket queue (BUILD_PLAN Stage 7): open → acknowledged → resolved (or cancelled), with an
 * assignee and a timeline. A ticket is a notification with a lifecycle (SCHEMA §6): resolving
 * an out-of-commission ticket returns the bus to service and tells the same students "back in
 * service" (T2) on the same card — so it carries a count confirmation like any other send.
 *
 * Transitions are compare-and-set on the current status: two admins clicking at once produce
 * one transition and one 409, never two timeline entries for one change.
 */

const ALLOWED: Record<string, string[]> = {
  acknowledge: ["open"],
  resolve: ["open", "acknowledged"],
  cancel: ["open", "acknowledged"],
  assign: ["open", "acknowledged"],
  note: ["open", "acknowledged", "resolved", "cancelled"],
};

interface TicketRow {
  id: string;
  kind: string;
  status: string;
  bus_id: string | null;
  bus_number: string | null;
}

async function loadTicket(q: Queryable, id: string): Promise<TicketRow | null> {
  const { rows } = await q.query<TicketRow>(
    `SELECT k.id, k.kind, k.status, k.bus_id, b.bus_number
       FROM tickets k LEFT JOIN buses b ON b.id = k.bus_id WHERE k.id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function adminTicketRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook("preHandler", requireAdmin(deps));

  app.get("/v1/admin/tickets", async (req) => {
    const { status } = z
      .object({ status: z.enum(["active", "resolved", "all"]).default("active") })
      .parse(req.query);
    const { rows } = await deps.db.query(
      `SELECT k.id, k.kind, k.severity, k.status, k.title, k.bus_id, b.bus_number, k.trip_id,
              k.opened_at, k.opened_by IS NULL AS automatic, k.resolved_at, k.updated_at,
              k.assigned_to, ap.full_name AS assigned_name
         FROM tickets k
         LEFT JOIN buses b ON b.id = k.bus_id
         LEFT JOIN profiles ap ON ap.id = k.assigned_to
        WHERE CASE $1::text WHEN 'active' THEN k.status IN ('open', 'acknowledged')
                            WHEN 'resolved' THEN k.status IN ('resolved', 'cancelled')
                            ELSE true END
        ORDER BY (k.status IN ('open', 'acknowledged')) DESC, k.severity, k.opened_at DESC
        LIMIT 200`,
      [status],
    );
    return { tickets: rows };
  });

  app.get("/v1/admin/tickets/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const t = await deps.db.query(
      `SELECT k.*, b.bus_number, op.full_name AS opened_name, rp.full_name AS resolved_name,
              ap.full_name AS assigned_name
         FROM tickets k
         LEFT JOIN buses b ON b.id = k.bus_id
         LEFT JOIN profiles op ON op.id = k.opened_by
         LEFT JOIN profiles rp ON rp.id = k.resolved_by
         LEFT JOIN profiles ap ON ap.id = k.assigned_to
        WHERE k.id = $1`,
      [id],
    );
    if (!t.rows[0]) return notFound(reply, "No such ticket.");
    const events = await deps.db.query(
      `SELECT e.id, e.from_status, e.to_status, e.note, e.created_at, p.full_name AS actor_name
         FROM ticket_events e LEFT JOIN profiles p ON p.id = e.actor_id
        WHERE e.ticket_id = $1 ORDER BY e.created_at, e.id`,
      [id],
    );
    return { ticket: t.rows[0], events: events.rows };
  });

  /** People a ticket can be assigned to. */
  app.get("/v1/admin/admins", async () => {
    const { rows } = await deps.db.query(
      `SELECT id, full_name, roll_no FROM profiles WHERE role IN ('td_admin', 'super_admin') ORDER BY full_name`,
    );
    return { admins: rows };
  });

  /** A ticket raised by hand. It notifies nobody: it is the TD's own work queue. */
  app.post("/v1/admin/tickets", async (req, reply) => {
    const body = NewTicket.parse(req.body);
    const id = await withContext(deps.db, contextOf(req), async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `INSERT INTO tickets (kind, severity, bus_id, title, description, opened_by)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          body.kind,
          body.severity,
          body.bus_id ?? null,
          body.title,
          body.description ?? null,
          req.user!.id,
        ],
      );
      await q.query(
        `INSERT INTO ticket_events (ticket_id, actor_id, to_status, note) VALUES ($1, $2, 'open', 'opened')`,
        [rows[0]!.id, req.user!.id],
      );
      return rows[0]!.id;
    });
    return reply.code(201).send({ id });
  });

  app.post("/v1/admin/tickets/:id/actions", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = TicketAction.parse(req.body);
    const ticket = await loadTicket(deps.db, id);
    if (!ticket) return notFound(reply, "No such ticket.");
    if (!ALLOWED[body.action]!.includes(ticket.status)) {
      return conflict(
        reply,
        "not_allowed",
        `This ticket is ${ticket.status}; it cannot be ${body.action}d.`,
      );
    }
    const commission = ticket.kind === "out_of_commission";
    if (body.action === "cancel" && commission) {
      // students were told the bus is out; only a resolve tells them it is back
      return conflict(
        reply,
        "not_allowed",
        "An out-of-commission ticket is closed by resolving it, which tells the students who were warned.",
      );
    }
    let count: number | null = null;
    if (body.action === "resolve" && commission && ticket.bus_id) {
      count = await countAudience(deps.db, { kind: "bus", busId: ticket.bus_id });
      if (!checkConfirmation(reply, count, body, 2)) return;
    }
    if (body.action === "assign" && body.assigned_to) {
      const a = await deps.db.query(
        `SELECT 1 FROM profiles WHERE id = $1 AND role IN ('td_admin', 'super_admin')`,
        [body.assigned_to],
      );
      if (!a.rows.length)
        return reply
          .code(400)
          .send({ error: "invalid_request", message: "assigned_to: not an admin" });
    }

    const actor = req.user!.id;
    const next =
      body.action === "acknowledge"
        ? "acknowledged"
        : body.action === "resolve"
          ? "resolved"
          : body.action === "cancel"
            ? "cancelled"
            : ticket.status;

    const done = await withContext(deps.db, contextOf(req), async (q) => {
      // compare-and-set on the status we judged
      const upd = await q.query(
        `UPDATE tickets
            SET status = $3::ticket_status_t,
                assigned_to = CASE WHEN $4 THEN $5::uuid ELSE assigned_to END,
                resolved_by = CASE WHEN $3 IN ('resolved', 'cancelled') THEN $6::uuid ELSE resolved_by END,
                resolved_at = CASE WHEN $3 IN ('resolved', 'cancelled') THEN now() ELSE resolved_at END,
                resolution_note = CASE WHEN $3 IN ('resolved', 'cancelled') THEN $7 ELSE resolution_note END
          WHERE id = $1 AND status = $2::ticket_status_t RETURNING id`,
        [
          id,
          ticket.status,
          next,
          body.action === "assign",
          body.action === "assign" ? body.assigned_to : null,
          actor,
          "note" in body ? (body.note ?? null) : null,
        ],
      );
      if (!upd.rows.length) return false;
      let note = "note" in body ? (body.note ?? null) : null;
      if (body.action === "assign") {
        const who = body.assigned_to
          ? (
              await q.query<{ full_name: string }>(`SELECT full_name FROM profiles WHERE id = $1`, [
                body.assigned_to,
              ])
            ).rows[0]?.full_name
          : null;
        note = who ? `assigned to ${who}` : "unassigned";
      }
      await q.query(
        `INSERT INTO ticket_events (ticket_id, actor_id, from_status, to_status, note)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, actor, ticket.status, next, note],
      );
      if (body.action === "resolve" && commission && ticket.bus_id) {
        await q.query(
          `UPDATE buses SET status = 'active', status_note = NULL
            WHERE id = $1 AND status = 'out_of_commission'`,
          [ticket.bus_id],
        );
      }
      return true;
    });
    if (!done) return conflict(reply, "stale", "Someone else changed this ticket. Reload it.");
    if (count !== null) {
      await ring(deps, req, [
        { type: "ticket", ticketId: id, transition: "resolved", at: new Date().toISOString() },
      ]);
    }
    return { id, status: next, ...(count !== null ? { notified: count } : {}) };
  });
}
