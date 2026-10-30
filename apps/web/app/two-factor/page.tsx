"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { authApi } from "@/lib/api";

type Method = "email" | "app" | "backup";

/** Second sign-in step: emailed code (families), authenticator app (staff) or a backup code. */
export default function TwoFactorPage() {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [method, setMethod] = useState<Method>("email");
  const [codeSent, setCodeSent] = useState(false);

  async function sendCode() {
    const ok = await run(() => authApi.sendEmailCode());
    if (ok !== undefined) setCodeSent(true);
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const code = String(f.get("code")).trim();
    const trust = f.get("trust") === "on";
    const ok = await run(() =>
      method === "email"
        ? authApi.verifyEmailCode(code, trust)
        : method === "app"
          ? authApi.verifyTotp(code)
          : authApi.verifyBackupCode(code),
    );
    if (ok !== undefined) router.push("/dashboard");
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Confirm it's you</h1>
        <div className="tabs" role="tablist">
          <button className="btn ghost" role="tab" aria-selected={method === "email"} onClick={() => setMethod("email")}>
            Email code
          </button>
          <button className="btn ghost" role="tab" aria-selected={method === "app"} onClick={() => setMethod("app")}>
            Authenticator app
          </button>
        </div>

        {method === "email" && !codeSent ? (
          <div className="stack" style={{ display: "grid", gap: 16, marginTop: 20 }}>
            <ErrorAlert error={error} />
            <p>We'll email a 6-digit code to the address on your account.</p>
            <button className="btn" onClick={sendCode} disabled={busy}>
              {busy ? "Sending…" : "Email me a code"}
            </button>
          </div>
        ) : (
          <form className="stack" onSubmit={onSubmit}>
            <ErrorAlert error={error} />
            <p className="muted" style={{ margin: 0 }}>
              {method === "email"
                ? "Enter the code we emailed you. It expires in 10 minutes."
                : method === "app"
                  ? "League staff: enter the 6-digit code from your authenticator app."
                  : "Enter one of your saved backup codes. Each works once."}
            </p>
            <label>
              Code
              <input
                className="code"
                name="code"
                inputMode={method === "backup" ? "text" : "numeric"}
                autoComplete="one-time-code"
                required
                autoFocus
              />
            </label>
            {method === "email" && (
              <label className="check">
                <input type="checkbox" name="trust" defaultChecked /> Trust this device for 30 days
              </label>
            )}
            <button className="btn" disabled={busy}>
              {busy ? "Checking…" : "Continue"}
            </button>
            {method === "email" && (
              <button type="button" className="link-btn" onClick={sendCode} disabled={busy}>
                Send a new code
              </button>
            )}
          </form>
        )}
        {method !== "backup" && (
          <p className="muted" style={{ marginTop: 16 }}>
            <button className="link-btn" onClick={() => setMethod("backup")}>
              Use a backup code
            </button>
          </p>
        )}
      </div>
    </div>
  );
}
