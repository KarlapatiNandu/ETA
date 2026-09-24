"use client";
import { useEffect, useState } from "react";
import { clock, me, type AlertSettings } from "./student-api";

/**
 * The kill switch (ARCH §6.5): one tap once aboard silences everything for three hours — never
 * past midnight, so tomorrow's alerts still come — and critical alerts still break through
 * unless the student turned that off.
 */
export function PauseButton() {
  const [until, setUntil] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    me<AlertSettings>("/v1/me/alerts")
      .then((a) =>
        setUntil(
          a.alerts_paused_until && Date.parse(a.alerts_paused_until) > Date.now()
            ? a.alerts_paused_until
            : null,
        ),
      )
      .catch(() => setUntil(null));
  }, []);
  if (until === undefined) return null;
  if (until)
    return (
      <div
        className="mb-3 flex items-center justify-between rounded-xl border border-line bg-panel px-4 py-2 text-sm"
        data-testid="paused"
      >
        <span>Alerts paused until {clock(until)} — critical alerts still come through.</span>
        <button
          className="text-live"
          onClick={() => void me("/v1/me/pause", { method: "DELETE" }).then(() => setUntil(null))}
        >
          Resume
        </button>
      </div>
    );
  return (
    <button
      data-testid="pause"
      className="mb-3 w-full rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold"
      onClick={() =>
        void me<{ alerts_paused_until: string }>("/v1/me/pause", { method: "POST" }).then((r) =>
          setUntil(r.alerts_paused_until),
        )
      }
    >
      I&apos;m on the bus — pause alerts for 3 hours
    </button>
  );
}
