"use client";
import { useEffect, useState } from "react";
import { accessToken } from "@/components/live/use-live-stream";
import { pushState, turnOffPush, turnOnPush, type PushState } from "@/lib/push";

/**
 * Turning alerts on for this phone (Stage 6), with the iOS install explanation the build plan
 * asks for: on an iPhone, alerts only reach an app added to the Home Screen, so the student is
 * shown exactly how — and told plainly that urgent alerts come by SMS until then.
 */
export function PushSetup({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<PushState | "loading">("loading");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void (async () =>
      setState(
        await pushState((await accessToken()) ?? undefined).catch(() => "unsupported" as const),
      ))();
  }, []);
  if (state === "loading" || (compact && (state === "on" || state === "no-server-key")))
    return null;

  const run = async (fn: (t: string | undefined) => Promise<PushState>) => {
    setBusy(true);
    try {
      setState(await fn((await accessToken()) ?? undefined));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="mb-4 rounded-2xl border border-line bg-panel p-4 text-sm"
      data-testid="push-setup"
      data-state={state}
    >
      {state === "on" && (
        <p>
          <span className="text-live">● Alerts are on for this phone.</span>{" "}
          <button
            className="text-muted underline"
            disabled={busy}
            onClick={() => void run(turnOffPush)}
          >
            Turn off
          </button>
        </p>
      )}
      {state === "off" && (
        <>
          <p className="font-semibold">Get alerts on this phone</p>
          <p className="mt-1 text-muted">
            When your bus starts, when to leave, and if a bus is cancelled.
          </p>
          <button
            className="mt-3 rounded-lg bg-live px-4 py-2 font-semibold text-live-ink disabled:opacity-50"
            disabled={busy}
            onClick={() => void run(turnOnPush)}
          >
            Turn on alerts
          </button>
        </>
      )}
      {state === "ios-needs-install" && (
        <>
          <p className="font-semibold">On iPhone, alerts need the app on your Home Screen</p>
          <ol className="mt-2 list-decimal space-y-1 pl-5">
            <li>
              Tap the <strong>Share</strong> button (the square with an arrow) in Safari.
            </li>
            <li>
              Choose <strong>Add to Home Screen</strong>, then <strong>Add</strong>.
            </li>
            <li>Open Bus Mitra from the Home Screen and turn alerts on there.</li>
          </ol>
          <p className="mt-2 text-muted">
            Until then, urgent alerts (leave now, a cancelled bus) come to you by SMS.
          </p>
        </>
      )}
      {state === "denied" && (
        <p>
          Notifications are blocked for this site in your browser settings. Allow them there to get
          alerts — urgent ones come by SMS meanwhile.
        </p>
      )}
      {state === "unsupported" && (
        <p>
          This browser cannot show alerts. Urgent ones (leave now, a cancelled bus) come by SMS.
        </p>
      )}
      {state === "no-server-key" && !compact && (
        <p className="text-muted">Phone alerts are not switched on for Bus Mitra yet.</p>
      )}
    </section>
  );
}
