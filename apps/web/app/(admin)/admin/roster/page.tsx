"use client";
import { useCallback, useEffect, useState } from "react";
import type { CsvError } from "@busmitra/contracts";
import { ErrorText } from "@/components/ui";
import { gateway, GatewayError } from "@/lib/gateway";
import { supabaseBrowser } from "@/lib/supabase/client";

type Summary = {
  added: number;
  changed: number;
  removed: number;
  unchanged: number;
  missing_phone: number;
};
type Preview = {
  id: string;
  status: "preview_ready" | "rejected";
  summary: Summary | null;
  errors: CsvError[];
  diff: {
    added: { roll_no: string; full_name: string; phone_e164: string | null }[];
    changed: { roll_no: string; fields: Record<string, { from: unknown; to: unknown }> }[];
    removed: { roll_no: string }[];
  } | null;
};
type Missing = {
  roll_no: string;
  full_name: string;
  admission_year: number;
  branch: string | null;
};

async function token() {
  const { data } = await supabaseBrowser().auth.getSession();
  return data.session?.access_token;
}

export default function RosterPage() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<Summary | null>(null);
  const [missing, setMissing] = useState<Missing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadMissing = useCallback(async () => {
    const t = await token();
    setMissing(
      (await gateway<{ students: Missing[] }>("/v1/admin/roster/missing-phone", { token: t }))
        .students,
    );
  }, []);
  useEffect(() => {
    loadMissing().catch(() => setError("Could not load the work queue."));
  }, [loadMissing]);

  async function onFile(file: File) {
    setBusy(true);
    setError(null);
    setApplied(null);
    try {
      setPreview(
        await gateway<Preview>("/v1/admin/roster/uploads", {
          raw: await file.text(),
          token: await token(),
          headers: { "x-filename": file.name },
        }),
      );
    } catch (e) {
      setError(e instanceof GatewayError ? e.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview?.summary) return;
    const s = preview.summary;
    if (
      !confirm(`Add ${s.added} and update ${s.changed} students on the roster? No one is notified.`)
    )
      return;
    setBusy(true);
    try {
      const res = await gateway<{ summary: Summary }>(
        `/v1/admin/roster/uploads/${preview.id}/apply`,
        { method: "POST", token: await token() },
      );
      setApplied(res.summary);
      setPreview(null);
      await loadMissing();
    } catch (e) {
      setError(e instanceof GatewayError ? e.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  async function savePhone(rollNo: string, phone: string) {
    try {
      await gateway(`/v1/admin/roster/students/${rollNo}`, {
        method: "PATCH",
        body: { phone },
        token: await token(),
      });
      await loadMissing();
    } catch (e) {
      setError(e instanceof GatewayError ? e.message : "Could not save.");
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold">Import student roster</h1>
        <p className="mt-1 text-sm text-muted">
          CSV columns: roll number, name, admission year, mobile, branch. Nothing changes until you
          confirm the preview.
        </p>
        <input
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          className="mt-4 text-sm"
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
        <ErrorText>{error}</ErrorText>
        {applied && (
          <p className="mt-3 text-sm text-live">
            Applied: {applied.added} added, {applied.changed} updated.
          </p>
        )}
      </section>

      {preview?.status === "rejected" && (
        <section className="rounded-2xl border border-dark bg-panel p-6">
          <h2 className="font-semibold text-dark">
            This file was not imported — fix these and upload again
          </h2>
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
                <tr key={i}>
                  <td>{e.row}</td>
                  <td>{e.column}</td>
                  <td>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {preview?.status === "preview_ready" && preview.summary && preview.diff && (
        <section className="rounded-2xl border border-line bg-panel p-6">
          <h2 className="font-semibold">Preview</h2>
          <p className="mt-1 text-sm text-muted">
            {preview.summary.added} new · {preview.summary.changed} changed ·{" "}
            {preview.summary.unchanged} unchanged · {preview.summary.removed} on the roster but not
            in this file (kept, not deleted) · {preview.summary.missing_phone} without a phone
          </p>
          {preview.diff.added.length > 0 && (
            <details className="mt-3" open>
              <summary className="cursor-pointer">New ({preview.diff.added.length})</summary>
              <ul className="mt-2 text-sm">
                {preview.diff.added.map((r) => (
                  <li key={r.roll_no}>
                    {r.roll_no} — {r.full_name}
                    {!r.phone_e164 && <span className="text-degraded"> · no phone</span>}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {preview.diff.changed.length > 0 && (
            <details className="mt-3" open>
              <summary className="cursor-pointer">Changed ({preview.diff.changed.length})</summary>
              <ul className="mt-2 text-sm">
                {preview.diff.changed.map((c) => (
                  <li key={c.roll_no}>
                    {c.roll_no}:{" "}
                    {Object.entries(c.fields)
                      .map(([f, v]) => `${f} ${String(v.from)} → ${String(v.to)}`)
                      .join(", ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <button
            onClick={apply}
            disabled={busy}
            className="mt-4 rounded-lg bg-live px-4 py-2 font-semibold text-black disabled:opacity-50"
          >
            Apply to roster
          </button>
        </section>
      )}

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="font-semibold">
          Students who cannot claim yet — no phone number ({missing.length})
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          {missing.map((m) => (
            <li key={m.roll_no}>
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  savePhone(m.roll_no, String(new FormData(e.currentTarget).get("phone")));
                }}
              >
                <span className="w-40">{m.roll_no}</span>
                <span className="flex-1">{m.full_name}</span>
                <input
                  name="phone"
                  placeholder="98765 43210"
                  inputMode="tel"
                  required
                  className="w-36 rounded border border-line bg-canvas px-2 py-1"
                />
                <button className="text-live">Save</button>
              </form>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
