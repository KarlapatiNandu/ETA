"use client";
import Link from "next/link";
import { use, useEffect, useState } from "react";
import QRCode from "qrcode";
import { ConfirmSend, type SendPreview } from "@/components/admin/confirm-send";
import { ErrorText } from "@/components/ui";
import { admin, AdminError, fmtTime, useAdmin } from "@/lib/admin";
import type { Bus, Driver, RouteOption } from "@/components/admin/types";

const input =
  "rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-live";

/** One-time pairing link as a QR code: shown once, never retrievable again (ARCH §10). */
function PairingCode({ link, onDone }: { link: string; onDone: () => void }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    void QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" }).then(setSvg);
  }, [link]);
  return (
    <div className="mt-4 rounded-xl border border-live p-4" data-testid="pairing">
      <p className="text-sm font-semibold">Scan this with the driver&apos;s phone camera.</p>
      <p className="mt-1 text-xs text-muted">
        It is shown once and cannot be shown again. If it is lost, rotate the secret for a new one.
      </p>
      <div
        className="mt-3 w-56 rounded-lg bg-white p-2"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-muted">Or open this link on the phone</summary>
        <code className="break-all">{link}</code>
      </details>
      <button onClick={onDone} className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm">
        Done — hide it
      </button>
    </div>
  );
}

