/**
 * Tracker pairing from the command line, until the admin console's pairing screen (Stage 7).
 *
 *   pnpm --filter @busmitra/gateway tracker provision --bus 14 [--device <uid>]
 *   pnpm --filter @busmitra/gateway tracker rotate --device <uid>
 *
 * Prints the secret exactly once, inside a pairing link for the driver app. The secret is
 * stored encrypted (invariant 6) and cannot be read back — lose the link, rotate again.
 */
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { z } from "zod";
import { EnvError, gatewayEnv, loadEnv } from "@busmitra/config";
import { createPgDb, withContext } from "@busmitra/db";
import { provisionTracker, rotateTrackerSecret } from "../services/trackers.ts";

let env;
try {
  env = loadEnv(
    gatewayEnv
      .pick({ TRACKER_SECRET_KEY: true, DRIVER_ORIGIN: true })
      .and(z.object({ DATABASE_URL: z.url() })),
  );
} catch (err) {
  if (err instanceof EnvError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { bus: { type: "string" }, device: { type: "string" } },
});
const db = createPgDb(env.DATABASE_URL);
const ctx = { actorId: null, ip: null, userAgent: "tracker-cli" };
const link = (uid: string, secret: string) =>
  `${env.DRIVER_ORIGIN}/#pair=${encodeURIComponent(uid)}.${secret}`;

try {
  if (positionals[0] === "provision" && values.bus) {
    const uid = values.device ?? `phone-${values.bus}-${randomBytes(3).toString("hex")}`;
    const out = await withContext(db, ctx, (q) =>
      provisionTracker(q, env.TRACKER_SECRET_KEY, { busNumber: values.bus!, deviceUid: uid }),
    );
    console.log(
      `bus ${values.bus} paired to device ${uid}\nopen on the driver's phone:\n  ${link(uid, out.secret)}`,
    );
  } else if (positionals[0] === "rotate" && values.device) {
    const secret = await withContext(db, ctx, (q) =>
      rotateTrackerSecret(q, env.TRACKER_SECRET_KEY, values.device!),
    );
    if (!secret) throw new Error(`no tracker ${values.device}`);
    console.log(
      `rotated; the old secret keeps working for 10 minutes\n  ${link(values.device, secret)}`,
    );
  } else {
    console.error(
      "usage: tracker provision --bus <number> [--device <uid>] | tracker rotate --device <uid>",
    );
    process.exitCode = 2;
  }
} finally {
  await db.close();
}
