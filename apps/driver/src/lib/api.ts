import { signingPayload, TRACKER_HEADERS } from "@busmitra/contracts/signing";

/**
 * Signed requests to the gateway (ARCH §10): HMAC-SHA256 over the payload built by the same
 * function the gateway verifies with. WebCrypto, so no crypto library ships to the phone.
 */

export interface Pairing {
  deviceUid: string;
  secret: string;
}

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(
  secret: string,
  message: string,
  subtle: SubtleCrypto = crypto.subtle,
) {
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await subtle.sign("HMAC", key, enc.encode(message)));
}

export class NetworkError extends Error {
  constructor(cause: unknown) {
    super("network unreachable", { cause });
    this.name = "NetworkError";
  }
}

export interface ApiResponse<T> {
  status: number;
  json: T;
}

export interface SignedClient {
  request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<ApiResponse<T>>;
  /** unsigned reachability probe — is the gateway there at all, beyond navigator.onLine? */
  probe(): Promise<boolean>;
}

/** `/#pair=<device_uid>.<secret>` — the link the tracker CLI (and later the admin console) prints. */
export function parsePairing(hash: string): Pairing | null {
  const m = /[#&]pair=([^&]+)/.exec(hash);
  if (!m) return null;
  const raw = decodeURIComponent(m[1]!);
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return null;
  return { deviceUid: raw.slice(0, dot), secret: raw.slice(dot + 1) };
}

export function signedClient(
  gateway: string,
  pairing: Pairing,
  opts: { fetch?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
): SignedClient {
  const f = opts.fetch ?? fetch.bind(globalThis);
  const now = opts.now ?? Date.now;
  let lastTs = 0;
  return {
    async request(method, path, body) {
      const raw = body === undefined ? "" : JSON.stringify(body);
      // strictly increasing seconds: two requests in the same second must not share a nonce
      lastTs = Math.max(lastTs + 1, Math.floor(now() / 1000));
      const ts = String(lastTs);
      const sig = await hmacHex(pairing.secret, signingPayload(pairing.deviceUid, ts, raw));
      let res: Response;
      try {
        res = await f(`${gateway}${path}`, {
          method,
          headers: {
            ...(raw ? { "content-type": "application/json" } : {}),
            [TRACKER_HEADERS.device]: pairing.deviceUid,
            [TRACKER_HEADERS.timestamp]: ts,
            [TRACKER_HEADERS.signature]: sig,
          },
          body: raw || undefined,
          signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
        });
      } catch (err) {
        throw new NetworkError(err);
      }
      return { status: res.status, json: (await res.json().catch(() => ({}))) as never };
    },
    async probe() {
      try {
        return (await f(`${gateway}/healthz`, { signal: AbortSignal.timeout(5000) })).ok;
      } catch {
        return false;
      }
    },
  };
}
