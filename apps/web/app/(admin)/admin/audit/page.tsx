"use client";
import { useState } from "react";
import { ErrorText } from "@/components/ui";
import { admin, fmtTime, useAdmin } from "@/lib/admin";

type Entry = {
  id: number;
  action: string;
  entity: string;
  entity_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  ip: string | null;
  created_at: string;
  actor_name: string | null;
  actor_roll: string | null;
  changed: string[];
};
type Page = { entries: Entry[]; next: number | null; entities: string[] };

const show = (v: unknown) =>
  v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v);

/**
 * The audit log (BUILD_PLAN Stage 7, SCHEMA §8): every admin mutation, who made it, from where,
 * and what changed. Secrets, route geometry and students' home pins are dropped by the trigger
 * before they are ever written, so none of them can appear here.
 */
export default function AuditPage() {
  const [entity, setEntity] = useState("");
  const [peopleOnly, setPeopleOnly] = useState(true);
  const path = `/v1/admin/audit?limit=50&people_only=${peopleOnly ? 1 : 0}${entity ? `&entity=${entity}` : ""}`;
  const { data, error } = useAdmin<Page>(path);
  const [more, setMore] = useState<{ path: string; entries: Entry[]; next: number | null } | null>(
    null,
  );
  const extra = more?.path === path ? more : null;
  const entries = [...(data?.entries ?? []), ...(extra?.entries ?? [])];
  const next = extra ? extra.next : (data?.next ?? null);

  return (
    <section className="rounded-2xl border border-line bg-panel p-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">Audit log</h1>
        <select
          value={entity}
          onChange={(e) => setEntity(e.target.value)}
          aria-label="What changed"
          className="ml-auto rounded-lg border border-line bg-canvas px-3 py-1.5 text-sm"
        >
          <option value="">Everything</option>
          {data?.entities.map((e) => (
            <option key={e} value={e}>
              {e.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={peopleOnly}
            onChange={(e) => setPeopleOnly(e.target.checked)}
          />
          People only (hide the system&apos;s own writes)
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <table className="mt-4 w-full text-sm">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1">When</th>
            <th>Who</th>
            <th>What</th>
            <th>Changed</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-line align-top">
              <td className="whitespace-nowrap py-2 pr-3">{fmtTime(e.created_at)}</td>
              <td className="pr-3">
                {e.actor_name ?? <span className="text-muted">system</span>}
                {e.ip && <span className="block text-xs text-muted">{e.ip}</span>}
              </td>
              <td className="pr-3">{e.action.replace(/_/g, " ")}</td>
              <td>
                <details>
                  <summary className="cursor-pointer">
                    {e.changed.slice(0, 4).join(", ") || "—"}
                    {e.changed.length > 4 ? "…" : ""}
                  </summary>
                  <table className="mt-1 text-xs">
                    <tbody>
                      {e.changed.map((k) => (
                        <tr key={k}>
                          <td className="pr-2 text-muted">{k}</td>
                          <td className="pr-2 text-dark line-through">{show(e.before?.[k])}</td>
                          <td className="text-live">{show(e.after?.[k])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {next && (
        <button
          className="mt-4 rounded-lg border border-line px-4 py-2 text-sm"
          onClick={() =>
            void admin<Page>(`${path}&before=${next}`).then((p) =>
              setMore({ path, entries: [...(extra?.entries ?? []), ...p.entries], next: p.next }),
            )
          }
        >
          Older
        </button>
      )}
    </section>
  );
}
