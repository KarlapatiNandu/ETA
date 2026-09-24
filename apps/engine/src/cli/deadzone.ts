/**
 * Run the dead-zone learner once, now (BUILD_PLAN Stage 8) — the same pass the engine runs
 * nightly at 02:30 IST. Idempotent: safe while the engine is running.
 *
 *   pnpm --filter @busmitra/engine deadzone
 */
import { z } from "zod";
import { EnvError, loadEnv } from "@busmitra/config";
import { createPgDb } from "@busmitra/db";
import { learnDeadZones } from "../workers/deadzone.ts";

let env;
try {
  env = loadEnv(z.object({ DATABASE_URL: z.url() }));
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
const db = createPgDb(env.DATABASE_URL);
try {
  console.log(JSON.stringify(await learnDeadZones(db), null, 2));
} finally {
  await db.close();
}
