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
  };
}
