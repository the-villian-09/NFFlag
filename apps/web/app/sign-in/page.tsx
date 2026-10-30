"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { ApiError, authApi } from "@/lib/api";

export default function SignInPage() {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [resentTo, setResentTo] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    setResentTo(null);
    try {
      const res = await authApi.signIn({ email, password: String(f.get("password")) });
      // Two-step sign-in turned on → code step. Otherwise straight in.
      router.push(res.twoFactorRedirect ? "/two-factor" : "/dashboard");
    } catch (err) {
      // Email not confirmed yet: the API has just re-sent the link.
      if (err instanceof ApiError && err.status === 403 && err.code === "EMAIL_NOT_VERIFIED") {
        setResentTo(email);
        return;
      }
      await run(() => Promise.reject(err));
    }
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Sign in</h1>
        <form className="stack" onSubmit={onSubmit}>
          <ErrorAlert error={error} />
          {resentTo && (
            <div className="alert ok" role="status">
              Please confirm your email first. We've sent a new confirmation link to <strong>{resentTo}</strong>.
            </div>
          )}
          <label>
            Email
            <input type="email" name="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input type="password" name="password" autoComplete="current-password" required />
          </label>
          <button className="btn" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>
          <Link href="/forgot-password">Forgot password?</Link> · <Link href="/sign-up">Create an account</Link>
        </p>
      </div>
    </div>
  );
}
