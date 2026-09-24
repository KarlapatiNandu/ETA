"use client";
import { useState } from "react";
import type { CsvError } from "@busmitra/contracts";
import { ConfirmSend, type SendPreview } from "@/components/admin/confirm-send";
import { ErrorText } from "@/components/ui";
import { admin, AdminError, fmtTime, plural, useAdmin } from "@/lib/admin";

type Line = {
  cohort: string;
  bus_number: string;
  route_name: string | null;
  departure_time: string | null;
};
type Preview = {
  id: string;
  status: "preview_ready" | "rejected";
  service_date: string;
  errors: CsvError[];
  warnings: CsvError[];
  diff: {
    added: Line[];
    removed: Line[];
    changed: {
      cohort: string;
      bus_number: string;
      fields: Record<string, { from: string | null; to: string | null }>;
      route_from?: string | null;
      route_to?: string | null;
    }[];
    unchanged: number;
    notify_cohorts: string[];
  } | null;
  notify_count: number;
  identical_to: { id: string; applied_at: string } | null;
};
type Current = {
  buses: (Line & { bus_number_raw: string; notes: string | null })[];
  uploads: {
    id: string;
    original_name: string;
    status: string;
    applied_at: string | null;
    created_at: string;
    uploaded_name: string;
  }[];
};

const tomorrow = () => {
  const d = new Date(Date.now() + 86_400_000 + 5.5 * 3600_000);
  return d.toISOString().slice(0, 10);
};
const cohortLabel = (c: string) => (c === "junior" ? "Juniors" : "Seniors");

type Change = NonNullable<Preview["diff"]>["changed"][number];

function describeChange(c: Change) {
  return Object.entries(c.fields)
    .map(([f, v]) =>
      f === "route_id"
        ? `route ${c.route_from ?? "none"} → ${c.route_to ?? "none"}`
        : `${f === "departure_time" ? "time" : f} ${v.from ?? "—"} → ${v.to ?? "—"}`,
    )
    .join(", ");
}

/**
 * Event-day bus lists (BUILD_PLAN Stage 7): upload → errors or a rendered diff → confirm with
 * the number of students it notifies → apply. Nothing is sent before the confirm, and a file
 * with any error is rejected whole.
 */
