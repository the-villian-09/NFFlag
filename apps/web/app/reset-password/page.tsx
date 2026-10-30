"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { authApi } from "@/lib/api";

function ResetForm() {
  const token = useSearchParams().get("token");
  const { busy, error, run } = useAction();
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    if ((await run(() => authApi.resetPassword(token ?? "", password))) !== undefined) setDone(true);
  }

  if (!token) return <p>This reset link is invalid or has expired. <Link href="/forgot-password">Request a new one</Link>.</p>;
  if (done) return <p>Your password was changed and you were signed out everywhere. <Link href="/sign-in">Sign in</Link>.</p>;
  return (
    <form className="stack" onSubmit={onSubmit}>
      <ErrorAlert error={error} />
      <label>
        New password
        <input type="password" name="password" autoComplete="new-password" minLength={10} required />
      </label>
      <button className="btn" disabled={busy}>
        {busy ? "Saving…" : "Set new password"}
      </button>
    </form>
  );
}

export default function ResetPasswordPage() {
  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Choose a new password</h1>
        <Suspense>
          <ResetForm />
        </Suspense>
      </div>
    </div>
  );
}
