"use client";
import dynamic from "next/dynamic";
import { ErrorText } from "@/components/ui";
import type { DeadZone } from "@/components/admin/dead-zone-map";
import { admin, fmtAge, fmtTime, useAdmin } from "@/lib/admin";

// MapLibre touches `window`: client-only
const DeadZoneMap = dynamic(
  () => import("@/components/admin/dead-zone-map").then((m) => m.DeadZoneMap),
  { ssr: false },
);

type Health = {
  serverTime: string;
  alerts: { id: string; firing: boolean; summary: string }[];
  live: {
    pingToFrame: { n: number; p50: number | null; p95: number | null; windowS: number };
    streams: { total: number; thisInstance: number };
    groups: { stream: string; group: string; lag: number | null; pending: number }[];
    deadLetters: number;
    fleet: {
      byState: Record<string, number>;
      darkTooLong: { busId: string; darkForS: number }[];
    };
  };
  eta: {
    byRoute: { route_name: string; horizon_s: number; n: number; mae_s: number }[];
    today: { hour: string; n: number; mae_s: number }[];
  };
  delivery: {
    last24h: {
      channel: string;
      recipients: number;
      delivered: number;
      failed: number;
      pending: number;
    }[];
    pushLastHour: { ok: number; refused: number };
  };
  deadZones: {
    zones: DeadZone[];
    outages14d: { in_known_zone: boolean; outages: number; avg_s: number | null }[];
  };
};

const ALERT_NAMES: Record<string, string> = {
  latency: "Live-map latency",
  consumer_lag: "Processing backlog",
  push_failures: "Push failures",
  dark_bus: "Bus silent too long",
  dead_letters: "Unsaved positions",
};

/**
 * System health (BUILD_PLAN Stage 8): the same numbers and alert rules as the Grafana
 * dashboards, for a TD member without a Grafana login. Polls every 10 s.
 */
