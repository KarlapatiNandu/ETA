"use client";
import { useEffect, useState } from "react";
import { TIERS, type AudienceKind } from "@busmitra/contracts";
import { ConfirmSend, type SendPreview } from "@/components/admin/confirm-send";
import type { Bus, RouteOption } from "@/components/admin/types";
import { ErrorText } from "@/components/ui";
import { admin, AdminError, fmtTime, plural, useAdmin } from "@/lib/admin";

type Announcement = {
  id: string;
  tier: number;
  audience: string;
  audience_label: string | null;
  title: string;
  body_md: string;
  confirmed_count: number;
  scheduled_for: string | null;
  published_at: string | null;
  created_name: string;
  state: "sent" | "scheduled" | "cancelled";
  delivery: {
    recipients: number;
    pushed: number;
    texted: number;
    in_app_only: number;
    pending: number;
    read: number;
  } | null;
};

const AUDIENCES: [AudienceKind, string][] = [
  ["all", "All students"],
  ["juniors", "Juniors"],
  ["seniors", "Seniors"],
  ["route", "One route"],
  ["bus", "One bus"],
  ["custom", "Specific students"],
];

/** Phones show plain text: drop the few markdown marks the composer allows. */
const plainText = (md: string) =>
  md
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|\s)_(.+?)_/g, "$1$2")
    .trim();

const field =
  "w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-live";

