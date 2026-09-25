import { describe, expect, it } from "vitest";
import { buildCsp, newNonce } from "./csp";

const base = {
  nonce: "abc123",
  gatewayUrl: "https://api.busmitra.in",
  supabaseUrl: "https://xyz.supabase.co",
  tilesUrl: "https://tiles.busmitra.in/data/v3.json",
  sentryDsn: "https://key@o1.ingest.sentry.io/42",
};

describe("buildCsp (Stage 9)", () => {
  it("production: nonce + strict-dynamic, no unsafe script sources, every origin named", () => {
    const csp = buildCsp({ ...base, dev: false });
    const dir = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `));
    expect(dir("script-src")).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(dir("connect-src")).toBe(
      "connect-src 'self' https://api.busmitra.in https://xyz.supabase.co wss://xyz.supabase.co https://tiles.busmitra.in https://o1.ingest.sentry.io",
    );
    expect(dir("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(dir("object-src")).toBe("object-src 'none'");
    expect(csp.endsWith("upgrade-insecure-requests")).toBe(true);
  });

  it("development allows the refresh runtime, and a missing DSN adds nothing", () => {
    const csp = buildCsp({ ...base, dev: true, sentryDsn: undefined });
    expect(csp).toContain("script-src 'self' 'unsafe-eval' 'unsafe-inline'");
    expect(csp).not.toContain("sentry");
    expect(csp).not.toContain("upgrade-insecure-requests");
    // a production build served over plain http must not upgrade its API calls
    expect(buildCsp({ ...base, dev: false, gatewayUrl: "http://192.168.1.20:4000" })).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("nonces are fresh and 128-bit", () => {
    const a = newNonce();
    expect(a).not.toBe(newNonce());
    expect(atob(a)).toHaveLength(16);
  });
});
