"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorText } from "@/components/ui";
import { admin, AdminError, fmtTime, useAdmin } from "@/lib/admin";

type Ticket = {
  id: string;
  kind: string;
  severity: number;
  status: string;
  title: string;
  bus_number: string | null;
  opened_at: string;
  automatic: boolean;
  assigned_name: string | null;
};

const STATUS_CLS: Record<string, string> = {
  open: "text-dark",
  acknowledged: "text-degraded",
  resolved: "text-live",
  cancelled: "text-muted",
};

function Queue() {
  const bus = useSearchParams().get("bus");
  const [filter, setFilter] = useState<"active" | "resolved" | "all">("active");
  const { data, error, reload } = useAdmin<{ tickets: Ticket[] }>(
    `/v1/admin/tickets?status=${filter}`,
    15_000,
  );
  const [err, setErr] = useState<string | null>(null);
  const tickets = (data?.tickets ?? []).filter((t) => !bus || t.bus_number === bus);

  async function raise(f: FormData) {
    setErr(null);
    try {
      await admin("/v1/admin/tickets", {
        body: {
          kind: String(f.get("kind")),
          severity: Number(f.get("severity")),
          title: String(f.get("title")),
          description: String(f.get("description") || "") || undefined,
        },
      });
      await reload();
    } catch (e) {
      setErr(e instanceof AdminError ? e.message : "Could not raise the ticket.");
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-panel p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">Tickets{bus ? ` · Bus ${bus}` : ""}</h1>
          <div className="ml-auto flex gap-1 text-sm" role="group" aria-label="Show">
            {(["active", "resolved", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                aria-pressed={filter === f}
                className={`rounded-lg px-3 py-1 ${filter === f ? "bg-raised text-ink" : "text-muted"}`}
              >
                {f === "active" ? "Open" : f === "resolved" ? "Closed" : "All"}
              </button>
            ))}
          </div>
        </div>
        <ErrorText>{error ?? err}</ErrorText>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1">Ticket</th>
              <th>Bus</th>
              <th>Status</th>
              <th>Assigned</th>
              <th>Opened</th>
            </tr>
          </thead>
          <tbody>
            {tickets.map((t) => (
              <tr key={t.id} className="border-t border-line">
                <td className="py-2">
                  <Link href={`/admin/tickets/${t.id}`} className="underline">
                    {t.title}
                  </Link>
                  <span className="text-muted">
                    {" "}
                    · T{t.severity} · {t.kind.replace(/_/g, " ")}
                    {t.automatic && " · automatic"}
                  </span>
                </td>
                <td>{t.bus_number ?? "—"}</td>
                <td className={STATUS_CLS[t.status]}>{t.status}</td>
                <td>{t.assigned_name ?? <span className="text-muted">nobody</span>}</td>
                <td>{fmtTime(t.opened_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !tickets.length && <p className="mt-4 text-muted">Nothing here.</p>}
      </section>

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="font-semibold">Raise a ticket</h2>
        <p className="mt-1 text-sm text-muted">
          For the department&apos;s own follow-up — it notifies no students. To take a bus off the
          road, use its page under Fleet.
        </p>
        <form
          className="mt-3 flex flex-wrap gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            void raise(new FormData(e.currentTarget));
            e.currentTarget.reset();
          }}
        >
          <select
            name="kind"
            aria-label="Kind"
            className="rounded-lg border border-line bg-canvas px-3 py-2"
          >
            <option value="breakdown">Breakdown</option>
            <option value="delay">Delay</option>
            <option value="route_change">Route change</option>
            <option value="other">Other</option>
          </select>
          <select
            name="severity"
            aria-label="Severity"
            defaultValue="2"
            className="rounded-lg border border-line bg-canvas px-3 py-2"
          >
            {[1, 2, 3, 4].map((s) => (
              <option key={s} value={s}>
                Severity T{s}
              </option>
            ))}
          </select>
          <input
            name="title"
            required
            placeholder="What is wrong"
            aria-label="Title"
            className="w-72 rounded-lg border border-line bg-canvas px-3 py-2"
          />
          <input
            name="description"
            placeholder="Details (optional)"
            aria-label="Details"
            className="w-72 rounded-lg border border-line bg-canvas px-3 py-2"
          />
          <button className="rounded-lg border border-line px-4 py-2">Raise</button>
        </form>
      </section>
    </div>
  );
}

export default function TicketsPage() {
  return (
    <Suspense>
      <Queue />
    </Suspense>
  );
}
