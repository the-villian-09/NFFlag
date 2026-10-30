"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { authApi } from "@/lib/api";
import { useMe } from "@/lib/use-me";

/**
 * First-time two-step sign-in setup.
 *  - Families: confirm an emailed code.
 *  - Staff (any coaching/admin role): authenticator app + backup codes.
 */
export default function SetupMfaPage() {
  const { me, loading } = useMe({ allowIncompleteMfa: true });
  const router = useRouter();

  if (loading || !me) return <div className="auth-wrap muted">Loading…</div>;
  if (me.mfa.complete) {
    router.replace("/dashboard");
    return null;
  }
  return me.mfa.required === "totp" ? <TotpSetup /> : <EmailSetup email={me.user.email} />;
}

function EmailSetup({ email }: { email: string }) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [sent, setSent] = useState(false);

  async function send() {
    if ((await run(() => authApi.sendEmailCode())) !== undefined) setSent(true);
  }
  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    if ((await run(() => authApi.verifyEmailCode(code, true))) !== undefined) router.replace("/dashboard");
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Protect your account</h1>
        <p>
          Your account holds your children's information, so we use two-step sign-in. When you sign in on a new device,
          we'll email a code to <strong>{email}</strong>.
        </p>
        {!sent ? (
          <div style={{ display: "grid", gap: 16 }}>
            <ErrorAlert error={error} />
            <button className="btn" onClick={send} disabled={busy}>
              {busy ? "Sending…" : "Send me a code to turn it on"}
            </button>
          </div>
        ) : (
          <form className="stack" onSubmit={verify}>
            <ErrorAlert error={error} />
            <label>
              6-digit code
              <input className="code" name="code" inputMode="numeric" autoComplete="one-time-code" required autoFocus />
            </label>
            <button className="btn" disabled={busy}>
              {busy ? "Checking…" : "Turn on two-step sign-in"}
            </button>
            <button type="button" className="link-btn" onClick={send} disabled={busy}>
              Send a new code
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function TotpSetup() {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [setup, setSetup] = useState<{ qr: string; uri: string; backupCodes: string[] } | null>(null);
  const [done, setDone] = useState(false);

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    const res = await run(() => authApi.enableTotp(password));
    if (!res) return;
    setSetup({ uri: res.totpURI, backupCodes: res.backupCodes, qr: await QRCode.toDataURL(res.totpURI, { margin: 1, width: 220 }) });
  }
  async function confirm(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    if ((await run(() => authApi.verifyTotp(code))) !== undefined) setDone(true);
  }

  if (done && setup) {
    return (
      <div className="auth-wrap">
        <div className="card">
          <h1>Save your backup codes</h1>
          <p>
            If you lose your phone, each code below lets you sign in once. Store them somewhere safe. They won't be shown
            again.
          </p>
          <div className="codes" aria-label="Backup codes">
            {setup.backupCodes.map((c) => (
              <code key={c}>{c}</code>
            ))}
          </div>
          <button className="btn" style={{ marginTop: 20 }} onClick={() => router.replace("/dashboard")}>
            I've saved them
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Set up your authenticator app</h1>
        <p>
          Staff accounts can see family and player information, so they need an authenticator app such as Google
          Authenticator, Microsoft Authenticator or 1Password.
        </p>
        {!setup ? (
          <form className="stack" onSubmit={start}>
            <ErrorAlert error={error} />
            <label>
              Confirm your password
              <input type="password" name="password" autoComplete="current-password" required />
            </label>
            <button className="btn" disabled={busy}>
              {busy ? "Starting…" : "Continue"}
            </button>
          </form>
        ) : (
          <form className="stack" onSubmit={confirm}>
            <ErrorAlert error={error} />
            <p style={{ margin: 0 }}>Scan this code with your app, then enter the 6-digit code it shows.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={setup.qr} alt="QR code for your authenticator app" width={220} height={220} />
            <details>
              <summary>Can't scan? Enter the key manually</summary>
              <code style={{ wordBreak: "break-all" }}>{new URL(setup.uri).searchParams.get("secret")}</code>
            </details>
            <label>
              6-digit code
              <input className="code" name="code" inputMode="numeric" autoComplete="one-time-code" required />
            </label>
            <button className="btn" disabled={busy}>
              {busy ? "Checking…" : "Confirm"}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
