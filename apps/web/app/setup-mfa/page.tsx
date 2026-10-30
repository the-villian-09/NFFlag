"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { authApi } from "@/lib/api";
import { useMe } from "@/lib/use-me";

/**
 * Turn on two-step sign-in. Optional for everyone, with a choice of method.
 * If an admin has set one of the user's roles to require an authenticator
 * app, only that option is shown and it can't be skipped.
 */
export default function SetupMfaPage() {
  const { me, loading } = useMe({ allowIncompleteMfa: true });
  const router = useRouter();
  const [method, setMethod] = useState<"email" | "app" | null>(null);
  const required = me?.mfa.required === "totp";
  const alreadyOn = !!me && me.mfa.enabled && (!required || me.mfa.totpEnrolled);

  useEffect(() => {
    if (alreadyOn) router.replace("/dashboard");
  }, [alreadyOn, router]);

  if (loading || !me || alreadyOn) return <div className="auth-wrap muted">Loading…</div>;
  if (required || method === "app") return <TotpSetup required={required} />;
  if (method === "email") return <EmailSetup email={me.user.email} />;

  return (
    <div className="auth-wrap">
      <div className="card">
        <h1>Two-step sign-in</h1>
        <p>
          Add a second check when you sign in on a new device. It's optional, and you can turn it off later from your
          account.
        </p>
        <div style={{ display: "grid", gap: 12, marginTop: 20 }}>
          <button className="btn" onClick={() => setMethod("email")}>
            Email me a code
          </button>
          <button className="btn ghost" onClick={() => setMethod("app")}>
            Use an authenticator app
          </button>
        </div>
        <p className="muted" style={{ marginTop: 16 }}>
          <Link href="/dashboard">Not now</Link>
        </p>
      </div>
    </div>
  );
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
        <h1>Email codes</h1>
        <p>
          When you sign in on a new device, we'll email a 6-digit code to <strong>{email}</strong>. First, let's make
          sure codes reach you.
        </p>
        {!sent ? (
          <div style={{ display: "grid", gap: 16 }}>
            <ErrorAlert error={error} />
            <button className="btn" onClick={send} disabled={busy}>
              {busy ? "Sending…" : "Send a test code"}
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

function TotpSetup({ required }: { required: boolean }) {
  const router = useRouter();
  const { busy, error, run } = useAction();
  const [setup, setSetup] = useState<{ qr: string; uri: string; backupCodes: string[] } | null>(null);
  const [done, setDone] = useState(false);

  async function start(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    const res = await run(() => authApi.enableTotp(password));
    if (!res) return;
    setSetup({
      uri: res.totpURI,
      backupCodes: res.backupCodes,
      qr: await QRCode.toDataURL(res.totpURI, { margin: 1, width: 220 }),
    });
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
        <h1>Authenticator app</h1>
        <p>
          {required
            ? "The league requires an authenticator app for your role. "
            : ""}
          Use an app such as Google Authenticator, Microsoft Authenticator or 1Password.
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
            <img className="qr" src={setup.qr} alt="QR code for your authenticator app" width={220} height={220} />
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
        {!required && !setup && (
          <p className="muted" style={{ marginTop: 16 }}>
            <Link href="/dashboard">Not now</Link>
          </p>
        )}
      </div>
    </div>
  );
}
