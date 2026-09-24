import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppDeps } from "../../../app.ts";
import { requireAdmin } from "../../../plugins/auth.ts";

/**
 * The audit log viewer (BUILD_PLAN Stage 7): every admin mutation, newest first, with the
 * fields that changed. Rows are written by the audit_row trigger (SCHEMA §8), which already
 * drops secrets, geometry and students' pinned homes — this endpoint adds nothing back.
 * Keyset-paginated on the bigserial id.
 */

const Query = z.object({
  entity: z
    .string()
    .regex(/^[a-z_]{1,40}$/)
    .optional(),
  entity_id: z.uuid().optional(),
  actor_id: z.uuid().optional(),
  /** only mutations made by a person (hides the engine's and devices' own writes) */
  people_only: z.enum(["0", "1"]).default("0"),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type Json = Record<string, unknown> | null;

/** The keys whose values differ between before and after (all keys for an insert or delete). */
export function changedKeys(before: Json, after: Json): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  keys.delete("updated_at");
  return [...keys]
    .filter((k) => JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null))
    .sort();
}

export async function adminAuditRoutes(app: FastifyInstance, deps: AppDeps) {
  app.addHook("preHandler", requireAdmin(deps));

  app.get("/v1/admin/audit", async (req) => {
    const q = Query.parse(req.query);
    const { rows } = await deps.db.query<{
      id: string;
      before: Json;
      after: Json;
    }>(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.before, a.after, host(a.ip) AS ip,
              a.user_agent, a.created_at, a.actor_id, p.full_name AS actor_name, p.roll_no AS actor_roll
         FROM audit_log a LEFT JOIN profiles p ON p.id = a.actor_id
        WHERE ($1::text IS NULL OR a.entity = $1)
          AND ($2::uuid IS NULL OR a.entity_id = $2)
          AND ($3::uuid IS NULL OR a.actor_id = $3)
          AND (NOT $4 OR a.actor_id IS NOT NULL)
          AND ($5::bigint IS NULL OR a.id < $5)
        ORDER BY a.id DESC
        LIMIT $6`,
      [
        q.entity ?? null,
        q.entity_id ?? null,
        q.actor_id ?? null,
        q.people_only === "1",
        q.before ?? null,
        q.limit,
      ],
    );
    const entries = rows.map((r) => ({
      ...r,
      id: Number(r.id),
      changed: changedKeys(r.before, r.after),
    }));
    const entities = await deps.db.query<{ entity: string }>(
      `SELECT DISTINCT entity FROM audit_log ORDER BY entity`,
    );
    return {
      entries,
      next: entries.length === q.limit ? entries[entries.length - 1]!.id : null,
      entities: entities.rows.map((e) => e.entity),
    };
  });
}
