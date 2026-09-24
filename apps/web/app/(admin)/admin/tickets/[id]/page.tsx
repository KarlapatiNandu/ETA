"use client";
import Link from "next/link";
import { use, useState } from "react";
import { ConfirmSend, type SendPreview } from "@/components/admin/confirm-send";
import { ErrorText } from "@/components/ui";
import { admin, AdminError, fmtTime, useAdmin } from "@/lib/admin";

type Detail = {
  ticket: {
    id: string;
    kind: string;
    severity: number;
    status: string;
    title: string;
    description: string | null;
    bus_id: string | null;
    bus_number: string | null;
    opened_at: string;
    opened_name: string | null;
    assigned_to: string | null;
    resolved_at: string | null;
    resolved_name: string | null;
    resolution_note: string | null;
  };
  events: {
    id: string;
    from_status: string | null;
    to_status: string;
    note: string | null;
    created_at: string;
    actor_name: string | null;
  }[];
};

export default function TicketPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data, error, reload } = useAdmin<Detail>(`/v1/admin/tickets/${id}`);
  const admins = useAdmin<{ admins: { id: string; full_name: string }[] }>("/v1/admin/admins");
  const [err, setErr] = useState<string | null>(null);
  const [send, setSend] = useState<(SendPreview & { note: string }) | null>(null);
  if (!data) return <p className="text-muted">{error ?? "Loading…"}</p>;
  const t = data.ticket;
  const openish = t.status === "open" || t.status === "acknowledged";
  const commission = t.kind === "out_of_commission";

  const act = async (body: Record<string, unknown>) => {
    setErr(null);
    try {
      await admin(`/v1/admin/tickets/${id}/actions`, { body });
      await reload();
    } catch (e) {
      setErr(e instanceof AdminError ? e.message : "Could not update the ticket.");
    }
  };

  async function resolve(f: FormData) {
    const note = String(f.get("note") ?? "").trim();
    if (!note) return setErr("Say how it was resolved.");
    if (!commission) return act({ action: "resolve", note });
    // back in service: the same students who were told it was out are told it is back (T2)
    const { count } = await admin<{ count: number }>(`/v1/admin/buses/${t.bus_id}/audience`);
    setSend({
      tier: 2,
      action: `Return Bus ${t.bus_number} to service`,
      title: `Bus ${t.bus_number} is back in service`,
      body: note,
      count,
      note,
    });
  }

  return (
    <div className="space-y-6">
      <Link href="/admin/tickets" className="text-sm text-muted">
        ← Tickets
      </Link>
      <section className="rounded-2xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold">{t.title}</h1>
        <p className="mt-1 text-sm text-muted">
          T{t.severity} · {t.kind.replace(/_/g, " ")} · opened {fmtTime(t.opened_at)} by{" "}
          {t.opened_name ?? "the system"}
          {t.bus_number && (
            <>
              {" "}
              ·{" "}
              <Link href={`/admin/fleet/${t.bus_id}`} className="underline">
                Bus {t.bus_number}
              </Link>
            </>
          )}
        </p>
        <p className="mt-3">
          Status: <strong data-testid="ticket-status">{t.status}</strong>
          {t.resolution_note && <span className="text-muted"> — {t.resolution_note}</span>}
        </p>
        {t.description && <p className="mt-2 whitespace-pre-line text-sm">{t.description}</p>}
        <p className="mt-2 text-xs text-muted">
          Notes on a ticket are visible to students who can see the ticket.
        </p>
        <ErrorText>{err}</ErrorText>

        {openish && (
          <div className="mt-4 space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              {t.status === "open" && (
                <button
                  onClick={() => void act({ action: "acknowledge" })}
                  className="rounded-lg border border-line px-3 py-1.5"
                >
                  Acknowledge
                </button>
              )}
              <label className="flex items-center gap-2">
                <span className="text-muted">Assigned to</span>
                <select
                  value={t.assigned_to ?? ""}
                  onChange={(e) =>
                    void act({ action: "assign", assigned_to: e.target.value || null })
                  }
                  className="rounded-lg border border-line bg-canvas px-2 py-1.5"
                >
                  <option value="">nobody</option>
                  {admins.data?.admins.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.full_name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void resolve(new FormData(e.currentTarget)).catch((x) => setErr(String(x)));
              }}
            >
              <input
                name="note"
                placeholder={
                  commission
                    ? "e.g. Repaired; running normally from tomorrow"
                    : "How was it resolved?"
                }
                aria-label="Resolution"
                className="w-96 rounded-lg border border-line bg-canvas px-3 py-2"
              />
              <button className="rounded-lg bg-live px-4 py-2 font-semibold text-black">
                {commission ? "Back in service…" : "Resolve"}
              </button>
              {!commission && (
                <button
                  type="button"
                  onClick={() => {
                    const note = prompt("Why cancel this ticket?");
                    if (note) void act({ action: "cancel", note });
                  }}
                  className="rounded-lg px-3 py-2 text-muted"
                >
                  Cancel ticket
                </button>
              )}
            </form>
          </div>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="font-semibold">Timeline</h2>
        <ol className="mt-3 space-y-2 text-sm">
          {data.events.map((e) => (
            <li key={e.id} className="border-l-2 border-line pl-3">
              <span className="text-muted">{fmtTime(e.created_at)}</span> ·{" "}
              {e.actor_name ?? "system"} ·{" "}
              {e.from_status && e.from_status !== e.to_status
                ? `${e.from_status} → ${e.to_status}`
                : e.to_status}
              {e.note && <span className="block">{e.note}</span>}
            </li>
          ))}
        </ol>
        <form
          className="mt-4 flex gap-2 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const note = String(new FormData(e.currentTarget).get("note") ?? "").trim();
            if (note) void act({ action: "note", note });
            e.currentTarget.reset();
          }}
        >
          <input
            name="note"
            placeholder="Add a note"
            aria-label="Add a note"
            className="w-96 rounded-lg border border-line bg-canvas px-3 py-2"
          />
          <button className="rounded-lg border border-line px-3 py-2">Add</button>
        </form>
      </section>

      {send && (
        <ConfirmSend
          preview={send}
          onClose={() => setSend(null)}
          onConfirm={async (count) => {
            await admin(`/v1/admin/tickets/${id}/actions`, {
              body: { action: "resolve", note: send.note, confirm_count: count },
            });
            setSend(null);
            await reload();
          }}
        />
      )}
    </div>
  );
}
