/**
 * A stand-in for the Web Push services during the Stage 8 load run (BUILD_PLAN Stage 8, M06
 * carried forward: "the 600-client run should use a real push service, or a realistic stub
 * latency"). 600 real browser subscriptions are not available; this answers every VAPID-signed
 * POST the engine sends with 201 after a latency drawn from a heavy-tailed distribution shaped
 * like FCM's (median ~150 ms, p95 ~700 ms, the odd multi-second straggler), and counts what it
 * received per subscription so the run can prove nothing was dropped or sent twice.
 *
 * It speaks HTTPS because `web-push` only does HTTPS: the harness creates a throwaway CA and
 * starts the engine with NODE_EXTRA_CA_CERTS pointing at it.
 *
 *   GET /stats → { received, perEndpoint: { [id]: n }, latencyMs: { p50, p95 } }
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

export interface SinkStats {
  received: number;
  /** POSTs refused because they were signed with a key the subscription was not made with */
  refused: number;
  duplicates: number;
  perEndpoint: Record<string, number>;
  /** receive time (epoch ms) of each push, by endpoint id — for the delivery-latency figure */
  firstAt: Record<string, number>;
}

/** Log-normal around `medianMs`, with a 1 % tail of 2–6 s stragglers. */
export function pushLatency(rng: () => number, medianMs = 150): number {
  if (rng() < 0.01) return 2000 + rng() * 4000;
  const u = Math.max(rng(), 1e-9);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  return Math.round(medianMs * Math.exp(0.9 * z));
}

/**
 * `expectKey`: the VAPID public key the subscriptions were created with. Like FCM and Mozilla, the
 * sink refuses (403) a push signed with any other key — what a rotated or revoked VAPID key looks
 * like to the engine (Stage 8 chaos drill). Unset, every push is accepted.
 */
export function startPushSink(opts: {
  port: number;
  keyFile: string;
  certFile: string;
  expectKey?: string;
}) {
  const stats: SinkStats = { received: 0, refused: 0, duplicates: 0, perEndpoint: {}, firstAt: {} };
  const state = { expectKey: opts.expectKey };
  const server = createServer(
    { key: readFileSync(opts.keyFile), cert: readFileSync(opts.certFile) },
    (req, res) => {
      if (req.method === "GET" && req.url === "/stats") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(stats));
        return;
      }
      const id = req.url?.split("/push/")[1];
      if (req.method !== "POST" || !id) {
        res.writeHead(404).end();
        return;
      }
      // `Authorization: vapid t=<jwt>, k=<public key>` (RFC 8292)
      const k = /k=([A-Za-z0-9_-]+)/.exec(String(req.headers.authorization ?? ""))?.[1];
      if (state.expectKey && k !== state.expectKey) {
        stats.refused++;
        req.resume();
        res.writeHead(403).end("the VAPID key does not match the subscription");
        return;
      }
      // drain the (encrypted) body; the sink does not need to read it
      req.resume();
      req.on("end", () => {
        setTimeout(() => {
          stats.received++;
          stats.perEndpoint[id] = (stats.perEndpoint[id] ?? 0) + 1;
          stats.firstAt[id] ??= Date.now();
          res.writeHead(201).end();
        }, pushLatency(Math.random));
      });
    },
  );
  server.listen(opts.port, "127.0.0.1");
  return {
    stats,
    state,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}
