import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { BusInput, BusStatusChange, DriverInput } from "@busmitra/contracts";
import { withContext } from "@busmitra/db";
import { countAudience } from "@busmitra/engine/audience";
import type { AppDeps } from "../../../app.ts";
import { contextOf, requireAdmin } from "../../../plugins/auth.ts";
import {
  provisionTracker,
  rotateTrackerSecret,
  type TrackerDirectory,
} from "../../../services/trackers.ts";
import { checkConfirmation, conflict, Id, isUnique, notFound, ring } from "./common.ts";

/**
 * Fleet management (BUILD_PLAN Stage 7): buses, their drivers and routes, tracker pairing and
 * secret rotation, and status — where "out of commission" opens a ticket and fires a T0 to
 * everyone connected to the bus, after a count-stating, typed confirmation (invariant 11).
 *
 * Every mutation runs through withContext, so audit_log records who did it (SCHEMA §8).
 */

const BusPatch = BusInput.partial();
const Uid = z.object({ uid: z.string().min(1).max(80) });

export interface FleetDeps extends AppDeps {
  trackers?: TrackerDirectory;
}

export async function adminFleetRoutes(app: FastifyInstance, deps: FleetDeps) {
  app.addHook("preHandler", requireAdmin(deps));
  const driverOrigin = deps.driverOrigin ?? "http://localhost:5173";
  const pairingLink = (uid: string, secret: string) =>
    `${driverOrigin}/#pair=${encodeURIComponent(uid)}.${secret}`;

  app.get("/v1/admin/buses", async (req) => {
    const { archived } = z.object({ archived: z.enum(["0", "1"]).default("0") }).parse(req.query);
    const { rows } = await deps.db.query(
      `SELECT b.id, b.bus_number, b.registration_no, b.capacity, b.status, b.status_note,
              b.archived_at, b.default_route_id, b.driver_id,
              cr.id AS current_route_id,
              CASE WHEN cr.id IS NOT NULL THEN cr.name || ' (' || cr.direction || ')' END AS route_name,
              d.full_name AS driver_name, d.phone_e164 AS driver_phone,
              (SELECT k.id FROM tickets k WHERE k.bus_id = b.id AND k.kind = 'out_of_commission'
                  AND k.status IN ('open', 'acknowledged')) AS commission_ticket_id,
              COALESCE((SELECT json_agg(json_build_object(
                          'device_uid', t.device_uid, 'kind', t.kind, 'last_seen_at', t.last_seen_at,
                          'secret_rotated_at', t.secret_rotated_at, 'created_at', t.created_at)
                        ORDER BY t.created_at)
                          FROM trackers t WHERE t.bus_id = b.id), '[]'::json) AS trackers
         FROM buses b
         LEFT JOIN routes r0 ON r0.id = b.default_route_id
         LEFT JOIN routes cr ON cr.lineage_id = r0.lineage_id
                            AND cr.published_at IS NOT NULL AND cr.archived_at IS NULL
         LEFT JOIN drivers d ON d.id = b.driver_id
        WHERE ($1 OR b.archived_at IS NULL)
        ORDER BY length(b.bus_number), b.bus_number`,
      [archived === "1"],
    );
    return { buses: rows };
  });

  /** Published routes a bus can be assigned to (one row per lineage, its live version). */
  app.get("/v1/admin/route-options", async () => {
    const { rows } = await deps.db.query(
      `SELECT id, name, direction FROM routes
        WHERE published_at IS NOT NULL AND archived_at IS NULL ORDER BY name, direction`,
    );
    return { routes: rows };
  });

  app.post("/v1/admin/buses", async (req, reply) => {
    const body = BusInput.parse(req.body);
    try {
      const { rows } = await withContext(deps.db, contextOf(req), (q) =>
        q.query<{ id: string }>(
          `INSERT INTO buses (bus_number, registration_no, capacity, default_route_id, driver_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [
            body.bus_number.toUpperCase(),
            body.registration_no,
            body.capacity ?? null,
            body.default_route_id ?? null,
            body.driver_id ?? null,
          ],
        ),
      );
      return reply.code(201).send({ id: rows[0]!.id });
    } catch (err) {
      if (isUnique(err))
        return conflict(
          reply,
          "duplicate",
          "That bus number or registration is already in the fleet.",
        );
      throw err;
    }
  });

  app.patch("/v1/admin/buses/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = BusPatch.parse(req.body);
    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (body.bus_number !== undefined) set("bus_number", body.bus_number.toUpperCase());
    if (body.registration_no !== undefined) set("registration_no", body.registration_no);
    if (body.capacity !== undefined) set("capacity", body.capacity);
    if (body.default_route_id !== undefined) set("default_route_id", body.default_route_id);
    if (body.driver_id !== undefined) set("driver_id", body.driver_id);
    if (!sets.length) return { id, changed: false };
    try {
      const { rows } = await withContext(deps.db, contextOf(req), (q) =>
        q.query(
          `UPDATE buses SET ${sets.join(", ")} WHERE id = $1 AND archived_at IS NULL RETURNING id`,
          params,
        ),
      );
      if (!rows.length) return notFound(reply, "No such bus.");
      return { id, changed: true };
    } catch (err) {
      if (isUnique(err))
        return conflict(
          reply,
          "duplicate",
          "That bus number or registration is already in the fleet.",
        );
      throw err;
    }
  });

  /** Soft delete: historical trips keep resolving the bus (SCHEMA §0). Never while it is out. */
  app.post("/v1/admin/buses/:id/archive", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const live = await deps.db.query(
      `SELECT 1 FROM trips WHERE bus_id = $1 AND status IN ('running', 'dark')`,
      [id],
    );
    if (live.rows.length) return conflict(reply, "bus_running", "This bus is on a trip right now.");
    const { rows } = await withContext(deps.db, contextOf(req), async (q) => {
      await q.query(
        `UPDATE trips SET status = 'cancelled' WHERE bus_id = $1 AND status = 'scheduled'`,
        [id],
      );
      return q.query(
        `UPDATE buses SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING id`,
        [id],
      );
    });
    if (!rows.length) return notFound(reply, "No such bus.");
    return { id, archived: true };
  });

  /** The confirmation dialog's number: everyone connected to the bus (ARCH §6.4). */
  app.get("/v1/admin/buses/:id/audience", async (req) => {
    const { id } = Id.parse(req.params);
    return { count: await countAudience(deps.db, { kind: "bus", busId: id }) };
  });

  app.put("/v1/admin/buses/:id/status", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = BusStatusChange.parse(req.body);
    const found = await deps.db.query<{ bus_number: string; status: string }>(
      `SELECT bus_number, status FROM buses WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );
    const bus = found.rows[0];
    if (!bus) return notFound(reply, "No such bus.");
    if (bus.status === body.status) return { id, status: bus.status, changed: false };

    if (bus.status === "out_of_commission") {
      // back in service goes through the ticket, which tells the students who were warned (T2)
      const t = await deps.db.query<{ id: string }>(
        `SELECT id FROM tickets WHERE bus_id = $1 AND kind = 'out_of_commission'
            AND status IN ('open', 'acknowledged')`,
        [id],
      );
      return reply.code(409).send({
        error: "resolve_ticket",
        message: `Bus ${bus.bus_number} is out of commission. Resolve its ticket to return it to service — that tells the students who were warned.`,
        ticket_id: t.rows[0]?.id ?? null,
      });
    }

    if (body.status !== "out_of_commission") {
      await withContext(deps.db, contextOf(req), (q) =>
        q.query(`UPDATE buses SET status = $2, status_note = $3 WHERE id = $1`, [
          id,
          body.status,
          body.note ?? null,
        ]),
      );
      return { id, status: body.status, changed: true };
    }

    if (!body.note) {
      return reply
        .code(400)
        .send({ error: "invalid_request", message: "note: say why the bus is out of commission" });
    }
    const count = await countAudience(deps.db, { kind: "bus", busId: id });
    if (!checkConfirmation(reply, count, body, 0)) return;
    let ticketId: string;
    try {
      ticketId = await withContext(deps.db, contextOf(req), async (q) => {
        await q.query(
          `UPDATE buses SET status = 'out_of_commission', status_note = $2 WHERE id = $1`,
          [id, body.note],
        );
        const t = await q.query<{ id: string }>(
          `INSERT INTO tickets (kind, severity, bus_id, trip_id, title, description, opened_by)
           VALUES ('out_of_commission', 0, $1,
                   (SELECT id FROM trips WHERE bus_id = $1 AND status IN ('scheduled', 'running', 'dark')),
                   $2, $3, $4)
           RETURNING id`,
          [id, `Bus ${bus.bus_number} is out of commission`, body.note, req.user!.id],
        );
        await q.query(
          `INSERT INTO ticket_events (ticket_id, actor_id, to_status, note) VALUES ($1, $2, 'open', $3)`,
          [t.rows[0]!.id, req.user!.id, body.note],
        );
        return t.rows[0]!.id;
      });
    } catch (err) {
      if (isUnique(err, "one_open_commission_ticket"))
        return conflict(
          reply,
          "already_out",
          `Bus ${bus.bus_number} is already out of commission.`,
        );
      throw err;
    }
    const at = new Date().toISOString();
    await ring(deps, req, [{ type: "ticket", ticketId, transition: "opened", at }]);
    return { id, status: "out_of_commission", changed: true, ticket_id: ticketId, notified: count };
  });

  // ── trackers ──────────────────────────────────────────────────────────

  /** Pair a new driver phone to the bus. The link carries the secret and is shown exactly once. */
  app.post("/v1/admin/buses/:id/trackers", async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!deps.trackerKey)
      return reply
        .code(503)
        .send({ error: "unavailable", message: "Tracker pairing is not configured." });
    const found = await deps.db.query<{ bus_number: string }>(
      `SELECT bus_number FROM buses WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );
    const bus = found.rows[0];
    if (!bus) return notFound(reply, "No such bus.");
    const uid = `phone-${bus.bus_number}-${randomBytes(3).toString("hex")}`;
    const key = deps.trackerKey;
    const out = await withContext(deps.db, contextOf(req), (q) =>
      provisionTracker(q, key, { busNumber: bus.bus_number, deviceUid: uid }),
    );
    deps.trackers?.forget(uid);
    return reply.code(201).send({ device_uid: uid, link: pairingLink(uid, out.secret) });
  });

  /**
   * New secret; the old one keeps verifying for 10 minutes so a phone mid-route is not bricked.
   * This process forgets its cached secret at once; other gateway instances re-read on the
   * first signature miss (plugins/device-auth.ts).
   */
  app.post("/v1/admin/trackers/:uid/rotate", async (req, reply) => {
    const { uid } = Uid.parse(req.params);
    if (!deps.trackerKey)
      return reply
        .code(503)
        .send({ error: "unavailable", message: "Tracker pairing is not configured." });
    const key = deps.trackerKey;
    const secret = await withContext(deps.db, contextOf(req), (q) =>
      rotateTrackerSecret(q, key, uid),
    );
    if (!secret) return notFound(reply, "No such tracker.");
    deps.trackers?.forget(uid);
    return { device_uid: uid, link: pairingLink(uid, secret) };
  });

  /**
   * Unpair: the phone stops being this bus's tracker, and its secret is replaced by one nobody
   * holds, so a lost or stolen phone cannot keep posting positions (ARCH §10).
   */
  app.post("/v1/admin/trackers/:uid/unpair", async (req, reply) => {
    const { uid } = Uid.parse(req.params);
    if (!deps.trackerKey)
      return reply
        .code(503)
        .send({ error: "unavailable", message: "Tracker pairing is not configured." });
    const { rows } = await withContext(deps.db, contextOf(req), (q) =>
      q.query(
        `UPDATE trackers SET bus_id = NULL, secret_prev_enc = NULL, secret_rotated_at = now(),
                secret_enc = pgp_sym_encrypt($2, $3)
          WHERE device_uid = $1 RETURNING id`,
        [uid, randomBytes(32).toString("base64url"), deps.trackerKey],
      ),
    );
    if (!rows.length) return notFound(reply, "No such tracker.");
    deps.trackers?.forget(uid);
    return { device_uid: uid, unpaired: true };
  });

  // ── drivers ───────────────────────────────────────────────────────────

  app.get("/v1/admin/drivers", async () => {
    const { rows } = await deps.db.query(
      `SELECT d.id, d.full_name, d.phone_e164, d.active,
              (SELECT array_agg(b.bus_number ORDER BY b.bus_number) FROM buses b
                WHERE b.driver_id = d.id AND b.archived_at IS NULL) AS buses
         FROM drivers d ORDER BY d.active DESC, d.full_name`,
    );
    return { drivers: rows };
  });

  app.post("/v1/admin/drivers", async (req, reply) => {
    const body = DriverInput.parse(req.body);
    const { rows } = await withContext(deps.db, contextOf(req), (q) =>
      q.query<{ id: string }>(
        `INSERT INTO drivers (full_name, phone_e164) VALUES ($1, $2) RETURNING id`,
        [body.full_name, body.phone ?? null],
      ),
    );
    return reply.code(201).send({ id: rows[0]!.id });
  });

  app.patch("/v1/admin/drivers/:id", async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = DriverInput.partial().parse(req.body);
    const { rows } = await withContext(deps.db, contextOf(req), (q) =>
      q.query(
        `UPDATE drivers SET full_name = COALESCE($2, full_name),
                phone_e164 = CASE WHEN $3 THEN $4 ELSE phone_e164 END,
                active = COALESCE($5, active)
          WHERE id = $1 RETURNING id`,
        [
          id,
          body.full_name ?? null,
          body.phone !== undefined,
          body.phone ?? null,
          body.active ?? null,
        ],
      ),
    );
    if (!rows.length) return notFound(reply, "No such driver.");
    return { id };
  });
}
