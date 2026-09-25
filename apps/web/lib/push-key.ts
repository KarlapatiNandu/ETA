/** VAPID key helpers for lib/push.ts — pure, so they are testable without a browser. */

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/**
 * Whether a subscription was made with the gateway's current VAPID key. A subscription is bound
 * to the key it was created with: after a rotation (a leaked key, Stage 8 chaos drill) every push
 * to it is refused with a 403, for ever. Re-sending it on each visit would never heal it.
 */
export function sameKey(
  subscribedWith: ArrayBuffer | null | undefined,
  publicKey: string,
): boolean {
  if (!subscribedWith) return true; // the browser does not say: assume it is current
  const a = new Uint8Array(subscribedWith);
  const b = urlBase64ToUint8Array(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
