# ADR-0001 — The live channel is SSE on the Fastify gateway

**Status:** accepted · **Stage:** 3 · **Date:** 2026-09-23 (drafted in ARCHITECTURE §2.2, formalised here)

## Context

Students need live positions, bus presence and stop arrivals pushed to an open tab, and later
(Stages 5–6) their own ETAs and notifications. The traffic is almost entirely server → client:
a student's only messages upward are "this is what I am looking at" (focus) and ordinary
mutations, which are REST calls anyway.

The numbers that shape it: 30 buses at a 5 s cadence (≈ 6 events/s); 600 concurrent students at
the 7:40 a.m. peak, most sessions about eleven seconds long; phones on cellular that drop in
tunnels and switch cells. Three failures matter more than throughput:

1. a resumed connection silently missing a stop arrival;
2. one student ever receiving another's per-user payload;
3. a crashed gateway locking students out of reconnecting.

## Options considered

- **WebSocket.** Bidirectional, which we do not need. In exchange: our own reconnect and
  backoff, ping/pong framing, and sticky sessions or a shared adapter behind any load balancer.
  Some proxies drop idle upgrades silently. Nothing we need is easier.
- **Supabase Realtime `postgres_changes`.** Every position would have to be written to Postgres
  and come back through the WAL: 200–800 ms more, and ingestion re-coupled to delivery, which
  ADR-0002 exists to prevent. Postgres down would mean the map down.
- **Supabase Realtime Broadcast.** Skips the write, but routes through a cluster we do not
  control and gives us no per-user payload shaping. Each student's stream will carry *their*
  stop's ETA; that shaping has to happen somewhere we own.
- **Long polling.** Works everywhere, but at 600 clients it is 600 requests per interval and
  still needs our own resume logic. SSE is the same HTTP with the resume built in.
- **SSE (`text/event-stream`) on the long-lived Fastify gateway.** One-way, which is the shape
  of the problem. Plain HTTP through every campus proxy. `id:` plus `Last-Event-ID` is a resume
  protocol the format already defines. Debuggable with `curl -N`.

## Decision

SSE, served by the Fastify gateway, **never** by a Next.js route (invariant 8): serverless
execution caps sever long streams.

How the three failures are designed out (Stage 3):

- **Resume.** Only broadcast-class frames (`bus.position`, `bus.status`, `stop.reached`) are
  written to `stream:events` and carry an `id:`. On reconnect the gateway replays everything
  after `Last-Event-ID`, then sends a snapshot. If the stream was trimmed past the client's id,
  `stream.ready` says so (`replayTruncated`).
- **No cross-user leakage.** Per-user frames (`stream.ready`, `fleet.snapshot`, later
  `eta.update` and `notification`) have **no id** and are re-derived on every connect, never
  replayed (invariant 9). The replay path re-checks that every entry is broadcast-class, so
  even a stray per-user frame in the stream could not be sent to anyone.
- **No lockouts.** The 3-stream cap is one Redis key per connection with a 45 s TTL refreshed
  by the 15 s heartbeat, never a SET (invariant 10). Keys name their gateway instance, and a
  restarted instance deletes its own leftovers at boot.

Authentication is a JWT in the `Authorization` header. The browser's `EventSource` cannot send
headers, so the web client is a fetch-based reader that does EventSource's job explicitly
(`apps/web/lib/sse/client.ts`). A token in the query string was rejected: it ends up in access
logs and proxy logs.

Each gateway process runs one blocking `XREAD` on `stream:events` and fans out to its own
connections, so Redis sees one reader per gateway, not one per student.

## Consequences accepted

- **The client is ours to maintain.** Reconnect, backoff, the silence watchdog and
  `Last-Event-ID` bookkeeping are about 120 lines in `lib/sse/client.ts` instead of a browser
  built-in. They are unit-tested at the parser level and driven in a real browser for the Stage 3
  exit.
- **Focus lives in Redis, not in the gateway's memory.** Any instance can accept
  `POST /v1/stream/focus`; the instance holding the stream picks it up within one heartbeat
  (immediately when it is the same instance). At one instance today the lag is zero.
- **HTTP/2 in production is required**, or a student with several tabs meets the browser's
  six-connections-per-origin limit on HTTP/1.1. TLS termination with HTTP/2 is a Stage 9 item.
- **We still use Supabase Realtime** for low-frequency admin state in the console (Stage 7),
  where latency does not matter and its convenience does.
