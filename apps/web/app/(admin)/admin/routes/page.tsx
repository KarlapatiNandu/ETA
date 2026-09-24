"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { RouteSummary, SurveySummary } from "@busmitra/contracts";
import { ErrorText } from "@/components/ui";
import { gateway } from "@/lib/gateway";
import { supabaseBrowser } from "@/lib/supabase/client";

async function token() {
  const { data } = await supabaseBrowser().auth.getSession();
  return data.session?.access_token;
}

const km = (m: number) => `${(m / 1000).toFixed(1)} km`;

function status(r: RouteSummary): { label: string; cls: string } {
  if (r.published_at && !r.archived_at) return { label: "Published", cls: "text-live" };
  if (r.published_at) return { label: "Superseded", cls: "text-muted" };
  if (r.archived_at) return { label: "Archived", cls: "text-muted" };
  return { label: "Draft", cls: "text-degraded" };
}

/**
 * Stage 1 route capture, TD side: surveys come in from phones, get matched onto the road
 * network into drafts, and drafts are corrected and published in the editor.
 */
export default function RoutesPage() {
  const router = useRouter();
  const [surveys, setSurveys] = useState<SurveySummary[]>([]);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [matching, setMatching] = useState<string | null>(null);

  const load = useCallback(async () => {
    const t = await token();
    const [s, r] = await Promise.all([
      gateway<SurveySummary[]>("/v1/admin/surveys", { token: t }),
      gateway<RouteSummary[]>("/v1/admin/routes", { token: t }),
    ]);
    setSurveys(s);
    setRoutes(r);
  }, []);
  useEffect(() => {
    load().catch(() => setError("Could not load routes."));
  }, [load]);

  // one row per lineage: its versions, newest first
  const lineages = new Map<string, RouteSummary[]>();
  for (const r of routes) lineages.set(r.lineage_id, [...(lineages.get(r.lineage_id) ?? []), r]);

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold">Route surveys</h1>
        <p className="mt-1 text-sm text-muted">
          Traces recorded by driving a route once with the driver app in survey mode. Matching snaps
          a trace onto the road network and creates a draft route to correct.
        </p>
        <ErrorText>{error}</ErrorText>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1">Survey</th>
              <th>Bus</th>
              <th>Recorded</th>
              <th>Points</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {surveys.map((s) => (
              <tr key={s.id} className="border-t border-line align-top">
                <td className="py-2">
                  {s.label || <span className="text-muted">unlabelled</span>}
                </td>
                <td>{s.bus_number ?? "—"}</td>
                <td>{new Date(s.started_at).toLocaleString()}</td>
                <td>{s.point_count}</td>
                <td>
                  {s.status}
                  {s.match_report && (
                    <div className="text-xs text-muted">
                      {String(s.match_report.matchedPct)}% matched
                      {Number(s.match_report.gaps) > 0 && (
                        <span className="text-degraded">
                          {" "}
                          · {String(s.match_report.gaps)} gap(s) — check the seams
                        </span>
                      )}
                    </div>
                  )}
                </td>
                <td className="text-right">
                  {s.route_id ? (
                    <Link className="underline" href={`/admin/routes/${s.route_id}`}>
                      open draft
                    </Link>
                  ) : s.status === "uploaded" ? (
                    <button
                      className="underline"
                      onClick={() => setMatching(matching === s.id ? null : s.id)}
                    >
                      match…
                    </button>
                  ) : null}
                  {matching === s.id && (
                    <MatchForm
                      survey={s}
                      lineages={[...lineages.values()].map((v) => v[0]!)}
                      onDone={(routeId) => router.push(`/admin/routes/${routeId}`)}
                      onDiscarded={() => void load()}
                    />
                  )}
                </td>
              </tr>
            ))}
            {!surveys.length && (
              <tr>
                <td colSpan={6} className="py-3 text-muted">
                  No surveys yet. Pair a phone, open Route survey, and drive the route once.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="text-lg font-semibold">Routes</h2>
        <p className="mt-1 text-sm text-muted">
          A published version is frozen: to change it, make a new version. The new version keeps the
          route&apos;s learned history (ADR-0003).
        </p>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1">Route</th>
              <th>Versions</th>
              <th>Length</th>
              <th>Stops</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {[...lineages.values()].map((versions) => {
              const head = versions[0]!;
              return (
                <tr key={head.lineage_id} className="border-t border-line align-top">
                  <td className="py-2 font-medium">
                    {head.name} <span className="text-muted">· {head.direction}</span>
                  </td>
                  <td>
                    {versions.map((v) => {
                      const st = status(v);
                      return (
                        <div key={v.id}>
                          <Link className="underline" href={`/admin/routes/${v.id}`}>
                            v{v.version}
                          </Link>{" "}
                          <span className={st.cls}>{st.label}</span>
                        </div>
                      );
                    })}
                  </td>
                  <td>{km(head.total_distance_m)}</td>
                  <td>{head.stop_count}</td>
                  <td className="text-muted">{head.source.replace("_", " ")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function MatchForm({
  survey,
  lineages,
  onDone,
  onDiscarded,
}: {
  survey: SurveySummary;
  lineages: RouteSummary[];
  onDone: (routeId: string) => void;
  onDiscarded: () => void;
}) {
  const [name, setName] = useState(survey.label ?? "");
  const [direction, setDirection] = useState<"inbound" | "outbound">("inbound");
  const [lineage, setLineage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="mt-2 space-y-2 rounded-lg border border-line p-3 text-left"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          const out = await gateway<{ route_id: string }>(`/v1/admin/surveys/${survey.id}/match`, {
            token: await token(),
            body: { name, direction, lineage_id: lineage || null },
          });
          onDone(out.route_id);
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input
        className="w-full rounded border border-line bg-canvas px-2 py-1"
        placeholder="Route name, e.g. Route 14"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <select
        className="w-full rounded border border-line bg-canvas px-2 py-1"
        value={direction}
        onChange={(e) => setDirection(e.target.value as "inbound" | "outbound")}
      >
        <option value="inbound">Inbound (to campus)</option>
        <option value="outbound">Outbound (from campus)</option>
      </select>
      <select
        className="w-full rounded border border-line bg-canvas px-2 py-1"
        value={lineage}
        onChange={(e) => setLineage(e.target.value)}
      >
        <option value="">A new route</option>
        {lineages.map((l) => (
          <option key={l.lineage_id} value={l.lineage_id}>
            Re-survey of {l.name} ({l.direction}) — keeps its history
          </option>
        ))}
      </select>
      <ErrorText>{error}</ErrorText>
      <div className="flex gap-2">
        <button
          className="rounded bg-live px-3 py-1 font-semibold text-black disabled:opacity-50"
          disabled={busy}
        >
          {busy ? "Matching…" : "Match onto roads"}
        </button>
        <button
          type="button"
          className="text-muted underline"
          onClick={async () => {
            if (!confirm("Discard this survey?")) return;
            await gateway(`/v1/admin/surveys/${survey.id}/discard`, {
              token: await token(),
              body: {},
            });
            onDiscarded();
          }}
        >
          discard
        </button>
      </div>
    </form>
  );
}
