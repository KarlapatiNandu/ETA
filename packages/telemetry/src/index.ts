import {
  context,
  metrics,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Meter,
  type Span,
} from "@opentelemetry/api";

export { RollingWindow } from "./window.ts";
export type { Span } from "@opentelemetry/api";

/**
 * @busmitra/telemetry — OpenTelemetry for the gateway and the engine (BUILD_PLAN Stage 8).
 *
 * Off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set: then every call here is the OTel API's
 * no-op, which costs nothing and changes no behaviour (tests never start it). On, it exports
 * traces and metrics over OTLP/HTTP — to the local Grafana stack in development
 * (`docker compose --profile observability`), to Grafana Cloud in production. The standard
 * OTEL_* variables configure the exporters (endpoint, headers, sampler), so nothing here is
 * vendor-specific.
 *
 * One trace follows a fix end to end: the gateway's ingest span → `stream:pings` → the geo
 * worker's step → `stream:events` → the SSE fan-out, the ETA worker and the notify worker →
 * the push POST. A Redis stream entry carries its span's W3C `traceparent` in a `tp` field
 * next to the JSON in `d`, so no contract changes shape.
 */

export interface Telemetry {
  enabled: boolean;
  shutdown(): Promise<void>;
}

/**
 * Start the SDK for one process. Call it first thing in `main`, before any instrument is used:
 * the metrics API binds instruments to whichever provider exists when they are created (the
 * instruments below are created on first use for exactly this reason).
 */
export async function startTelemetry(opts: {
  service: string;
  version?: string;
  env?: Record<string, string | undefined>;
}): Promise<Telemetry> {
  const env = opts.env ?? process.env;
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_SDK_DISABLED === "true") {
    return { enabled: false, shutdown: async () => undefined };
  }
  const [
    { NodeSDK },
    { OTLPTraceExporter },
    { OTLPMetricExporter },
    { PeriodicExportingMetricReader },
    res,
    sc,
  ] = await Promise.all([
    import("@opentelemetry/sdk-node"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/semantic-conventions"),
  ]);
  const sdk = new NodeSDK({
    resource: res.resourceFromAttributes({
      [sc.ATTR_SERVICE_NAME]: opts.service,
      [sc.ATTR_SERVICE_VERSION]: opts.version ?? "0.0.0",
      "deployment.environment.name": env.NODE_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(env.OTEL_METRIC_EXPORT_INTERVAL ?? 15_000),
      }),
    ],
    instrumentations: [],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}

export const tracer = () => trace.getTracer("busmitra");
export const meter = (): Meter => metrics.getMeter("busmitra");

/** The W3C traceparent of `ctx` (the active context by default), or undefined when off. */
export function traceparentOf(ctx: Context = context.active()): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(ctx, carrier);
  return carrier.traceparent;
}

/** The traceparent of a span (for handing a trace across a Redis stream). */
export function traceparentOfSpan(span: Span): string | undefined {
  return traceparentOf(trace.setSpan(context.active(), span));
}

export function contextFrom(tp: string | undefined): Context {
  return tp ? propagation.extract(context.active(), { traceparent: tp }) : context.active();
}

/**
 * Run `fn` in a span, as a child of `parent` (a traceparent read off a stream entry) when there
 * is one. Records an exception and marks the span failed if `fn` throws; rethrows.
 */
export async function inSpan<T>(
  name: string,
  opts: { parent?: string; attributes?: Attributes },
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  return tracer().startActiveSpan(
    name,
    { attributes: opts.attributes },
    contextFrom(opts.parent),
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

const lazy = <T>(make: () => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

/**
 * The instruments the dashboards read (ARCH §4 guardrail, BUILD_PLAN Stage 8 dashboards).
 * Names are OTel-style; Prometheus sees them with dots as underscores and a unit suffix.
 */
export const instruments = {
  /** gateway: pings accepted / rejected at ingest */
  ingestPings: lazy(() =>
    meter().createCounter("busmitra.ingest.pings", { description: "pings at /v1/ingest" }),
  ),
  /** gateway: a fix's recorded_at → its frame fanned out to SSE connections (seconds) */
  pingToFrame: lazy(() =>
    meter().createHistogram("busmitra.sse.ping_to_frame", {
      unit: "s",
      description: "age of a bus.position frame when the gateway fans it out",
      advice: { explicitBucketBoundaries: [0.5, 1, 2, 3, 4, 5, 6, 8, 10, 15, 30, 60] },
    }),
  ),
  /** gateway: open SSE streams on this instance */
  sseConnections: lazy(() =>
    meter().createUpDownCounter("busmitra.sse.connections", { description: "open SSE streams" }),
  ),
  /** engine: notification transport attempts, by channel, tier and outcome */
  notifySends: lazy(() =>
    meter().createCounter("busmitra.notify.sends", { description: "transport attempts" }),
  ),
  /** engine: the push service's answer time for one POST (ms) — alert-latency v2 */
  pushPost: lazy(() =>
    meter().createHistogram("busmitra.notify.push_post", {
      unit: "ms",
      description: "time for the push service to answer one Web Push POST",
      advice: { explicitBucketBoundaries: [25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800] },
    }),
  ),
  /** engine: notification created → transport accepted it (seconds) */
  notifyLatency: lazy(() =>
    meter().createHistogram("busmitra.notify.event_to_send", {
      unit: "s",
      description: "notification recorded → push service / SMS provider accepted it",
      advice: { explicitBucketBoundaries: [0.25, 0.5, 1, 2, 4, 6, 8, 10, 15, 30, 60] },
    }),
  ),
};