export default function AnnouncementsPage() {
  const list = useAdmin<{ announcements: Announcement[] }>("/v1/admin/announcements");
  const buses = useAdmin<{ buses: Bus[] }>("/v1/admin/buses");
  const routes = useAdmin<{ routes: RouteOption[] }>("/v1/admin/route-options");

  const [tier, setTier] = useState(2);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState<AudienceKind>("all");
  const [ref, setRef] = useState("");
  const [rolls, setRolls] = useState("");
  const [later, setLater] = useState(false);
  const [when, setWhen] = useState("");
  const [count, setCount] = useState<{ count: number; unmatched: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [send, setSend] = useState<SendPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const rollList = rolls
    .split(/[\s,;]+/)
    .map((r) => r.trim())
    .filter(Boolean);
  const spec = {
    audience,
    ...(audience === "route" || audience === "bus" ? { audience_ref: ref || null } : {}),
    ...(audience === "custom" ? { roll_nos: rollList } : {}),
  };
  const specKey = JSON.stringify(spec);
  const specReady =
    ((audience !== "route" && audience !== "bus") || !!ref) &&
    (audience !== "custom" || rollList.length > 0);

  // the live recipient count, re-resolved as the audience changes
  useEffect(() => {
    if (!specReady) return setCount(null);
    const t = setTimeout(() => {
      admin<{ count: number; unmatched: string[] }>("/v1/admin/audience", {
        body: JSON.parse(specKey),
      })
        .then(setCount)
        .catch(() => setCount(null));
    }, 300);
    return () => clearTimeout(t);
  }, [specKey, specReady]);

  function review() {
    setError(null);
    setDone(null);
    if (!title.trim() || !body.trim()) return setError("Write a title and a message.");
    if (!count) return setError("Choose who it is for.");
    if (count.count === 0)
      return setError("Nobody is in this audience yet — nothing would be sent.");
    if (later && (!when || new Date(when).getTime() < Date.now() + 60_000))
      return setError("Pick a send time at least a minute from now.");
    setSend({
      tier,
      title: title.trim(),
      body: plainText(body),
      count: count.count,
      action: later
        ? `Schedule for ${fmtTime(new Date(when).toISOString())}`
        : "Send announcement now",
    });
  }

  const tierInfo = TIERS[tier]!;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold">New announcement</h1>
        <div className="mt-4 grid gap-6 lg:grid-cols-2">
          <div className="space-y-4 text-sm">
            <fieldset>
              <legend className="mb-2 text-muted">How loud?</legend>
              <div className="space-y-1">
                {TIERS.map((t) => (
                  <label
                    key={t.tier}
                    className="flex cursor-pointer items-start gap-2 rounded-lg p-2 hover:bg-raised"
                  >
                    <input
                      type="radio"
                      name="tier"
                      checked={tier === t.tier}
                      onChange={() => setTier(t.tier)}
                      className="mt-1"
                    />
                    <span>
                      <strong className={t.tier === 0 ? "text-dark" : ""}>{t.name}</strong>
                      <span className="text-muted"> — {t.effect}</span>
                      <span className="block text-xs text-muted">Use for: {t.use}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <label className="block">
              <span className="mb-1 block text-muted">Title (shown in bold on the phone)</span>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={80}
                className={field}
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-muted">Message — **bold** works</span>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                maxLength={2000}
                className={field}
              />
            </label>

            <fieldset>
              <legend className="mb-2 text-muted">Who is it for?</legend>
              <div className="flex flex-wrap gap-2">
                {AUDIENCES.map(([a, label]) => (
                  <button
                    key={a}
                    type="button"
                    aria-pressed={audience === a}
                    onClick={() => {
                      setAudience(a);
                      setRef("");
                    }}
                    className={`rounded-lg border px-3 py-1.5 ${audience === a ? "border-live text-ink" : "border-line text-muted"}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {audience === "route" && (
                <select
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  aria-label="Route"
                  className={`${field} mt-2`}
                >
                  <option value="">Choose a route…</option>
                  {routes.data?.routes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name} ({r.direction})
                    </option>
                  ))}
                </select>
              )}
              {audience === "bus" && (
                <select
                  value={ref}
                  onChange={(e) => setRef(e.target.value)}
                  aria-label="Bus"
                  className={`${field} mt-2`}
                >
                  <option value="">Choose a bus…</option>
                  {buses.data?.buses.map((b) => (
                    <option key={b.id} value={b.id}>
                      Bus {b.bus_number}
                    </option>
                  ))}
                </select>
              )}
              {audience === "custom" && (
                <textarea
                  value={rolls}
                  onChange={(e) => setRolls(e.target.value)}
                  rows={3}
                  aria-label="Roll numbers"
                  placeholder="Paste roll numbers, separated by spaces, commas or new lines"
                  className={`${field} mt-2`}
                />
              )}
              {(audience === "route" || audience === "bus") && (
                <p className="mt-1 text-xs text-muted">
                  Students who starred the bus, or who are following it today.
                </p>
              )}
            </fieldset>

            <label className="flex items-center gap-2">
              <input type="checkbox" checked={later} onChange={(e) => setLater(e.target.checked)} />
              Send later
              {later && (
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  aria-label="Send at"
                  className="rounded-lg border border-line bg-canvas px-2 py-1"
                />
              )}
            </label>
          </div>

          <div className="space-y-4">
            <figure className="rounded-xl border border-line bg-canvas p-4">
              <figcaption className="mb-2 text-xs uppercase tracking-wide text-muted">
                Preview
              </figcaption>
              <p className="text-xs text-muted">
                Tier {tier} · {tierInfo.name}
              </p>
              <p className="font-semibold">{title || "Title"}</p>
              <p className="mt-1 whitespace-pre-line text-sm">
                {plainText(body) || "Your message"}
              </p>
            </figure>
            <p className="text-lg font-semibold" role="status" data-testid="audience-count">
              {count ? `Reaches ${plural(count.count, "student")}` : "Choose who it is for"}
            </p>
            {count?.unmatched.length ? (
              <p className="text-sm text-degraded">
                Not found or not signed up yet, so they will not be notified:{" "}
                {count.unmatched.join(", ")}
              </p>
            ) : null}
            <ErrorText>{error}</ErrorText>
            {done && <p className="text-sm text-live">{done}</p>}
            <button
              onClick={review}
              className="rounded-lg bg-live px-4 py-2.5 font-semibold text-black"
            >
              Review and send…
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="font-semibold">Recent announcements</h2>
        <ul className="mt-3 space-y-3 text-sm">
          {list.data?.announcements.map((a) => (
            <li key={a.id} className="border-t border-line pt-3">
              <strong>{a.title}</strong>{" "}
              <span className="text-muted">
                · T{a.tier} · {a.audience_label ?? a.audience} ·{" "}
                {plural(a.confirmed_count, "student")} · {a.created_name}
              </span>
              <span className="block text-muted">
                {a.state === "sent"
                  ? `Sent ${fmtTime(a.published_at)}`
                  : a.state === "scheduled"
                    ? `Scheduled for ${fmtTime(a.scheduled_for)}`
                    : "Cancelled"}
                {a.delivery && a.delivery.recipients > 0 && (
                  <span className="ml-2">
                    · {a.delivery.pushed} pushed · {a.delivery.texted} by SMS ·{" "}
                    {a.delivery.in_app_only} in-app only
                    {a.delivery.pending
                      ? ` · ${a.delivery.pending} waiting (quiet hours)`
                      : ""} · {a.delivery.read} read
                  </span>
                )}
                {a.state === "scheduled" && (
                  <button
                    className="ml-3 text-dark"
                    onClick={() =>
                      void admin(`/v1/admin/announcements/${a.id}/cancel`, { method: "POST" })
                        .then(list.reload)
                        .catch((e) =>
                          setError(e instanceof AdminError ? e.message : "Could not cancel."),
                        )
                    }
                  >
                    Cancel it
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {send && (
        <ConfirmSend
          preview={send}
          onClose={() => setSend(null)}
          onConfirm={async (confirmed, typed) => {
            const res = await admin<{ state: string; recipients: number }>(
              "/v1/admin/announcements",
              {
                body: {
                  tier,
                  title: title.trim(),
                  body_md: body.trim(),
                  ...spec,
                  scheduled_for: later ? new Date(when).toISOString() : null,
                  confirm_count: confirmed,
                  ...(typed ? { confirm_text: typed } : {}),
                },
              },
            );
            setSend(null);
            setDone(
              res.state === "scheduled"
                ? "Scheduled."
                : `Sent to ${plural(res.recipients, "student")}.`,
            );
            setTitle("");
            setBody("");
            await list.reload();
          }}
        />
      )}
    </div>
  );
}
