import type { FastifyInstance } from "fastify";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { tracer, type Span } from "@busmitra/telemetry";

declare module "fastify" {
  interface FastifyRequest {
    /** Stage 8: this request's server span (a no-op span when telemetry is off) */
    span: Span | null;
  }
}

/**
 * One server span per request (BUILD_PLAN Stage 8, ARCH §4 "every stage emits an OTel span").
 * Named by route pattern, never by URL, so a roll number or a trip id never becomes a span name.
 * The SSE stream itself is left out: a span that lives for an hour says nothing a connection
 * gauge does not — its frames are traced by the hub instead.
 */
export function otelPlugin(app: FastifyInstance) {
  app.decorateRequest("span", null);
  app.addHook("onRequest", async (req) => {
    if (req.method === "GET" && req.routeOptions.url === "/v1/stream") return;
    req.span = tracer().startSpan(`${req.method} ${req.routeOptions.url ?? "unmatched"}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.request.method": req.method,
        "http.route": req.routeOptions.url ?? "unmatched",
      },
    });
  });
  app.addHook("onResponse", async (req, reply) => {
    if (!req.span) return;
    req.span.setAttribute("http.response.status_code", reply.statusCode);
    if (reply.statusCode >= 500) req.span.setStatus({ code: SpanStatusCode.ERROR });
    req.span.end();
  });
}
