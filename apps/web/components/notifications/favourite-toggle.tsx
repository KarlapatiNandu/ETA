"use client";
import { useEffect, useState } from "react";
import { me, type Favourite } from "./student-api";

/**
 * Star a bus, or make it *my* bus (ARCH §6.4): the main bus's start is an urgent alert, a
 * starred bus's start is a quiet one with Follow / Not today. One main bus at a time.
 */
export function FavouriteToggle({ busId, number }: { busId: string; number: string }) {
  const [fav, setFav] = useState<Favourite | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    me<{ favourites: Favourite[] }>("/v1/me/favourites")
      .then((r) => setFav(r.favourites.find((f) => f.bus_id === busId) ?? null))
      .catch(() => setFav(null));
  }, [busId]);
  if (fav === undefined) return null;

  const set = async (kind: "main" | "starred" | null) => {
    setBusy(true);
    try {
      if (kind) await me(`/v1/me/favourites/${busId}`, { method: "PUT", body: { kind } });
      else await me(`/v1/me/favourites/${busId}`, { method: "DELETE" });
      setFav(kind ? { bus_id: busId, bus_number: number, kind, muted_until: null } : null);
    } finally {
      setBusy(false);
    }
  };
  const btn = "rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50";
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2" data-testid="favourite">
      {fav?.kind === "main" ? (
        <span className="text-sm text-live">
          ★ Your bus — you get an urgent alert when it starts
        </span>
      ) : (
        <button
          disabled={busy}
          onClick={() => void set("main")}
          className={`${btn} border-live text-live`}
        >
          Make Bus {number} my bus
        </button>
      )}
      {!fav ? (
        <button
          disabled={busy}
          onClick={() => void set("starred")}
          className={`${btn} border-line`}
        >
          ☆ Star
        </button>
      ) : (
        <button
          disabled={busy}
          onClick={() => void set(null)}
          className={`${btn} border-line text-muted`}
        >
          {fav.kind === "main" ? "Not my bus" : "★ Unstar"}
        </button>
      )}
    </div>
  );
}
