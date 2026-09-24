import type { FastifyReply, FastifyRequest } from "fastify";
import type { RequestContext } from "@busmitra/db";
import type { AppDeps } from "../app.ts";
import type { VerifiedUser } from "../services/jwt.ts";

declare module "fastify" {
  interface FastifyRequest {
    user: VerifiedUser | null;
  }
}

/** Resolve the bearer token, if any. Never rejects: routes decide what they require. */
export function authHook(deps: AppDeps) {
  return async (req: FastifyRequest) => {
    req.user = null;
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) return;
    try {
      req.user = await deps.verifyJwt(header.slice(7));
    } catch {
      req.user = null;
    }
  };
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user)
    return reply.code(401).send({ error: "unauthenticated", message: "Sign in first." });
}

/**
 * Admin surfaces answer 404, not 403, to everyone else (BUILD_PLAN Stage 4 "Expect") —
 * a 403 confirms the route exists. The role is read from profiles, not trusted from the
 * token, so a demotion applies immediately rather than at token expiry.
 */
export function requireAdmin(deps: AppDeps) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user) {
      const { rows } = await deps.db.query<{ role: string }>(
        `SELECT role FROM profiles WHERE id = $1`,
        [req.user.id],
      );
      if (rows[0] && (rows[0].role === "td_admin" || rows[0].role === "super_admin")) return;
    }
    return reply.code(404).send({ error: "not_found", message: "Not found" });
  };
}

/** Request context for the audit trigger (SCHEMA §8). */
export function contextOf(req: FastifyRequest): RequestContext {
  return {
    actorId: req.user?.id ?? null,
    ip: req.ip ?? null,
    userAgent: req.headers["user-agent"]?.slice(0, 512) ?? null,
  };
}
