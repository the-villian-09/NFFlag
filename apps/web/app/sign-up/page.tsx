"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ErrorAlert, useAction } from "@/components/form";
import { authApi } from "@/lib/api";

export default function SignUpPage() {
  const router = useRouter();
  const { busy, error, run } = useAction();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const ok = await run(() =>
      authApi.signUp({
        name: String(f.get("name")),
        email: String(f.get("email")),
        password: String(f.get("password")),
      }),
    );
    // Signed in immediately; no email confirmation step.
    if (ok !== undefined) router.push("/dashboard");
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Create your account</h1>
        <p className="muted">One account per family. You'll add your children when registration opens.</p>
        <form className="stack" onSubmit={onSubmit}>
          <ErrorAlert error={error} />
          <label>
            Parent / guardian name
            <input type="text" name="name" autoComplete="name" required maxLength={120} />
          </label>
          <label>
            Email
            <input type="email" name="email" autoComplete="email" required />
          </label>
          <label>
            Password
            <input type="password" name="password" autoComplete="new-password" minLength={10} required />
            <span className="muted" style={{ fontWeight: 400 }}>
              At least 10 characters.
            </span>
          </label>
          <button className="btn" disabled={busy}>
            {busy ? "Creating account…" : "Create account"}
          </button>
        </form>
        <p className="muted" style={{ marginTop: 16 }}>
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
