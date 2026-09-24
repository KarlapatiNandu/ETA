"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ErrorText, Field } from "@/components/ui";
import { supabaseBrowser } from "@/lib/supabase/client";
import type { Profile } from "@/lib/supabase/server";

/** Account settings (Stage 4). Writes go straight to profiles; RLS + column grants limit them. */
export function SettingsForm({ profile }: { profile: Profile }) {
  const router = useRouter();
  const supabase = supabaseBrowser();
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function savePrefs(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const { error } = await supabase
      .from("profiles")
      .update({
        travel_mode: f.get("travel_mode"),
        default_buffer_s: Number(f.get("buffer_min")) * 60,
      })
      .eq("id", profile.id);
    setError(error ? "Could not save. Try again." : null);
    setMsg(error ? null : "Saved.");
  }

  async function changePassword(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const password = String(new FormData(form).get("password"));
    if (password.length < 8) return setError("Use at least 8 characters.");
    const { error } = await supabase.auth.updateUser({ password });
    setError(error ? error.message : null);
    setMsg(error ? null : "Password changed.");
    if (!error) form.reset();
  }

  async function signOut() {
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-line bg-panel p-6">
        <h1 className="mb-4 text-xl font-semibold">Account</h1>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted">Name</dt>
          <dd>{profile.full_name}</dd>
          <dt className="text-muted">Roll number</dt>
          <dd>{profile.roll_no}</dd>
          <dt className="text-muted">Phone</dt>
          <dd>
            {profile.phone_e164} <span className="text-live">✓ verified</span>
          </dd>
          <dt className="text-muted">Cohort</dt>
          <dd className="capitalize">{profile.cohort}</dd>
        </dl>
        <p className="mt-3 text-xs text-muted">
          Wrong details? The Transport Department maintains these.
        </p>
      </section>

      <form onSubmit={savePrefs} className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="mb-4 font-semibold">Getting to your stop</h2>
        <label className="mb-3 block text-sm">
          <span className="mb-1 block text-muted">I usually travel to my stop by</span>
          <select
            name="travel_mode"
            defaultValue={profile.travel_mode}
            className="w-full rounded-lg border border-line bg-canvas px-3 py-2"
          >
            <option value="foot">Walking</option>
            <option value="bicycle">Bicycle</option>
            <option value="motorbike">Motorbike</option>
            <option value="car">Car</option>
          </select>
        </label>
        <Field
          label="Extra safety margin (minutes)"
          name="buffer_min"
          type="number"
          min={0}
          max={60}
          defaultValue={profile.default_buffer_s / 60}
        />
        <Button>Save</Button>
      </form>

      <form onSubmit={changePassword} className="rounded-2xl border border-line bg-panel p-6">
        <h2 className="mb-4 font-semibold">Change password</h2>
        <Field
          label="New password"
          name="password"
          type="password"
          minLength={8}
          maxLength={72}
          autoComplete="new-password"
          required
        />
        <Button>Change password</Button>
      </form>

      <ErrorText>{error}</ErrorText>
      {msg && <p className="text-sm text-live">{msg}</p>}
      <button onClick={signOut} className="text-sm text-muted underline">
        Sign out
      </button>
    </div>
  );
}