export default function HealthPage() {
  const { data, error, reload, setError } = useAdmin<Health>("/v1/admin/observability", 10_000);
  const rename = async (id: string, current: string | null) => {
    const label = window.prompt("Name this place the way students know it", current ?? "");
    if (label === null) return;
    try {
      await admin(`/v1/admin/dead-zones/${id}`, {
        method: "PATCH",
        body: { label: label.trim() || null },
      });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename.");
    }
  };
  const firing = data?.alerts.filter((a) => a.firing) ?? [];
  const known = data?.deadZones.outages14d.find((o) => o.in_known_zone)?.outages ?? 0;
  const unknown = data?.deadZones.outages14d.find((o) => !o.in_known_zone)?.outages ?? 0;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-panel p-6">
        <div className="flex flex-wrap items-baseline gap-4">
          <h1 className="text-xl font-semibold">System health</h1>
          <p className={`text-sm ${firing.length ? "text-dark" : "text-live"}`} role="status">
            {data ? (firing.length ? `${firing.length} alert(s) firing` : "All clear") : "Loading…"}
          </p>
          <p className="ml-auto text-xs text-muted">Updated {fmtTime(data?.serverTime)}</p>
        </div>
        <ErrorText>{error}</ErrorText>
        <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="alerts">
          {data?.alerts.map((a) => (
            <li
              key={a.id}
              data-alert={a.id}
              data-firing={a.firing}
              className={`rounded-xl border p-3 text-sm ${a.firing ? "border-dark" : "border-line"}`}
            >
              <p className={`font-semibold ${a.firing ? "text-dark" : ""}`}>
                {a.firing ? "● " : "✓ "}
                {ALERT_NAMES[a.id] ?? a.id}
              </p>
              <p className="text-muted">{a.summary}</p>
            </li>
          ))}
        </ul>
      </section>

      {data && (
        <section className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-panel p-6">
            <h2 className="font-semibold">Live pipeline</h2>
            <dl className="mt-3 grid grid-cols-2 gap-y-2 text-sm">
              <dt className="text-muted">Fix → map frame (p50 / p95)</dt>
              <dd className="tabular-nums">
                {data.live.pingToFrame.n
                  ? `${data.live.pingToFrame.p50!.toFixed(1)} s / ${data.live.pingToFrame.p95!.toFixed(1)} s`
                  : "no buses moving"}
                <span className="text-muted">
                  {" "}
                  ({data.live.pingToFrame.n} in {data.live.pingToFrame.windowS / 60} min)
                </span>
              </dd>
              <dt className="text-muted">Students connected</dt>
              <dd className="tabular-nums">{data.live.streams.total}</dd>
              <dt className="text-muted">Buses</dt>
              <dd>
                {Object.entries(data.live.fleet.byState)
                  .filter(([, n]) => n)
                  .map(([s, n]) => `${n} ${s.toLowerCase()}`)
                  .join(" · ") || "none on a trip"}
              </dd>
              {data.live.fleet.darkTooLong.map((d) => (
                <div key={d.busId} className="contents text-dark">
                  <dt>Silent bus</dt>
                  <dd>{fmtAge(d.darkForS)}</dd>
                </div>
              ))}
              <dt className="text-muted">Unsaved positions</dt>
              <dd className={data.live.deadLetters ? "text-dark" : ""}>{data.live.deadLetters}</dd>
            </dl>
            <table className="mt-4 w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th>Stream</th>
                  <th>Worker</th>
                  <th className="text-right">Backlog</th>
                  <th className="text-right">In flight</th>
                </tr>
              </thead>
              <tbody>
                {data.live.groups.map((g) => (
                  <tr key={`${g.stream}/${g.group}`} className="border-t border-line">
                    <td>{g.stream}</td>
                    <td>{g.group}</td>
                    <td className="text-right tabular-nums">{g.lag ?? "?"}</td>
                    <td className="text-right tabular-nums">{g.pending}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-2xl border border-line bg-panel p-6">
            <h2 className="font-semibold">Notifications, last 24 h</h2>
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th>Channel</th>
                  <th className="text-right">Students</th>
                  <th className="text-right">Delivered</th>
                  <th className="text-right">Failed</th>
                  <th className="text-right">Waiting</th>
                </tr>
              </thead>
              <tbody>
                {data.delivery.last24h.map((d) => (
                  <tr key={d.channel} className="border-t border-line">
                    <td>{d.channel.replace("_", "-")}</td>
                    <td className="text-right tabular-nums">{d.recipients}</td>
                    <td className="text-right tabular-nums">{d.delivered}</td>
                    <td className="text-right tabular-nums">{d.failed}</td>
                    <td className="text-right tabular-nums">{d.pending}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.delivery.last24h.length && <p className="mt-2 text-muted">Nothing sent.</p>}

            <h2 className="mt-6 font-semibold">ETA accuracy, last 7 days</h2>
            <table className="mt-3 w-full text-sm">
              <thead className="text-left text-muted">
                <tr>
                  <th>Route</th>
                  <th className="text-right">Horizon</th>
                  <th className="text-right">Mean error</th>
                  <th className="text-right">Arrivals</th>
                </tr>
              </thead>
              <tbody>
                {data.eta.byRoute.map((e) => (
                  <tr key={`${e.route_name}/${e.horizon_s}`} className="border-t border-line">
                    <td>{e.route_name}</td>
                    <td className="text-right">{e.horizon_s / 60} min</td>
                    <td
                      className={`text-right tabular-nums ${e.horizon_s === 600 ? (e.mae_s <= 90 ? "text-live" : "text-degraded") : ""}`}
                    >
                      ±{e.mae_s} s
                    </td>
                    <td className="text-right tabular-nums">{e.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.eta.byRoute.length && (
              <p className="mt-2 text-muted">No measured arrivals yet.</p>
            )}
          </div>
        </section>
      )}

      {data && (
        <section className="rounded-2xl border border-line bg-panel p-6">
          <div className="flex flex-wrap items-baseline gap-4">
            <h2 className="font-semibold">Learned dead zones</h2>
            <p className="text-sm text-muted">
              {data.deadZones.zones.length} zone(s) · last 14 days: {known} outage(s) in a known
              zone, {unknown} elsewhere
            </p>
          </div>
          <p className="mt-1 text-sm text-muted">
            Places where buses routinely lose signal. Students are told “usually clears in about …”
            instead of being alarmed. Learned every night from the last 60 days.
          </p>
          <div className="mt-4">
            <DeadZoneMap zones={data.deadZones.zones} />
          </div>
          <ul className="mt-3 space-y-1 text-sm" data-testid="dead-zones">
            {data.deadZones.zones.map((z) => (
              <li key={z.id}>
                <button
                  className="font-semibold underline decoration-dotted"
                  title="Rename"
                  onClick={() => void rename(z.id, z.label)}
                >
                  {z.label ?? "Unnamed zone"}
                </button>{" "}
                <span className="text-muted">
                  · {z.sample_count} outages · clears in ~{z.avg_outage_s} s · confidence{" "}
                  {Math.round(Number(z.confidence) * 100)}%
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
