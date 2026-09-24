"use client";
import { useEffect, useRef, useState } from "react";
import { TIERS } from "@busmitra/contracts";
import { AdminError, plural } from "@/lib/admin";

/**
 * The one confirmation dialog every send goes through (invariant 11): it shows the rendered
 * notification, states exactly how many students it will reach, and for a critical (T0) send
 * makes the admin type that number. If the gateway answers that the audience changed, the dialog
 * shows the new number and asks again — it never retries past it.
 */
export interface SendPreview {
  tier: number;
  title: string;
  body: string;
  /** what the action is, in words: "Mark Bus 14 out of commission" */
  action: string;
  count: number;
}

export function ConfirmSend({
  preview,
  onConfirm,
  onClose,
}: {
  preview: SendPreview;
  /** perform the send with this count (and typed text for T0); throw AdminError to report */
  onConfirm: (count: number, typed: string) => Promise<void>;
  onClose: () => void;
}) {
  const [count, setCount] = useState(preview.count);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDialogElement>(null);
  const tier = TIERS[preview.tier]!;
  const critical = preview.tier === 0;
  const ready =
    !busy && count > 0 === preview.count > 0 && (!critical || typed.trim() === String(count));

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(count, typed);
    } catch (e) {
      if (
        e instanceof AdminError &&
        e.code === "count_changed" &&
        typeof e.body.count === "number"
      ) {
        setCount(e.body.count);
        setTyped("");
        setError(
          `The audience changed while this was open. It is now ${plural(e.body.count, "student")}. Check the number and confirm again.`,
        );
      } else setError(e instanceof Error ? e.message : "Could not send.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className="m-auto w-full max-w-lg rounded-2xl border border-line bg-panel p-0 text-ink backdrop:bg-black/60"
    >
      <div className="p-6">
        <h2 className="text-lg font-semibold">{preview.action}</h2>
        <p className="mt-1 text-sm text-muted">
          Tier {preview.tier} · {tier.name} — {tier.effect}
        </p>

        <figure
          aria-label="How the notification will look"
          className="mt-4 rounded-xl border border-line bg-canvas p-4"
        >
          <figcaption className="mb-2 text-xs uppercase tracking-wide text-muted">
            On students&apos; phones
          </figcaption>
          <p className="font-semibold">{preview.title}</p>
          <p className="mt-1 whitespace-pre-line text-sm">{preview.body}</p>
        </figure>

        <p
          className={`mt-4 rounded-lg p-3 text-base font-semibold ${critical ? "bg-dark/15 text-dark" : "bg-live/10"}`}
          role="status"
        >
          {count === 0
            ? "Nobody is in this audience — nothing will be sent."
            : `This will notify ${plural(count, "student")}.`}
        </p>

        {critical && count > 0 && (
          <label className="mt-4 block text-sm">
            <span className="mb-1 block text-muted">
              This is a critical alert. Type <strong className="text-ink">{count}</strong> to
              confirm.
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              inputMode="numeric"
              autoFocus
              className="w-32 rounded-lg border border-line bg-canvas px-3 py-2 text-base outline-none focus:border-dark"
            />
          </label>
        )}

        {error && (
          <p role="alert" className="mt-3 text-sm text-degraded">
            {error}
          </p>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <button onClick={() => ref.current?.close()} className="rounded-lg px-4 py-2 text-muted">
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!ready}
            className={`rounded-lg px-4 py-2 font-semibold disabled:opacity-40 ${critical ? "bg-dark text-white" : "bg-live text-black"}`}
          >
            {busy
              ? "Sending…"
              : count === 0
                ? "Apply without notifying"
                : `Send to ${plural(count, "student")}`}
          </button>
        </div>
      </div>
    </dialog>
  );
}
