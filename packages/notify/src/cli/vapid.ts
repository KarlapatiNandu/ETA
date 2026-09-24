/**
 * Print a fresh VAPID key pair for .env (Stage 6). Run once per environment:
 *   pnpm --filter @busmitra/notify vapid
 * Rotating the pair invalidates every browser subscription.
 */
import { generateVapidKeys } from "../push.ts";

const { publicKey, privateKey } = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}`);
