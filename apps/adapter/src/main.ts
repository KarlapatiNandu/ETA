/**
 * The hardware tracker adapter (BUILD_PLAN Stage 9, ADR-0008): GT06 trackers in, the driver
 * app's signed ingest contract out. Runs beside the gateway; the gateway does not know it exists.
 *
 *   GATEWAY_URL=… ADAPTER_DEVICES_FILE=… pnpm --filter @busmitra/adapter start
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import { adapterEnv, coreEnv, EnvError, loadEnv } from "@busmitra/config";
import { startAdapter } from "./server.ts";

let env;
try {
  env = loadEnv(coreEnv.and(adapterEnv));
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const DevicesFile = z.record(
  z.string().regex(/^\d{15}$/, "keys are 15-digit IMEIs"),
  z.object({
    secret: z.string().min(16),
    moving_interval_s: z.number().int().min(1).max(300).default(10),
    idle_interval_s: z.number().int().min(1).max(300).default(60),
  }),
);
const devices = Object.fromEntries(
  Object.entries(DevicesFile.parse(JSON.parse(readFileSync(env.ADAPTER_DEVICES_FILE, "utf8")))).map(
    ([imei, d]) => [
      imei,
      { secret: d.secret, movingIntervalS: d.moving_interval_s, idleIntervalS: d.idle_interval_s },
    ],
  ),
);

const log = (msg: string, extra?: Record<string, unknown>) =>
  console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const adapter = startAdapter(env.ADAPTER_PORT, { gateway: env.GATEWAY_URL, devices, log });
log("adapter: listening", { port: env.ADAPTER_PORT, devices: Object.keys(devices).length });

const shutdown = async () => {
  await adapter.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
