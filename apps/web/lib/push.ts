"use client";
import { gateway } from "./gateway";
import { sameKey, urlBase64ToUint8Array } from "./push-key";

/**
 * Push subscription lifecycle (BUILD_PLAN Stage 6): register the service worker, ask permission
 * only when the student taps "Turn on alerts", subscribe with the VAPID key the gateway
 * publishes, and hand the subscription to the gateway. The gateway prunes it on 404/410.
 *
 * iOS delivers Web Push only to an *installed* PWA (Safari 16.4+, from the Home Screen). An iOS
 * student in the browser tab is shown how to install instead of a button that cannot work, and
 * their T0/T1 alerts come by SMS meanwhile (ARCH §6.3).
 */

export type PushState =
  | "unsupported" // no service worker / PushManager
  | "ios-needs-install" // iOS Safari, not installed: push cannot work until it is
  | "no-server-key" // the gateway has push turned off
  | "denied" // the student blocked notifications in the browser
  | "off" // supported, not subscribed
  | "on";

export const isIos = () =>
  typeof navigator !== "undefined" &&
  (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

async function registration(): Promise<ServiceWorkerRegistration> {
  return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

export async function pushState(token: string | undefined): Promise<PushState> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return "unsupported";
  if (isIos() && !isStandalone()) return "ios-needs-install";
  if (!("PushManager" in window) || !("Notification" in window)) return "unsupported";
  const { publicKey } = await gateway<{ publicKey: string | null }>("/v1/push/config", { token });
  if (!publicKey) return "no-server-key";
  if (Notification.permission === "denied") return "denied";
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return "off";
  if (!sameKey(sub.options.applicationServerKey, publicKey)) {
    // the server's key changed since this browser subscribed: drop the dead subscription and,
    // since permission is already granted, subscribe again with the new key — no tap needed
    await gateway("/v1/push/subscriptions", {
      token,
      method: "DELETE",
      body: { endpoint: sub.endpoint },
    }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
    if (Notification.permission !== "granted") return "off";
    const fresh = await reg.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
      .catch(() => null);
    if (!fresh) return "off";
    await send(fresh, token);
    return "on";
  }
  // re-send on every visit: cheap, and it heals a subscription the gateway pruned or moved
  await send(sub, token);
  return "on";
}

async function send(sub: PushSubscription, token: string | undefined) {
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await gateway("/v1/push/subscriptions", {
    token,
    body: { endpoint: json.endpoint, keys: json.keys, standalone: isStandalone() },
  });
}

/** Must be called from a tap: browsers only show the permission prompt for a user gesture. */
export async function turnOnPush(token: string | undefined): Promise<PushState> {
  const { publicKey } = await gateway<{ publicKey: string | null }>("/v1/push/config", { token });
  if (!publicKey) return "no-server-key";
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return permission === "denied" ? "denied" : "off";
  const reg = await registration();
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    }));
  await send(sub, token);
  return "on";
}

export async function turnOffPush(token: string | undefined): Promise<PushState> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await gateway("/v1/push/subscriptions", {
      token,
      method: "DELETE",
      body: { endpoint: sub.endpoint },
    }).catch(() => undefined);
    await sub.unsubscribe();
  }
  return "off";
}
