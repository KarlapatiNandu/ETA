"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { NotificationItem } from "@busmitra/contracts";
import { me } from "@/components/notifications/student-api";
import { PushSetup } from "@/components/notifications/push-setup";
import { GatewayError } from "@/lib/gateway";
import { useInbox } from "@/lib/store/inbox";

const TIER = [
  { name: "Critical", cls: "border-dark text-dark" },
  { name: "Urgent", cls: "border-degraded text-degraded" },
  { name: "Important", cls: "border-line text-ink" },
  { name: "Info", cls: "border-line text-muted" },
  { name: "Background", cls: "border-line text-muted" },
];
const TICKET: Record<string, string> = {
  open: "Out of service",
  acknowledged: "Being handled",
  resolved: "Back in service",
  cancelled: "Cancelled",
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Markdown the TD may use: **bold** and line breaks — rendered as text, never as HTML. */
function Markdown({ text }: { text: string }) {
  return (
    <p className="mt-1 whitespace-pre-line text-sm">
      {text
        .split(/(\*\*[^*]+\*\*)/g)
        .map((part, i) =>
          part.startsWith("**") && part.endsWith("**") ? (
            <strong key={i}>{part.slice(2, -2)}</strong>
          ) : (
            part
          ),
        )}
    </p>
  );
}

/**
 * The notification center (BUILD_PLAN Stage 6): the record of every alert, written whether or
 * not a push or SMS got through (invariant 14). Tier filter, unread, ticket cards whose status
 * follows the ticket live, acknowledgement for critical alerts, and the inline actions a push
 * notification's buttons lead to.
 */
function Centre() {
  const params = useSearchParams();
  const router = useRouter();
  const [tier, setTier] = useState<number | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const liveTickets = useInbox((s) => s.tickets);
  const arrivals = useInbox((s) => s.unread);
  const acted = useRef(false);

  const query = useCallback(
    (before?: string) =>
      `/v1/notifications?limit=30${tier !== null ? `&tier=${tier}` : ""}${unreadOnly ? "&unread=1" : ""}${before ? `&before=${encodeURIComponent(before)}` : ""}`,
    [tier, unreadOnly],
  );
  const load = useCallback(async () => {
    const r = await me<{ items: NotificationItem[]; next: string | null }>(query());
    setItems(r.items);
    setNext(r.next);
  }, [query]);
  // reload on filter changes and whenever a new notification arrives over the stream
  useEffect(() => {
    void load().catch(() => setNotice("Could not load your alerts."));
  }, [load, arrivals]);

  const act = useCallback(
    async (id: string, action: "follow" | "not_today") => {
      try {
        const r = await me<{ muted_until?: string }>(`/v1/notifications/${id}/actions`, {
          body: { action },
        });
        setNotice(
          action === "follow"
            ? "Following — you will get stop updates and a leave-now alert."
            : `Muted until midnight${r.muted_until ? "" : ""}. It stays starred for tomorrow.`,
        );
        await load();
      } catch (e) {
        if (e instanceof GatewayError && e.status === 409) {
          setNotice("Pin where you start from first, so we know which stop to follow.");
          router.push("/settings");
        } else setNotice(e instanceof Error ? e.message : "That did not work.");
      }
    },
    [load, router],
  );

  // a tap on a push notification's action button lands here (public/sw.js)
  useEffect(() => {
    const a = params.get("act");
    const n = params.get("n");
    if (acted.current || !n) return;
    acted.current = true;
    if (a === "follow" || a === "not_today") void act(n, a);
    else void me(`/v1/notifications/${n}/read`, { method: "POST" }).catch(() => undefined);
  }, [params, act]);

  const markRead = async (n: NotificationItem) => {
    if (n.read_at) return;
    await me(`/v1/notifications/${n.id}/read`, { method: "POST" }).catch(() => undefined);
    setItems((xs) =>
      xs.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)),
    );
    useInbox.setState((s) => ({ unread: Math.max(0, s.unread - 1) }));
  };
  const ack = async (n: NotificationItem) => {
    await me(`/v1/notifications/${n.id}/ack`, { method: "POST" });
    setItems((xs) =>
      xs.map((x) =>
        x.id === n.id
          ? {
              ...x,
              acknowledged_at: new Date().toISOString(),
              read_at: x.read_at ?? new Date().toISOString(),
            }
          : x,
      ),
    );
    useInbox.setState((s) => ({ unackedCritical: Math.max(0, s.unackedCritical - 1) }));
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Alerts</h1>
        <button
          className="text-sm text-muted underline"
          onClick={() =>
            void me("/v1/notifications/read-all", { method: "POST" }).then(() => {
              useInbox.setState({ unread: 0 });
              return load();
            })
          }
        >
          Mark all read
        </button>
      </div>
      <PushSetup compact />
      <div className="mb-4 flex flex-wrap gap-1 text-sm" role="group" aria-label="Filter">
        {[null, 0, 1, 2, 3, 4].map((t) => (
          <button
            key={String(t)}
            aria-pressed={tier === t}
            onClick={() => setTier(t)}
            className={`rounded-lg px-3 py-1 ${tier === t ? "bg-raised text-ink" : "text-muted"}`}
          >
            {t === null ? "All" : TIER[t]!.name}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1 text-muted">
          <input
            type="checkbox"
            checked={unreadOnly}
            onChange={(e) => setUnreadOnly(e.target.checked)}
          />{" "}
          Unread
        </label>
      </div>
      {notice && (
        <p role="status" className="mb-3 rounded-lg bg-live/10 p-3 text-sm">
          {notice}
        </p>
      )}
      <ul className="space-y-3" data-testid="centre">
        {items.map((n) => {
          const status = n.ticket ? (liveTickets[n.ticket.id] ?? n.ticket.status) : null;
          const needsAck = n.tier === 0 && !n.acknowledged_at;
          return (
            <li
              key={n.id}
              onClick={() => void markRead(n)}
              data-tier={n.tier}
              className={`rounded-2xl border bg-panel p-4 ${TIER[n.tier]!.cls.split(" ")[0]} ${n.read_at ? "opacity-80" : ""}`}
            >
              <div className="flex items-start gap-2">
                {!n.read_at && (
                  <span
                    aria-label="unread"
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-live"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-muted">
                    <span className={TIER[n.tier]!.cls.split(" ")[1]}>{TIER[n.tier]!.name}</span> ·{" "}
                    {when(n.created_at)}
                    {n.channel === "sms" && " · sent by SMS"}
                  </p>
                  <p className="font-semibold">{n.title}</p>
                  {n.payload.markdown ? (
                    <Markdown text={n.payload.markdown} />
                  ) : (
                    n.body && <p className="mt-1 text-sm">{n.body}</p>
                  )}
                  {status && (
                    <p
                      data-testid="ticket-card"
                      className={`mt-2 inline-block rounded-full border px-2 py-0.5 text-xs ${status === "resolved" ? "border-live text-live" : "border-dark text-dark"}`}
                    >
                      {TICKET[status] ?? status}
                    </p>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2 text-sm">
                    {needsAck && (
                      <button
                        className="rounded-lg bg-dark px-3 py-1.5 font-semibold text-white"
                        onClick={() => void ack(n)}
                      >
                        I understand
                      </button>
                    )}
                    {n.payload.actions?.map((a) => (
                      <button
                        key={a.action}
                        className="rounded-lg border border-line px-3 py-1.5"
                        onClick={(e) => {
                          e.stopPropagation();
                          void act(n.id, a.action as "follow" | "not_today");
                        }}
                      >
                        {a.title}
                      </button>
                    ))}
                    {n.trip_id && (
                      <Link
                        href={n.payload.url ?? "/"}
                        className="px-1 py-1.5 text-muted underline"
                      >
                        Open the map
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {!items.length && (
        <p className="text-muted">No alerts{unreadOnly || tier !== null ? " here" : " yet"}.</p>
      )}
      {next && (
        <button
          className="mt-4 w-full rounded-lg border border-line py-2 text-sm"
          onClick={() =>
            void me<{ items: NotificationItem[]; next: string | null }>(query(next)).then((r) => {
              setItems((xs) => [...xs, ...r.items]);
              setNext(r.next);
            })
          }
        >
          Older
        </button>
      )}
    </div>
  );
}

export default function NotificationsPage() {
  return (
    <Suspense>
      <Centre />
    </Suspense>
  );
}
