"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { syntheticEmail } from "@busmitra/contracts";
import { Button, Card, ErrorText, Field } from "@/components/ui";
import { supabaseBrowser } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const { error } = await supabaseBrowser().auth.signInWithPassword({
      email: syntheticEmail(String(form.get("roll_no"))),
      password: String(form.get("password")),
    });
    setBusy(false);
    if (error) return setError("Roll number or password is incorrect.");
    router.replace("/");
    router.refresh();
  }

  return (
    <Card title="Sign in">
      <form onSubmit={onSubmit}>
        <Field
          label="Roll number"
          name="roll_no"
          required
          autoComplete="username"
          inputMode="numeric"
        />
        <Field
          label="Password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
        />
        <ErrorText>{error}</ErrorText>
        <Button disabled={busy}>{busy ? "Signing in…" : "Sign in"}</Button>
      </form>
      <div className="mt-4 flex justify-between text-sm text-muted">
        <Link href="/claim">First time? Claim your account</Link>
        <Link href="/recover">Forgot password</Link>
      </div>
    </Card>
  );
}
