"use client";

import { useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { useTurnstile } from "@/components/turnstile";
import { authApi } from "@/lib/api";

export default function ForgotPasswordPage() {
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState(false);
  const human = useTurnstile();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email"));
    if ((await run(async () => authApi.requestReset(email, await human.getToken()))) !== undefined) setSent(true);
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Reset password</h1>
        {sent ? (
          <p>If that email has an account, a reset link is on its way. It expires in 1 hour.</p>
        ) : (
          <form className="stack" onSubmit={onSubmit}>
            <ErrorAlert error={error} />
            <label>
              Email
              <input type="email" name="email" autoComplete="email" required />
            </label>
            <button className="btn" disabled={busy}>
              {busy ? "Sending…" : "Send reset link"}
            </button>
            {human.slot}
          </form>
        )}
      </div>
    </div>
  );
}
