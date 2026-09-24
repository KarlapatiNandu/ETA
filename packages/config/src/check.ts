/**
 * `pnpm env:check` — run by `pnpm dev` before anything boots, so a missing variable fails
 * with its name instead of as a stack trace three services later.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  EnvError,
  coreEnv,
  gatewayEnv,
  geoServicesEnv,
  loadEnv,
  redisEnv,
  smsEnv,
  supabaseEnv,
} from "./env.ts";

function readDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m?.[1]) out[m[1]] = (m[2] ?? "").replace(/^["']|["']$/g, "");
  }
  return out;
}

const root = resolve(import.meta.dirname, "../../..");
const source = { ...readDotEnv(resolve(root, ".env")), ...process.env };
const all = z.intersection(
  coreEnv.and(supabaseEnv).and(redisEnv).and(geoServicesEnv).and(gatewayEnv),
  smsEnv,
);

try {
  loadEnv(all, source);
  console.log("env: ok");
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
