import { createHmac } from "node:crypto";
import { signingPayload, TRACKER_HEADERS, type IngestResult } from "@busmitra/contracts";

/**
 * A tracker's HTTP client: signs every request exactly as the driver PWA does (same payload
 * builder from @busmitra/contracts), and retries the way it does — keep the batch and back
 * off on 5xx, 429 and network failures; give up only on answers that say retrying is useless.
 */

export interface TrackerClient {
  deviceUid: string;
  call<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: T }>;
}

export function trackerClient(gateway: string, deviceUid: string, secret: string): TrackerClient {
  let lastTs = 0;
  return {
    deviceUid,
    async call(method, path, body) {
      const raw = body === undefined ? "" : JSON.stringify(body);
      // strictly increasing seconds, so two requests in one second never share a nonce
      lastTs = Math.max(lastTs + 1, Math.floor(Date.now() / 1000));
      const ts = String(lastTs);
      const sig = createHmac("sha256", secret)
        .update(signingPayload(deviceUid, ts, raw))
        .digest("hex");
      const res = await fetch(`${gateway}${path}`, {
        method,
        headers: {
          ...(raw ? { "content-type": "application/json" } : {}),
          [TRACKER_HEADERS.device]: deviceUid,
          [TRACKER_HEADERS.timestamp]: ts,
          [TRACKER_HEADERS.signature]: sig,
        },
        body: raw || undefined,
        signal: AbortSignal.timeout(10_000),
      });
      return { status: res.status, json: (await res.json().catch(() => ({}))) as never };
    },
  };
}

/**
 * Trip start/end, retried like a real tracker would: a gateway restart or a dropped
 * connection must not end the bus's day. Returns null when it never got through.
 */
export async function callWithRetry<T>(
  client: TrackerClient,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ status: number; json: T } | null> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let delay = 500;
  for (let attempt = 1; attempt <= (opts.attempts ?? 8); attempt++) {
    try {
      const res = await client.call<T>(method, path, body);
      if (res.status < 500 && res.status !== 429) return res;
    } catch {
      // network error: the gateway is restarting or the link is down
    }
    await sleep(Math.random() * delay);
    delay = Math.min(delay * 2, 15_000);
  }
  return null;
}

export interface SendOutcome {
  /** 2xx, or a 409 replay (the gateway already has this exact request) */
  delivered: boolean;
  accepted: number;
  rejected: IngestResult["rejected"];
  attempts: number;
  /** a final answer that retrying cannot change (400, 401, 409 trip_not_live) */
  fatal: string | null;
}

export async function sendBatch(
  client: TrackerClient,
  body: unknown,
  opts: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<SendOutcome> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let delay = 500;
  for (let attempt = 1; attempt <= (opts.maxAttempts ?? 8); attempt++) {
    try {
      const res = await client.call<IngestResult & { error?: string }>("POST", "/v1/ingest", body);
      if (res.status === 200) {
        return {
          delivered: true,
          accepted: res.json.accepted,
          rejected: res.json.rejected,
          attempts: attempt,
          fatal: null,
        };
      }
      if (res.status === 409 && res.json.error === "replay") {
        return { delivered: true, accepted: 0, rejected: [], attempts: attempt, fatal: null };
      }
      if (res.status !== 429 && res.status < 500) {
        return {
          delivered: false,
          accepted: 0,
          rejected: [],
          attempts: attempt,
          fatal: `${res.status} ${res.json.error ?? ""}`,
        };
      }
    } catch {
      // network error or timeout: the tracker keeps the batch and tries again
    }
    // exponential backoff with full jitter
    await sleep(Math.random() * delay);
    delay = Math.min(delay * 2, 15_000);
  }
  return {
    delivered: false,
    accepted: 0,
    rejected: [],
    attempts: opts.maxAttempts ?? 8,
    fatal: "gave up",
  };
}
