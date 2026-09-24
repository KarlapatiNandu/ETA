"use client";
import Link from "next/link";
import { useState } from "react";
import type { OtpStartResponse } from "@busmitra/contracts";
import { Button, Card, ErrorText, Field } from "@/components/ui";
import { gateway, GatewayError } from "@/lib/gateway";

/**
 * Shared two-step flow for claim and recovery: roll number → code + password.
 * The first step always "succeeds" — the server never says whether the roll exists.
 */
export function OtpFlow({ purpose }: { purpose: "claim" | "recover" }) {
  const [rollNo, setRollNo] = useState("");
  const [sent, setSent] = useState<OtpStartResponse | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof GatewayError ? e.message : "Could not reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Card title={purpose === "claim" ? "Account ready" : "Password changed"}>
        <p className="mb-4 text-muted">
          You can now sign in with your roll number and new password.
        </p>
        <Link href="/login" className="font-semibold text-live">
          Go to sign in →
        </Link>
      </Card>
    );
  }

  if (!sent) {
    return (
      <Card title={purpose === "claim" ? "Claim your account" : "Reset your password"}>
        <p className="mb-4 text-sm text-muted">
          We will text a 6-digit code to the phone number the Transport Department has on file for
          you.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () =>
              setSent(
                await gateway<OtpStartResponse>(`/v1/auth/${purpose}/start`, {
                  body: { roll_no: rollNo },
                }),
              ),
            );
          }}
        >
          <Field
            label="Roll number"
            value={rollNo}
            onChange={(e) => setRollNo(e.target.value)}
            required
            inputMode="numeric"
          />
          <ErrorText>{error}</ErrorText>
          <Button disabled={busy}>{busy ? "Sending…" : "Send code"}</Button>
        </form>
      </Card>
    );
  }

  return (
    <Card title="Enter the code">
      <p className="mb-4 text-sm text-muted">
        If {rollNo.toUpperCase()} is eligible, a code was sent to{" "}
        <span className="text-ink">{sent.masked_phone}</span>. It expires in{" "}
        {Math.round(sent.expires_in_s / 60)} minutes. Not your number? Contact the Transport
        Department.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const password = String(f.get("password"));
          if (password !== String(f.get("confirm")))
            return setError("The two passwords do not match.");
          run(async () => {
            await gateway(`/v1/auth/${purpose}/verify`, {
              body:
                purpose === "claim"
                  ? { roll_no: rollNo, otp: f.get("otp"), password }
                  : { roll_no: rollNo, otp: f.get("otp"), new_password: password },
            });
            setDone(true);
          });
        }}
      >
        <Field
          label="6-digit code"
          name="otp"
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="\d{6}"
          maxLength={6}
        />
        <Field
          label="New password (8+ characters)"
          name="password"
          type="password"
          required
          minLength={8}
          maxLength={72}
          autoComplete="new-password"
        />
        <Field
          label="Confirm password"
          name="confirm"
          type="password"
          required
          autoComplete="new-password"
        />
        <ErrorText>{error}</ErrorText>
        <Button disabled={busy}>
          {busy ? "Checking…" : purpose === "claim" ? "Create account" : "Set password"}
        </Button>
      </form>
      <button className="mt-4 text-sm text-muted" onClick={() => setSent(null)}>
        ← Send a new code
      </button>
    </Card>
  );
}
