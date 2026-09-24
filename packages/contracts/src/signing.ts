/**
 * Tracker request signing (ARCH §10), with no dependencies: the driver PWA imports this
 * module directly (`@busmitra/contracts/signing`) so that Zod never ships to the phone.
 */

export const TRACKER_HEADERS = {
  device: "x-device-id",
  /** unix seconds, decimal; must be within ±5 min of the gateway clock */
  timestamp: "x-timestamp",
  /** lowercase hex HMAC-SHA256 */
  signature: "x-signature",
} as const;

/** The exact string that is signed. `body` is the raw request body ("" for a GET). */
export function signingPayload(deviceUid: string, timestamp: string, body: string): string {
  return `${deviceUid}\n${timestamp}\n${body}`;
}
