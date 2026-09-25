/**
 * The web app's Content-Security-Policy (BUILD_PLAN Stage 9). Built per request by the
 * middleware with a fresh nonce: Next.js puts the nonce on its own scripts, and `strict-dynamic`
 * lets those load their chunks — so no inline script an attacker injects can run.
 *
 * Every origin the app talks to is named: the gateway (API + SSE), Supabase (auth), the tile
 * server (MapLibre fetches tiles, glyphs and sprites), and Sentry's ingest when configured.
 * Development relaxes script-src for React's refresh runtime, which needs eval.
 */
export interface CspInput {
  nonce: string;
  dev: boolean;
  gatewayUrl: string;
  supabaseUrl: string;
  tilesUrl: string;
  sentryDsn?: string;
}

const origin = (url: string | undefined) => {
  try {
    return url ? new URL(url).origin : null;
  } catch {
    return null;
  }
};

export function buildCsp(i: CspInput): string {
  const supabase = origin(i.supabaseUrl);
  const connect = [
    "'self'",
    origin(i.gatewayUrl),
    supabase,
    supabase?.replace(/^http/, "ws"), // Supabase realtime/auth over websockets
    origin(i.tilesUrl),
    origin(i.sentryDsn),
  ].filter(Boolean);
  const script = i.dev
    ? ["'self'", "'unsafe-eval'", "'unsafe-inline'"]
    : ["'self'", `'nonce-${i.nonce}'`, "'strict-dynamic'"];
  const directives: [string, string[]][] = [
    ["default-src", ["'self'"]],
    ["script-src", script],
    // MapLibre and React set style attributes; styles cannot run code
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", origin(i.tilesUrl)].filter(Boolean) as string[]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", connect as string[]],
    // MapLibre runs its workers from blob: URLs; sw.js is same-origin
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
    ["frame-ancestors", ["'none'"]],
  ];
  const csp = directives.map(([k, v]) => `${k} ${v.join(" ")}`).join("; ");
  // only where everything is https already: on an http deployment (a LAN demo) it would rewrite
  // every API call to an https URL nobody serves
  return !i.dev && i.gatewayUrl.startsWith("https:") ? `${csp}; upgrade-insecure-requests` : csp;
}

/** A 128-bit nonce, base64 — Web Crypto, so it works in the edge middleware too. */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b));
}
