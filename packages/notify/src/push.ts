import webpush from "web-push";

/**
 * Web Push (VAPID) transport — ARCHITECTURE §6.3.
 *
 * The only signal Web Push gives us is the HTTP status of our own POST: `201` means the push
 * *service* accepted the message, not that a phone showed it. There is no receipt to wait for,
 * so the caller decides on this status, synchronously (SMS fallback for T0/T1).
 */

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** replaces an earlier notification with the same tag instead of stacking (T3 progress) */
  tag?: string | null;
  renotify?: boolean;
  requireInteraction?: boolean;
  /** where a tap goes, and the notification-center id for read/ack */
  data: { notificationId: string; url: string; tier: number };
  actions?: { action: string; title: string }[];
}

export interface PushOptions {
  urgency: "very-low" | "low" | "normal" | "high";
  ttlS: number;
  /** push-service-side collapse: a newer message with the same topic replaces a queued one */
  topic?: string;
}

export interface PushResult {
  /** HTTP status from the push service; 0 = network failure */
  status: number;
}

export interface PushSender {
  send(target: PushTarget, msg: PushMessage, opts: PushOptions): Promise<PushResult>;
}

/** A 2xx is accepted; 404/410 mean the subscription is gone for good (prune it). */
export const pushAccepted = (s: number) => s >= 200 && s < 300;
export const pushGone = (s: number) => s === 404 || s === 410;

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  /** mailto: or https: contact, required by the push services */
  subject: string;
}

export function createWebPush(vapid: VapidConfig, timeoutMs = 5000): PushSender {
  return {
    async send(target, msg, opts) {
      try {
        const res = await webpush.sendNotification(
          { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
          JSON.stringify(msg),
          {
            vapidDetails: vapid,
            TTL: opts.ttlS,
            urgency: opts.urgency,
            // the Topic header allows [A-Za-z0-9_-]{1,32}
            ...(opts.topic
              ? { topic: opts.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) }
              : {}),
            timeout: timeoutMs,
          },
        );
        return { status: res.statusCode };
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return { status: typeof status === "number" ? status : 0 };
      }
    },
  };
}

/** Generate a VAPID key pair (once, at setup: `pnpm --filter @busmitra/notify vapid`). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
