# ADR-0009 — Vendor-neutral telemetry, a console health page, and k6 with an SSE extension

**Status:** accepted · **Stage:** 8 · **Date:** 2026-09-24

## Context

BUILD_PLAN Stage 8 asks for "OpenTelemetry end to end — one trace from ingest through snap, ETA,
notify, to push receipt. Ship to Grafana Cloud", dashboards, alerting rules, and k6 load tests at
600 and 1,000 SSE clients. Four decisions were genuinely close.

## 1. How a trace crosses a Redis stream

- **A. A `tp` field beside `d` in every stream entry (chosen).** The W3C traceparent of the span
  that wrote the entry. No contract changes shape (`d` is still the Zod-validated JSON), readers
  that do not care never see it, and with telemetry off it is simply absent — zero bytes.
- **B. Put the traceparent inside the JSON payload.** Changes every contract in
  `packages/contracts`, and a hardware tracker's contract must stay additive-only.
- **C. Span links from a stored id map.** Needs shared state between processes for nothing.

The notify worker's *delivery* pass is decoupled from the event (it claims rows from Postgres),
so the trace is carried across by an in-process, bounded map from notification id to
traceparent. After an engine restart those traces end at "recorded". Accepted: a column for a
trace id is not worth a migration.

## 2. Where the dashboards read from

- **A. Metrics over OTLP for the live path + aggregate SQL views for history (chosen).**
  Latency, lag, connections and send outcomes are process metrics; ETA error, delivery rates and
  dead-zone frequency are already rows in Postgres. Grafana reads those through `obs_*` views as a
  role (`busmitra_metrics`) that can see no student, phone or position — views, not grants on
  tables.
- **B. Export everything as metrics.** The engine would re-count rows the database already
  holds, and the numbers would drift from the record.

## 3. A health page in the console, not only Grafana

- **A. Both (chosen).** `/admin/health` computes the same five alert rules (`ALERTS` in
  `packages/config`) from Redis and the views on request. The Transport Department will not have
  Grafana logins; campus IT will. The Grafana rule file repeats the thresholds and a test fails if
  the two drift.
- **B. Grafana only.** The people who first notice "the map is slow" would have nowhere to look.

## 4. Load testing SSE

- **A. k6 + the `xk6-sse` extension, built in Docker (chosen).** Stock k6 cannot hold an
  EventSource open. A container build (`tests/load/Dockerfile`) means nobody installs Go. A Node
  harness (`pnpm sim load`) does what k6 should not: seeds students, runs its own gateway and
  engine, drives the 30 buses, sends the T0, samples lag, and judges the result.
- **B. A pure Node load generator.** Easy, but not what the plan names, and it would measure the
  generator's event loop as much as the gateway.
- **C. Artillery.** Its SSE support is a plugin of similar maturity; no advantage over k6.

The push services are replaced by a local HTTPS sink with FCM-shaped latency (median 150 ms,
1 % stragglers at 2–6 s) — 600 real browser subscriptions do not exist. The engine trusts the
sink's throwaway CA through `NODE_EXTRA_CA_CERTS`, set only on the harness's own processes.

## Consequences accepted

- Latency is judged at the gateway (fix `recorded_at` → frame fanned out), on the clock that
  stamped the fix. k6's own clock runs in the Docker VM, which can step by tens of seconds after
  the laptop sleeps (it did, mid-run: M08 gotchas); client-side ages are a cross-check only.
- Telemetry is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Production samples 10 % of traces.
