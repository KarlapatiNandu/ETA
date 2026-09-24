"use client";
import Link from "next/link";
import { ErrorText } from "@/components/ui";
import { fmtAge, fmtTime, useAdmin } from "@/lib/admin";

type Row = {
  id: string;
  bus_number: string;
  status: string;
  status_note: string | null;
  trip_status: string | null;
  route_name: string | null;
  scheduled_start_at: string | null;
  open_tickets: number;
  trackers: number;
  mae_s: number | null;
  mae_n: number;
  presence: "LIVE" | "DEGRADED" | "DARK" | "ENDED" | null;
  last_fix_age_s: number | null;
  cadence_s: number | null;
  flag: string | null;
  dead_zone: { label: string | null } | null;
  speed_kmh: number | null;
};
type Dashboard = { serverTime: string; live: boolean; buses: Row[] };

const PRESENCE: Record<string, { label: string; cls: string }> = {
  LIVE: { label: "● Live", cls: "text-live" },
  DEGRADED: { label: "◌ Late", cls: "text-degraded" },
  DARK: { label: "○ No signal", cls: "text-dark" },
  ENDED: { label: "Off the map", cls: "text-muted" },
};

/**
 * The live fleet dashboard (BUILD_PLAN Stage 7): every bus's presence, trip, last ping age and
 * today's ETA accuracy. Polls every 5 s; presence comes from the same live state students see.
 */
export default function LiveFleet() {
  const { data, error } = useAdmin<Dashboard>("/v1/admin/dashboard", 5000);
  const buses = data?.buses ?? [];
  const counts = {
    live: buses.filter((b) => b.presence === "LIVE").length,
    late: buses.filter((b) => b.presence === "DEGRADED").length,
    dark: buses.filter((b) => b.presence === "DARK").length,
    out: buses.filter((b) => b.status === "out_of_commission").length,
  };

  return (
    <section className="rounded-2xl border border-line bg-panel p-6">
      <div className="flex flex-wrap items-baseline gap-4">
        <h1 className="text-xl font-semibold">Live fleet</h1>
        <p className="text-sm text-muted">
          {counts.live} live · {counts.late} late · {counts.dark} no signal · {counts.out} out of
          commission
        </p>
        <p className="ml-auto text-xs text-muted">Updated {fmtTime(data?.serverTime)}</p>
      </div>
      <ErrorText>{error}</ErrorText>
      {data && !data.live && (
        <p role="alert" className="mt-3 text-sm text-degraded">
          Live positions are unavailable right now — the list below shows the fleet, not where it
          is.
        </p>
      )}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1">Bus</th>
              <th>Status</th>
              <th>Signal</th>
              <th>Last ping</th>
              <th>Trip</th>
              <th title="Mean error of the 10-minute ETA today">ETA accuracy</th>
              <th>Tickets</th>
            </tr>
          </thead>
          <tbody>
            {buses.map((b) => {
              const p = b.presence ? PRESENCE[b.presence]! : null;
              return (
                <tr key={b.id} className="border-t border-line" data-bus={b.bus_number}>
                  <td className="py-2 font-semibold">
                    <Link href={`/admin/fleet/${b.id}`}>Bus {b.bus_number}</Link>
                  </td>
                  <td
                    className={
                      b.status === "out_of_commission"
                        ? "text-dark"
                        : b.status === "active"
                          ? ""
                          : "text-degraded"
                    }
                  >
                    {b.status.replace(/_/g, " ")}
                  </td>
                  <td className={p?.cls ?? "text-muted"}>
                    {p ? p.label : b.trackers ? "not on a trip" : "no tracker paired"}
                    {b.flag === "off_route" && <span className="text-degraded"> · off route</span>}
                    {b.presence === "DARK" && b.dead_zone && (
                      <span className="text-muted">
                        {" "}
                        · known dead zone{b.dead_zone.label ? ` (${b.dead_zone.label})` : ""}
                      </span>
                    )}
                  </td>
                  <td>
                    {fmtAge(b.last_fix_age_s)}
                    {b.cadence_s && b.last_fix_age_s != null && (
                      <span className="text-muted"> (every {b.cadence_s} s)</span>
                    )}
                  </td>
                  <td>
                    {b.trip_status ? (
                      <>
                        {b.trip_status}
                        {b.route_name && <span className="text-muted"> · {b.route_name}</span>}
                        {b.trip_status === "scheduled" && b.scheduled_start_at && (
                          <span className="text-muted"> · {fmtTime(b.scheduled_start_at)}</span>
                        )}
                      </>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td>
                    {b.mae_n ? (
                      <span className={b.mae_s! <= 90 ? "text-live" : "text-degraded"}>
                        ±{b.mae_s} s <span className="text-muted">({b.mae_n})</span>
                      </span>
                    ) : (
                      <span className="text-muted">no arrivals yet</span>
                    )}
                  </td>
                  <td>
                    {b.open_tickets ? (
                      <Link href={`/admin/tickets?bus=${b.bus_number}`} className="text-degraded">
                        {b.open_tickets} open
                      </Link>
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data && !buses.length && (
          <p className="mt-4 text-muted">No buses yet — add them under Fleet.</p>
        )}
      </div>
    </section>
  );
}
