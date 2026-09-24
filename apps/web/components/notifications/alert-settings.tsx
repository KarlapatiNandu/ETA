"use client";
import { useEffect, useState } from "react";
import { PushSetup } from "./push-setup";
import { me, type AlertSettings, type Favourite } from "./student-api";

const toHm = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const fromHm = (hm: string) => {
  const [h, m] = hm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

const MAX_TIER = [
  [1, "Only critical and urgent (cancellations, leave now, my bus started)"],
  [2, "…and important (bus list changes, announcements)"],
  [3, "…and progress updates (recommended)"],
  [4, "Everything, even background notes"],
] as const;

/**
 * Alert preferences (ARCH §6.3, §6.5): this phone's push, how much to be told (max tier — a
 * *maximum*, so "3" means 0 through 3), quiet hours as a start and a length (so 22:00–06:00
 * works), whether critical alerts break through a pause, and the student's buses.
 */
export function AlertSettingsPanel() {
  const [s, setS] = useState<AlertSettings | null>(null);
  const [favs, setFavs] = useState<Favourite[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const load = async () => {
    setS(await me<AlertSettings>("/v1/me/alerts"));
    setFavs((await me<{ favourites: Favourite[] }>("/v1/me/favourites")).favourites);
  };
  useEffect(() => {
    void load().catch(() => setMsg("Could not load your alert settings."));
  }, []);
  if (!s) return null;

  const patch = async (body: Record<string, unknown>) => {
    try {
      await me("/v1/me/alerts", { method: "PATCH", body });
      await load();
      setMsg("Saved.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Could not save.");
    }
  };
  const quietOn = s.quiet_start_min !== null;

  return (
    <section
      className="mx-auto mt-6 w-full max-w-md rounded-2xl border border-line bg-panel p-6"
      data-testid="alert-settings"
    >
      <h2 className="mb-4 text-lg font-semibold">Alerts</h2>
      <PushSetup />
      <label className="block text-sm">
        <span className="mb-1 block text-muted">What to be told about</span>
        <select
          value={s.max_tier}
          onChange={(e) => void patch({ max_tier: Number(e.target.value) })}
          className="w-full rounded-lg border border-line bg-canvas px-3 py-2"
        >
          {MAX_TIER.map(([t, label]) => (
            <option key={t} value={t}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="mt-4 text-sm">
        <legend className="mb-1 text-muted">
          Quiet hours (critical alerts still come through)
        </legend>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={quietOn}
            onChange={(e) =>
              void patch(
                e.target.checked
                  ? { quiet_start_min: 22 * 60, quiet_duration_min: 8 * 60 }
                  : { quiet_start_min: null, quiet_duration_min: null },
              )
            }
          />
          On
        </label>
        {quietOn && (
          <form
            className="mt-2 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              const start = fromHm(String(f.get("from")));
              const end = fromHm(String(f.get("to")));
              const duration = (((end - start) % 1440) + 1440) % 1440 || 1440;
              void patch({ quiet_start_min: start, quiet_duration_min: duration });
            }}
          >
            <input
              name="from"
              type="time"
              defaultValue={toHm(s.quiet_start_min!)}
              aria-label="Quiet from"
              className="rounded-lg border border-line bg-canvas px-2 py-1"
            />
            to
            <input
              name="to"
              type="time"
              defaultValue={toHm((s.quiet_start_min! + s.quiet_duration_min!) % 1440)}
              aria-label="Quiet until"
              className="rounded-lg border border-line bg-canvas px-2 py-1"
            />
            <button className="text-live">Save</button>
          </form>
        )}
      </fieldset>

      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={s.critical_breakthrough}
          onChange={(e) => void patch({ critical_breakthrough: e.target.checked })}
        />
        <span>
          Critical alerts (a cancelled bus) reach me even when I have paused alerts
          <span className="block text-xs text-muted">
            Recommended. Turn off only if you are sure.
          </span>
        </span>
      </label>

      <h3 className="mt-6 font-semibold">My buses</h3>
      {favs.length ? (
        <ul className="mt-2 space-y-2 text-sm">
          {favs.map((f) => (
            <li key={f.bus_id} className="flex items-center gap-2">
              <span className="w-20 font-semibold">Bus {f.bus_number}</span>
              <span className={f.kind === "main" ? "text-live" : "text-muted"}>
                {f.kind === "main" ? "my bus" : "starred"}
              </span>
              {f.muted_until && Date.parse(f.muted_until) > Date.now() && (
                <button
                  className="text-degraded"
                  onClick={() =>
                    void me(`/v1/me/favourites/${f.bus_id}/mute`, { method: "DELETE" }).then(load)
                  }
                >
                  muted today — unmute
                </button>
              )}
              <button
                className="ml-auto text-muted"
                onClick={() =>
                  void me(`/v1/me/favourites/${f.bus_id}`, { method: "DELETE" }).then(load)
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">
          Tap a bus on the map to star it or make it your bus.
        </p>
      )}
      {msg && <p className="mt-3 text-sm text-muted">{msg}</p>}
    </section>
  );
}