export default function BusPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const buses = useAdmin<{ buses: Bus[] }>("/v1/admin/buses");
  const drivers = useAdmin<{ drivers: Driver[] }>("/v1/admin/drivers");
  const routes = useAdmin<{ routes: RouteOption[] }>("/v1/admin/route-options");
  const bus = buses.data?.buses.find((b) => b.id === id);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [send, setSend] = useState<(SendPreview & { note: string }) | null>(null);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await buses.reload();
    } catch (e) {
      setError(e instanceof AdminError ? e.message : "Something went wrong.");
    }
  };

  if (!bus) return <p className="text-muted">{buses.error ?? "Loading…"}</p>;

  async function startOutOfCommission(form: FormData) {
    const note = String(form.get("note") ?? "").trim();
    if (!note) return setError("Say why the bus is out of commission — students will read it.");
    const { count } = await admin<{ count: number }>(`/v1/admin/buses/${id}/audience`);
    setSend({
      tier: 0,
      action: `Mark Bus ${bus!.bus_number} out of commission`,
      title: `Bus ${bus!.bus_number} is out of commission`,
      body: note,
      count,
      note,
    });
  }

  return (
    <div className="space-y-6">
      <Link href="/admin/fleet" className="text-sm text-muted">
        ← Fleet
      </Link>
      <section className="rounded-2xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold">Bus {bus.bus_number}</h1>
        <ErrorText>{error}</ErrorText>
        <form
          className="mt-4 grid max-w-xl grid-cols-2 gap-3 text-sm"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            void act(() =>
              admin(`/v1/admin/buses/${id}`, {
                method: "PATCH",
                body: {
                  registration_no: String(f.get("registration_no") || "") || null,
                  capacity: f.get("capacity") ? Number(f.get("capacity")) : null,
                  default_route_id: String(f.get("route") || "") || null,
                  driver_id: String(f.get("driver") || "") || null,
                },
              }),
            );
          }}
        >
          <label>
            <span className="mb-1 block text-muted">Registration</span>
            <input
              name="registration_no"
              defaultValue={bus.registration_no ?? ""}
              className={`${input} w-full`}
            />
          </label>
          <label>
            <span className="mb-1 block text-muted">Seats</span>
            <input
              name="capacity"
              type="number"
              min={1}
              max={120}
              defaultValue={bus.capacity ?? ""}
              className={`${input} w-full`}
            />
          </label>
          <label>
            <span className="mb-1 block text-muted">Route</span>
            <select
              name="route"
              defaultValue={bus.current_route_id ?? ""}
              className={`${input} w-full`}
            >
              <option value="">No route</option>
              {routes.data?.routes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.direction})
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-muted">Driver</span>
            <select name="driver" defaultValue={bus.driver_id ?? ""} className={`${input} w-full`}>
              <option value="">No driver</option>
              {drivers.data?.drivers.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name}
                  {d.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </label>
          <button className="col-span-2 w-fit rounded-lg border border-line px-4 py-2">Save</button>
        </form>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="font-semibold">Status</h2>
        <p className="mt-1 text-sm">
          Now:{" "}
          <strong className={bus.status === "out_of_commission" ? "text-dark" : ""}>
            {bus.status.replace(/_/g, " ")}
          </strong>
          {bus.status_note && <span className="text-muted"> — {bus.status_note}</span>}
        </p>
        {bus.status === "out_of_commission" ? (
          <p className="mt-3 text-sm">
            To put it back in service,{" "}
            <Link href={`/admin/tickets/${bus.commission_ticket_id}`} className="underline">
              resolve its ticket
            </Link>{" "}
            — that tells the students who were warned.
          </p>
        ) : (
          <>
            <form
              className="mt-4 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void startOutOfCommission(new FormData(e.currentTarget)).catch((err) =>
                  setError(err instanceof Error ? err.message : "Could not count the audience."),
                );
              }}
            >
              <label className="text-sm">
                <span className="mb-1 block text-muted">
                  Why is it out of commission? (students will read this)
                </span>
                <input
                  name="note"
                  placeholder="e.g. Breakdown at Uppal; no replacement today"
                  className={`${input} w-96`}
                />
              </label>
              <button className="rounded-lg bg-dark px-4 py-2 text-sm font-semibold text-white">
                Mark out of commission…
              </button>
            </form>
            <div className="mt-3 flex gap-2 text-sm">
              {(["active", "maintenance", "retired"] as const)
                .filter((s) => s !== bus.status)
                .map((s) => (
                  <button
                    key={s}
                    onClick={() =>
                      void act(() =>
                        admin(`/v1/admin/buses/${id}/status`, {
                          method: "PUT",
                          body: { status: s },
                        }),
                      )
                    }
                    className="rounded-lg border border-line px-3 py-1.5"
                  >
                    Set {s} (no one is notified)
                  </button>
                ))}
            </div>
          </>
        )}
      </section>

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="font-semibold">Tracker phones</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {bus.trackers.map((t) => (
            <li key={t.device_uid} className="flex flex-wrap items-center gap-3">
              <code>{t.device_uid}</code>
              <span className="text-muted">
                last seen {fmtTime(t.last_seen_at)} · secret set {fmtTime(t.secret_rotated_at)}
              </span>
              <button
                className="text-live"
                onClick={() =>
                  void act(async () =>
                    setLink(
                      (
                        await admin<{ link: string }>(`/v1/admin/trackers/${t.device_uid}/rotate`, {
                          method: "POST",
                        })
                      ).link,
                    ),
                  )
                }
              >
                Rotate secret
              </button>
              <button
                className="text-dark"
                onClick={() => {
                  if (
                    confirm(
                      `Unpair ${t.device_uid}? That phone stops reporting for Bus ${bus.bus_number}.`,
                    )
                  )
                    void act(() =>
                      admin(`/v1/admin/trackers/${t.device_uid}/unpair`, { method: "POST" }),
                    );
                }}
              >
                Unpair
              </button>
            </li>
          ))}
          {!bus.trackers.length && (
            <li className="text-degraded">
              No phone is paired: this bus cannot appear on the map.
            </li>
          )}
        </ul>
        <button
          className="mt-4 rounded-lg bg-live px-4 py-2 text-sm font-semibold text-black"
          onClick={() =>
            void act(async () =>
              setLink(
                (
                  await admin<{ link: string }>(`/v1/admin/buses/${id}/trackers`, {
                    method: "POST",
                  })
                ).link,
              ),
            )
          }
        >
          Pair a phone
        </button>
        <p className="mt-2 text-xs text-muted">
          After a rotation the old secret keeps working for 10 minutes, so a phone mid-route is not
          cut off.
        </p>
        {link && <PairingCode link={link} onDone={() => setLink(null)} />}
        <button
          className="mt-6 block text-sm text-muted underline"
          onClick={() => {
            if (confirm(`Archive Bus ${bus.bus_number}? It leaves the fleet; its history is kept.`))
              void act(() => admin(`/v1/admin/buses/${id}/archive`, { method: "POST" }));
          }}
        >
          Archive this bus
        </button>
      </section>

      {send && (
        <ConfirmSend
          preview={send}
          onClose={() => setSend(null)}
          onConfirm={async (count, typed) => {
            await admin(`/v1/admin/buses/${id}/status`, {
              method: "PUT",
              body: {
                status: "out_of_commission",
                note: send.note,
                confirm_count: count,
                confirm_text: typed,
              },
            });
            setSend(null);
            await buses.reload();
          }}
        />
      )}
    </div>
  );
}
