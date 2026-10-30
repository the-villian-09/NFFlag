"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ErrorAlert, useAction } from "@/components/form";
import { authApi } from "@/lib/api";

export default function SignInPage() {
  const router = useRouter();
  const { busy, error, run } = useAction();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await run(() => authApi.signIn({ email: String(f.get("email")), password: String(f.get("password")) }));
    if (!res) return;
    // MFA already set up → second step. Otherwise the dashboard sends them to setup.
    router.push(res.twoFactorRedirect ? "/two-factor" : "/dashboard");
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Sign in</h1>
        <form className="stack" onSubmit={onSubmit}>
          <ErrorAlert error={error} />
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
