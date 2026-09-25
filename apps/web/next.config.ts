import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

// One .env at the repo root serves every app (see .env.example); Next only looks in apps/web.
try {
  process.loadEnvFile("../../.env");
} catch {
  // no root .env (CI, production): variables come from the real environment
}

export default function config(phase: string): NextConfig {
  return {
    // `next dev` and `next build` sharing .next means a `pnpm build` while `pnpm dev` runs
    // overwrites the dev server's output and every page 500s until it restarts.
    distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
    // workspace packages ship TypeScript source (M00 decision)
    transpilePackages: ["@busmitra/contracts", "@busmitra/geo", "@busmitra/ui"],
    reactStrictMode: true,
    poweredByHeader: false,
    eslint: { ignoreDuringBuilds: true }, // `pnpm lint` runs the repo's flat config
    // Stage 9: the headers that do not depend on the request (CSP is per request: middleware.ts)
    async headers() {
      const common = [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        // location for "use my location" and the on-bus prompt; nothing else
        {
          key: "Permissions-Policy",
          value: "geolocation=(self), camera=(), microphone=(), payment=(), usb=()",
        },
        { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
      ];
      const hsts =
        phase === PHASE_DEVELOPMENT_SERVER
          ? []
          : [
              {
                key: "Strict-Transport-Security",
                value: "max-age=63072000; includeSubDomains; preload",
              },
            ];
      return [{ source: "/:path*", headers: [...common, ...hsts] }];
    },
  };
}