export default function EventDayPage() {
  const [date, setDate] = useState(tomorrow);
  const [cohort, setCohort] = useState<"both" | "junior" | "senior">("both");
  const current = useAdmin<Current>(`/v1/admin/event-day?date=${date}`);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [send, setSend] = useState<SendPreview | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    setDone(null);
    setPreview(null);
    try {
      setPreview(
        await admin<Preview>(`/v1/admin/event-day/uploads?service_date=${date}&cohort=${cohort}`, {
          csv: await file.text(),
          headers: { "x-filename": file.name },
        }),
      );
    } catch (e) {
      setError(e instanceof AdminError ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function apply(count: number) {
    await admin(`/v1/admin/event-day/uploads/${preview!.id}/apply`, {
      body: { confirm_count: count },
    });
    setSend(null);
    setDone(
      count
        ? `Published. ${plural(count, "student")} will be told.`
        : "Applied. Nothing changed, so nobody was notified.",
    );
    setPreview(null);
    await current.reload();
  }

  function review() {
    if (!preview?.diff) return;
    const d = preview.diff;
    const cohorts = d.notify_cohorts.map(cohortLabel).join(" and ");
    setSend({
      tier: 2,
      action: `Publish the bus list for ${preview.service_date}`,
      title: `Bus list for ${preview.service_date} has changed`,
      body: d.notify_cohorts.length
        ? `${cohorts}: check which bus to take. ${d.added.length} added, ${d.changed.length} changed, ${d.removed.length} removed.`
        : "No changes — nobody will be notified.",
      count: preview.notify_count,
    });
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold">Event-day bus list</h1>
        <p className="mt-1 text-sm text-muted">
          CSV columns: <code>bus</code>, <code>route</code> (optional — the bus&apos;s usual route),{" "}
          <code>time</code> (7:40 AM), <code>cohort</code> (junior / senior / both),{" "}
          <code>notes</code>. A file only changes the list for the cohorts it mentions. Nothing is
          published until you confirm.
        </p>
        <div className="mt-4 flex flex-wrap items-end gap-3 text-sm">
          <label>
            <span className="mb-1 block text-muted">Day</span>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-line bg-canvas px-3 py-2"
            />
          </label>
          <label>
            <span className="mb-1 block text-muted">Blank cohort cells mean</span>
            <select
              value={cohort}
              onChange={(e) => setCohort(e.target.value as typeof cohort)}
              className="rounded-lg border border-line bg-canvas px-3 py-2"
            >
              <option value="both">both</option>
              <option value="junior">juniors</option>
              <option value="senior">seniors</option>
            </select>
          </label>
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            aria-label="Bus list CSV"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
              e.target.value = "";
            }}
          />
        </div>
        <ErrorText>{error}</ErrorText>
        {done && <p className="mt-3 text-sm text-live">{done}</p>}
      </section>

      {preview?.status === "rejected" && (
        <section className="rounded-2xl border border-dark bg-panel p-6" data-testid="rejected">
          <h2 className="font-semibold text-dark">
            This file was not accepted — nothing was published and nobody was notified
          </h2>
          <p className="mt-1 text-sm text-muted">
            Fix these lines in the spreadsheet and upload it again.
          </p>
          <table className="mt-3 w-full text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th>Line</th>
                <th>Column</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {preview.errors.map((e, i) => (
                <tr key={i} className="border-t border-line">
                  <td className="py-1">{e.row}</td>
                  <td>{e.column}</td>
                  <td>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview?.status === "preview_ready" && preview.diff && (
        <section className="rounded-2xl border border-line bg-panel p-6" data-testid="preview">
          <h2 className="font-semibold">Check the changes for {preview.service_date}</h2>
          {preview.identical_to && (
            <p className="mt-2 text-sm text-degraded">
              This is the same file that was published {fmtTime(preview.identical_to.applied_at)}.
              Applying it changes nothing and notifies nobody.
            </p>
          )}
          <p className="mt-2 text-sm">
            {preview.diff.added.length} added · {preview.diff.changed.length} changed ·{" "}
            {preview.diff.removed.length} removed · {preview.diff.unchanged} unchanged
          </p>
          {preview.warnings.length > 0 && (
            <ul className="mt-2 text-sm text-degraded">
              {preview.warnings.map((w, i) => (
                <li key={i}>
                  Line {w.row}: {w.message}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 grid gap-4 text-sm md:grid-cols-3">
            <div>
              <h3 className="text-live">Added</h3>
              <ul>
                {preview.diff.added.map((l, i) => (
                  <li key={i}>
                    {cohortLabel(l.cohort)} · Bus {l.bus_number} · {l.departure_time ?? "no time"}
                    {l.route_name && <span className="text-muted"> · {l.route_name}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-degraded">Changed</h3>
              <ul>
                {preview.diff.changed.map((c, i) => (
                  <li key={i}>
                    {cohortLabel(c.cohort)} · Bus {c.bus_number}: {describeChange(c)}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="text-dark">Removed</h3>
              <ul>
                {preview.diff.removed.map((l, i) => (
                  <li key={i}>
                    {cohortLabel(l.cohort)} · Bus {l.bus_number} · {l.departure_time ?? "no time"}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <button
            onClick={review}
            className="mt-4 rounded-lg bg-live px-4 py-2 font-semibold text-black"
          >
            {preview.notify_count
              ? `Review and publish (${plural(preview.notify_count, "student")})…`
              : "Apply (notifies nobody)…"}
          </button>
        </section>
      )}

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="font-semibold">Published list for {date}</h2>
        <ErrorText>{current.error}</ErrorText>
        <ul className="mt-3 text-sm">
          {current.data?.buses.map((b, i) => (
            <li key={i}>
              {cohortLabel(b.cohort)} · Bus {b.bus_number_raw} · {b.departure_time ?? "no time"}
              {b.route_name && <span className="text-muted"> · {b.route_name}</span>}
              {b.notes && <span className="text-muted"> · {b.notes}</span>}
            </li>
          ))}
          {current.data && !current.data.buses.length && (
            <li className="text-muted">Nothing published for this day.</li>
          )}
        </ul>
        {current.data?.uploads.length ? (
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted">Uploads for this day</summary>
            <ul className="mt-2">
              {current.data.uploads.map((u) => (
                <li key={u.id}>
                  {u.original_name} · {u.status} · {u.uploaded_name} ·{" "}
                  {fmtTime(u.applied_at ?? u.created_at)}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {send && (
        <ConfirmSend
          preview={send}
          onClose={() => setSend(null)}
          onConfirm={(count) => apply(count)}
        />
      )}
    </div>
  );
}
