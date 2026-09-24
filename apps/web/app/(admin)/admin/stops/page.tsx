"use client";
import { useState } from "react";
import type { StopSearchHit } from "@busmitra/contracts";
import { ErrorText } from "@/components/ui";
import { admin, AdminError } from "@/lib/admin";

/**
 * Stop management (carried from Stage 1): rename, aliases, area and landmark — what students
 * search by. Moving or archiving a stop that a published route uses is refused by the gateway:
 * that is a new route version, made in the route editor.
 */
export default function StopsPage() {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<StopSearchHit[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  async function search(text: string) {
    setQ(text);
    if (text.trim().length < 2) return setHits([]);
    try {
      setHits(await admin<StopSearchHit[]>(`/v1/admin/stops?q=${encodeURIComponent(text.trim())}`));
    } catch {
      setError("Could not search stops.");
    }
  }

  async function save(id: string, f: FormData) {
    setError(null);
    setSaved(null);
    try {
      await admin(`/v1/admin/stops/${id}`, {
        method: "PATCH",
        body: {
          name: String(f.get("name")),
          aliases: String(f.get("aliases") ?? "")
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
          area_name: String(f.get("area_name") || "") || null,
          landmark: String(f.get("landmark") || "") || null,
        },
      });
      setSaved(id);
      await search(q);
    } catch (e) {
      setError(e instanceof AdminError ? e.message : "Could not save.");
    }
  }

  async function archive(id: string, name: string) {
    if (!confirm(`Archive ${name}? Students will no longer find it.`)) return;
    try {
      await admin(`/v1/admin/stops/${id}/archive`, { method: "POST" });
      await search(q);
    } catch (e) {
      setError(e instanceof AdminError ? e.message : "Could not archive.");
    }
  }

  return (
    <section className="rounded-2xl border border-line bg-panel p-6">
      <h1 className="text-xl font-semibold">Stops</h1>
      <p className="mt-1 text-sm text-muted">
        Names, aliases and areas are what students type into search. To move a stop on a published
        route, make a new version of the route.
      </p>
      <input
        value={q}
        onChange={(e) => void search(e.target.value)}
        placeholder="Find a stop"
        aria-label="Find a stop"
        className="mt-4 w-80 rounded-lg border border-line bg-canvas px-3 py-2 text-sm"
      />
      <ErrorText>{error}</ErrorText>
      <ul className="mt-4 space-y-4">
        {hits.map((s) => (
          <StopRow key={s.id} stop={s} saved={saved === s.id} onSave={save} onArchive={archive} />
        ))}
      </ul>
    </section>
  );
}

function StopRow({
  stop,
  saved,
  onSave,
  onArchive,
}: {
  stop: StopSearchHit;
  saved: boolean;
  onSave: (id: string, f: FormData) => Promise<void>;
  onArchive: (id: string, name: string) => Promise<void>;
}) {
  const cls = "rounded-lg border border-line bg-canvas px-2 py-1.5";
  return (
    <li className="border-t border-line pt-3">
      <form
        className="flex flex-wrap items-end gap-2 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void onSave(stop.id, new FormData(e.currentTarget));
        }}
      >
        <input
          name="name"
          defaultValue={stop.name}
          aria-label="Name"
          required
          className={`${cls} w-56`}
        />
        <input
          name="aliases"
          defaultValue={(stop.aliases ?? []).join(", ")}
          placeholder="Aliases, comma separated"
          aria-label="Aliases"
          className={`${cls} w-56`}
        />
        <input
          name="area_name"
          defaultValue={stop.area_name ?? ""}
          placeholder="Area"
          aria-label="Area"
          className={`${cls} w-40`}
        />
        <input
          name="landmark"
          defaultValue={stop.landmark ?? ""}
          placeholder="Landmark"
          aria-label="Landmark"
          className={`${cls} w-48`}
        />
        <button className="rounded-lg border border-line px-3 py-1.5">Save</button>
        <button
          type="button"
          onClick={() => void onArchive(stop.id, stop.name)}
          className="px-2 py-1.5 text-muted"
        >
          Archive
        </button>
        {saved && <span className="text-live">Saved</span>}
      </form>
    </li>
  );
}
