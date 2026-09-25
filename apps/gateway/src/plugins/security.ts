import type { FastifyInstance } from "fastify";

/**
 * Security headers on every gateway response (BUILD_PLAN Stage 9 "CSP, security headers").
 * The gateway serves JSON and SSE, never HTML, so the policy is short: nothing it returns may be
 * sniffed into something executable, framed, cached by a shared proxy, or leak a referrer. HSTS
 * only in production, where TLS terminates at Fly's edge in front of it.
 *
 * The SSE stream writes its own head (it hijacks the response) and sets `cache-control` there.
 */
export function securityHeaders(app: FastifyInstance, opts: { hsts: boolean }) {
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
    reply.header("referrer-policy", "no-referrer");
    // API answers are per-student: no shared cache may keep one (a route may set its own)
    if (!reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    if (opts.hsts) {
      reply.header("strict-transport-security", "max-age=63072000; includeSubDomains; preload");
    }
    return payload;
  });
}
