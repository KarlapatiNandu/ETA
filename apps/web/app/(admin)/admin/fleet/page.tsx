"use client";
import Link from "next/link";
import { useState } from "react";
import { ErrorText } from "@/components/ui";
import { admin, AdminError, useAdmin } from "@/lib/admin";

import type { Bus, Driver, RouteOption } from "@/components/admin/types";

const input =
  "rounded-lg border border-line bg-canvas px-3 py-2 text-sm outline-none focus:border-live";

/** Fleet management (BUILD_PLAN Stage 7): buses, drivers, route assignment. */
export default function FleetPage() {
  const buses = useAdmin<{ buses: Bus[] }>("/v1/admin/buses");
  const drivers = useAdmin<{ drivers: Driver[] }>("/v1/admin/drivers");
  const routes = useAdmin<{ routes: RouteOption[] }>("/v1/admin/route-options");
  const [error, setError] = useState<string | null>(null);

  async function addBus(form: FormData) {
    setError(null);
    try {
      await admin("/v1/admin/buses", {
        body: {
          bus_number: String(form.get("bus_number")),
          registration_no: String(form.get("registration_no") || "") || null,
          capacity: form.get("capacity") ? Number(form.get("capacity")) : null,
          default_route_id: String(form.get("route") || "") || null,
          driver_id: String(form.get("driver") || "") || null,
        },
      });
      await buses.reload();
    } catch (e) {
      setError(e instanceof AdminError ? e.message : "Could not add the bus.");
    }
  }

  async function addDriver(form: FormData) {
    setError(null);
    try {
      await admin("/v1/admin/drivers", {
        body: {
          full_name: String(form.get("full_name")),
          phone: String(form.get("phone") || "") || null,
        },
      });
      await drivers.reload();
    } catch (e) {
      setError(e instanceof AdminError ? e.message : "Could not add the driver.");
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-panel p-6">
        <h1 className="text-xl font-semibold">Fleet</h1>
        <ErrorText>{error ?? buses.error}</ErrorText>
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-muted">
            <tr>
              <th className="py-1">Bus</th>
              <th>Registration</th>
              <th>Status</th>
              <th>Route</th>
              <th>Driver</th>
              <th>Tracker</th>
            </tr>
          </thead>
          <tbody>
            {buses.data?.buses.map((b) => (
              <tr key={b.id} className="border-t border-line">
                <td className="py-2 font-semibold">
                  <Link href={`/admin/fleet/${b.id}`} className="underline">
                    Bus {b.bus_number}
                  </Link>
                </td>
                <td>{b.registration_no ?? "—"}</td>
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
                <td>{b.route_name ?? <span className="text-muted">none</span>}</td>
                <td>{b.driver_name ?? <span className="text-muted">none</span>}</td>
                <td>
                  {b.trackers.length ? (
                    `${b.trackers.length} paired`
                  ) : (
                    <span className="text-degraded">not paired</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <form
          className="mt-6 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void addBus(new FormData(e.currentTarget));
            e.currentTarget.reset();
          }}
        >
          <input
            name="bus_number"
            required
            placeholder="Bus number"
            aria-label="Bus number"
            className={`${input} w-28`}
          />
          <input
            name="registration_no"
            placeholder="Registration"
            aria-label="Registration"
            className={`${input} w-36`}
          />
          <input
            name="capacity"
            type="number"
            min={1}
            max={120}
            placeholder="Seats"
            aria-label="Seats"
            className={`${input} w-20`}
          />
          <select name="route" aria-label="Route" className={input} defaultValue="">
            <option value="">No route yet</option>
            {routes.data?.routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} ({r.direction})
              </option>
            ))}
          </select>
          <select name="driver" aria-label="Driver" className={input} defaultValue="">
            <option value="">No driver yet</option>
            {drivers.data?.drivers
              .filter((d) => d.active)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.full_name}
                </option>
              ))}
          </select>
          <button className="rounded-lg bg-live px-4 py-2 text-sm font-semibold text-black">
            Add bus
          </button>
        </form>
      </section>

      <section className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="font-semibold">Drivers</h2>
        <p className="mt-1 text-sm text-muted">
          A driver is linked to a bus, never to its positions (driver location is fleet data, not
          personal tracking).
        </p>
        <ul className="mt-3 space-y-1 text-sm">
          {drivers.data?.drivers.map((d) => (
            <li key={d.id} className={d.active ? "" : "text-muted"}>
              {d.full_name} · {d.phone_e164 ?? "no phone"}
              {d.buses?.length ? ` · Bus ${d.buses.join(", ")}` : ""}
              {!d.active && " · inactive"}
            </li>
          ))}
        </ul>
        <form
          className="mt-4 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void addDriver(new FormData(e.currentTarget));
            e.currentTarget.reset();
          }}
        >
          <input
            name="full_name"
            required
            placeholder="Driver's name"
            aria-label="Driver's name"
            className={input}
          />
          <input
            name="phone"
            inputMode="tel"
            placeholder="Mobile"
            aria-label="Driver's mobile"
            className={`${input} w-36`}
          />
          <button className="rounded-lg border border-line px-4 py-2 text-sm">Add driver</button>
        </form>
      </section>
    </div>
  );
}
