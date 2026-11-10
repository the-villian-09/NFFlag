"use client";

import Link from "next/link";
import { useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { useTurnstile } from "@/components/turnstile";
import { authApi } from "@/lib/api";

export default function SignUpPage() {
  const { busy, error, run } = useAction();
  const resend = useAction();
  const human = useTurnstile();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const ok = await run(async () =>
      authApi.signUp(
        {
          name: String(f.get("name")),
          email,
          password: String(f.get("password")),
        },
        await human.getToken(),
      ),
    );
    if (ok !== undefined) setSentTo(email);
  }

  async function onResend() {
    if (!sentTo) return;
    setResent(false);
    const ok = await resend.run(async () => authApi.resendConfirmation(sentTo, await human.getToken()));
    if (ok !== undefined) setResent(true);
  }

  if (sentTo) {
    return (
      <div className="auth-wrap">
        <div className="card">
          <h1>Check your email</h1>
          <p>
            We sent a confirmation link to <strong>{sentTo}</strong>. Click it to finish creating your account. The link
            works for 24 hours.
          </p>
          <ErrorAlert error={resend.error} />
          {resent && (
            <div className="alert ok" role="status">
              A new link is on its way.
            </div>
          )}
          <p className="muted">Didn't get it? Check spam, or send a new link.</p>
          <button type="button" className="btn ghost" onClick={onResend} disabled={resend.busy}>
            {resend.busy ? "Sending…" : "Send a new link"}
          </button>
          {human.slot}
        </div>
      </div>
    );
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
          {human.slot}
        </form>
        <p className="muted" style={{ marginTop: 16 }}>
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
