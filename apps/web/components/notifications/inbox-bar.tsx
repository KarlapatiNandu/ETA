"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useFleet } from "@/lib/store/fleet";
import { useInbox } from "@/lib/store/inbox";
import { me } from "./student-api";

declare global {
  interface Window {
    /** pushes this page saw arrive via the service worker — read by tests/e2e/stage6.ts */
    __bmPushes?: { data: unknown; at: number; received: number }[];
  }
}

/**
 * The bell and its badge (Stage 6). Counts are re-derived from the server each time the stream
 * (re)connects — per-user frames are never replayed (invariant 9) — and move live in between.
 */
export function Bell() {
  const unread = useInbox((s) => s.unread);
  const critical = useInbox((s) => s.unackedCritical);
  const connection = useFleet((s) => s.connection);
  const path = usePathname();
  // a push landed in this browser's service worker (public/sw.js): refresh the badge now
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (ev: MessageEvent) => {
      if ((ev.data as { type?: string } | null)?.type !== "bm:push") return;
      (window.__bmPushes ??= []).push({
        ...(ev.data as { data: unknown; at: number }),
        received: Date.now(),
      });
      me<{ unread: number; unacked_critical: number }>("/v1/notifications/summary")
        .then(useInbox.getState().setSummary)
        .catch(() => undefined);
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    if (connection !== "live") return;
    me<{ unread: number; unacked_critical: number }>("/v1/notifications/summary")
      .then(useInbox.getState().setSummary)
      .catch(() => undefined);
  }, [connection, path]);
  return (
    <Link
      href="/notifications"
      aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
      className="relative"
      data-testid="bell"
    >
      Alerts
      {unread > 0 && (
        <span
          className={`ml-1 inline-flex min-w-5 justify-center rounded-full px-1.5 text-xs font-semibold ${critical ? "bg-dark text-white" : "bg-live text-live-ink"}`}
        >
          {unread}
        </span>
      )}
    </Link>
  );
}

const TONE = [
  "border-dark bg-dark/10",
  "border-degraded bg-degraded/10",
  "border-line bg-panel",
  "border-line bg-panel",
];

/**
 * A notification arriving while the app is open shows here — the phone's own notification is
 * often suppressed for a focused tab. A critical (T0) one stays until acknowledged; the rest can
 * be dismissed.
 */
export function ArrivalBanner() {
  const latest = useInbox((s) => s.latest);
  const dismiss = useInbox((s) => s.dismiss);
  const router = useRouter();
  if (!latest) return null;
  const critical = latest.tier === 0;
  return (
    <div
      role={critical ? "alertdialog" : "status"}
      aria-live={critical ? "assertive" : "polite"}
      data-testid="arrival"
      className={`mb-4 rounded-2xl border p-4 ${TONE[latest.tier] ?? TONE[3]}`}
    >
      <p className={`font-semibold ${critical ? "text-dark" : ""}`}>{latest.title}</p>
      {latest.body && <p className="mt-1 text-sm">{latest.body}</p>}
      <div className="mt-3 flex gap-3 text-sm">
        {critical ? (
          <button
            className="rounded-lg bg-dark px-3 py-1.5 font-semibold text-white"
            onClick={() =>
              void me(`/v1/notifications/${latest.id}/ack`, { method: "POST" }).then(() => {
                useInbox.setState((s) => ({
                  unackedCritical: Math.max(0, s.unackedCritical - 1),
                  unread: Math.max(0, s.unread - 1),
                }));
                dismiss();
              })
            }
          >
            I understand
          </button>
        ) : (
          <button className="text-muted" onClick={dismiss}>
            Dismiss
          </button>
        )}
        <button
          className="text-muted underline"
          onClick={() => (dismiss(), router.push("/notifications"))}
        >
          All alerts
        </button>
      </div>
    </div>
  );
}
