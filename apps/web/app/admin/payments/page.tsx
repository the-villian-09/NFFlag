"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDateTime, money } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Settings {
  feeMode: "league" | "parent";
  feePercentBps: number;
  feeFixedCents: number;
  holdMinutes: number;
  offerHours: number;
  volunteerFees: { head_coach: number; assistant_coach: number; team_manager: number };
}
interface Status {
  settings: Settings;
  square: {
    environment: "sandbox" | "production";
    oauthConfigured: boolean;
    webhookConfigured: boolean;
    redirectUrl: string;
    webhookUrl: string;
    connection: {
      merchantId: string;
      merchantName: string | null;
      locationName: string | null;
      connectedAt: string;
      connectedByName: string | null;
      accessTokenExpiresAt: string | null;
      lastRefreshError: string | null;
    } | null;
    active: { source: "oauth" | "sandbox_token"; locationId: string } | null;
  };
}

const RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Square is connected. Families can now pay online." },
  cancelled: { ok: false, text: "Connecting Square was cancelled on Square's page." },
  expired: { ok: false, text: "That connect link expired or was opened by a different account. Please try again." },
  no_location: { ok: false, text: "That Square account has no active location that can take card payments." },
  error: { ok: false, text: "Square couldn't be connected. Please try again." },
};

function Payments() {
  const router = useRouter();
  const result = useSearchParams().get("square");
  const { me, loading } = useMe();
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Status>("/admin/payments")
      .then(setS)
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load payment settings.");
      });
  }, [router]);

  useEffect(() => {
    if (me) load();
  }, [me, load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const canManage = me.permissions.includes("platform.settings.manage");
  const banner = result ? RESULT[result] : null;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Payments</h1>
      {banner && <div className={`alert ${banner.ok ? "ok" : "error"}`}>{banner.text}</div>}
      <ErrorAlert error={error} />
      {!s ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
          <div className="grid" style={{ marginTop: 16 }}>
            <SquareCard status={s} canManage={canManage} onChanged={load} />
            <FeeCard initial={s.settings} canManage={canManage} />
          </div>
          {canManage && (
            <section className="card" style={{ marginTop: 24 }}>
              <h2>Square app setup</h2>
              <p className="muted">For the developer. These must match the Square Developer Dashboard.</p>
              <dl className="kv">
                <dt>Environment</dt>
                <dd>{s.square.environment === "sandbox" ? "Sandbox (test payments)" : "Production (real payments)"}</dd>
                <dt>OAuth redirect URL</dt>
                <dd>
                  <code>{s.square.redirectUrl}</code>
                </dd>
                <dt>Webhook URL</dt>
                <dd>
                  <code>{s.square.webhookUrl}</code>
                </dd>
                <dt>Webhook events</dt>
                <dd>payment.created, payment.updated, refund.created, refund.updated, oauth.authorization.revoked</dd>
                <dt>App secret on server</dt>
                <dd>{s.square.oauthConfigured ? "Set" : "Missing"}</dd>
                <dt>Webhook key on server</dt>
                <dd>{s.square.webhookConfigured ? "Set" : "Missing"}</dd>
              </dl>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function SquareCard({ status, canManage, onChanged }: { status: Status; canManage: boolean; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [reason, setReason] = useState("");
  const conn = status.square.connection;
  const active = status.square.active;

  async function connect() {
    const r = await run(() => api.post<{ url: string }>("/admin/payments/square/connect"));
    if (r) window.location.href = r.url;
  }

  async function disconnect(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(() => api.post<{ revokedAtSquare: boolean }>("/admin/payments/square/disconnect", { confirm: typed, reason: reason || undefined }));
    if (r) {
      setConfirming(false);
      setTyped("");
      onChanged();
    }
  }

  return (
    <section className="card">
      <h2>Square account</h2>
      <ErrorAlert error={error} />
      {conn ? (
        <>
          <p>
            <span className="status ok">Connected</span>
            {status.square.environment === "sandbox" && <span className="status warn" style={{ marginLeft: 8 }}>Test mode</span>}
          </p>
          <dl className="kv">
            <dt>Account</dt>
            <dd>{conn.merchantName ?? conn.merchantId}</dd>
            <dt>Location</dt>
            <dd>{conn.locationName ?? "—"}</dd>
            <dt>Connected</dt>
            <dd>
              {fmtDateTime(conn.connectedAt)}
              {conn.connectedByName ? ` by ${conn.connectedByName}` : ""}
            </dd>
          </dl>
          {conn.lastRefreshError && <div className="alert error" style={{ marginTop: 12 }}>Square access renewal failed: {conn.lastRefreshError}. Reconnect Square if payments stop working.</div>}
        </>
      ) : active?.source === "sandbox_token" ? (
        <>
          <p>
            <span className="status warn">Test mode</span>
          </p>
          <p className="muted">Using the developer's Square Sandbox account. Payments are simulated; no money moves.</p>
        </>
      ) : (
        <>
          <p>
            <span className="status bad">Not connected</span>
          </p>
          <p className="muted">Families can't pay online until a Super Admin connects the league's Square account.</p>
        </>
      )}

      {canManage && !confirming && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
          {!conn && (
            <button className="btn" onClick={connect} disabled={busy || !status.square.oauthConfigured}>
              {busy ? "Opening Square…" : "Connect Square"}
            </button>
          )}
          {conn && (
            <button className="btn ghost" onClick={() => setConfirming(true)}>
              Disconnect Square…
            </button>
          )}
        </div>
      )}
      {canManage && !conn && (
        <p className="hint">
          {status.square.oauthConfigured
            ? "You'll sign in to Square and approve access. Use the league's Square account owner login."
            : "Connecting needs the Square app secret on the server first (developer setup: infra/set-square.sh)."}
        </p>
      )}
      {confirming && (
        <form className="stack" onSubmit={disconnect}>
          <div className="alert error">
            Online payments stop immediately. Families mid-checkout won't be able to pay, and refunds can't be issued from here until Square is
            reconnected. All Super Admins will be emailed.
          </div>
          <label>
            Reason (optional)
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
          </label>
          <label>
            Type DISCONNECT to confirm
            <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn danger" disabled={busy || typed !== "DISCONNECT"}>
              {busy ? "Disconnecting…" : "Disconnect Square"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function FeeCard({ initial, canManage }: { initial: Settings; canManage: boolean }) {
  const [v, setV] = useState(initial);
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const sample = 10000;
  const total = v.feeMode === "parent" ? Math.ceil((sample + v.feeFixedCents) / (1 - v.feePercentBps / 10000)) : sample;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    if ((await run(() => api.put("/admin/league/payment-settings", v))) !== undefined) setSaved(true);
  }

  return (
    <section className="card">
      <h2>Checkout settings</h2>
      <form className="stack" onSubmit={save}>
        <ErrorAlert error={error} />
        {saved && <div className="alert ok">Saved. New registrations use this right away.</div>}
        <div className="toggle-row" role="radiogroup" aria-label="Who pays the card fee">
          <button
            type="button"
            className="choice"
            aria-pressed={v.feeMode === "league"}
            disabled={!canManage}
            onClick={() => setV({ ...v, feeMode: "league" })}
          >
            <strong>League pays</strong>
            <span className="muted">Families pay the division price. Square's fee comes out of what the league receives.</span>
          </button>
          <button
            type="button"
            className="choice"
            aria-pressed={v.feeMode === "parent"}
            disabled={!canManage}
            onClick={() => setV({ ...v, feeMode: "parent" })}
          >
            <strong>Parent pays</strong>
            <span className="muted">A processing fee is added at checkout so the league receives the full price.</span>
          </button>
        </div>
        <div className="form-row">
          <label>
            Square rate (%)
            <input
              type="number"
              step="0.01"
              min={0}
              max={10}
              value={v.feePercentBps / 100}
              disabled={!canManage}
              onChange={(e) => setV({ ...v, feePercentBps: Math.round(Number(e.target.value) * 100) })}
            />
          </label>
          <label>
            Plus per payment (¢)
            <input type="number" min={0} max={500} value={v.feeFixedCents} disabled={!canManage} onChange={(e) => setV({ ...v, feeFixedCents: Number(e.target.value) })} />
          </label>
          <label>
            Coaching badge fee: Head Coach ($)
            <input type="number" min={0} step="0.01" value={(v.volunteerFees?.head_coach ?? 2500) / 100} disabled={!canManage} onChange={(e) => setV({ ...v, volunteerFees: { ...v.volunteerFees, head_coach: Math.round(Number(e.target.value) * 100) } })} />
          </label>
          <label>
            Coaching badge fee: Assistant Coach ($)
            <input type="number" min={0} step="0.01" value={(v.volunteerFees?.assistant_coach ?? 2500) / 100} disabled={!canManage} onChange={(e) => setV({ ...v, volunteerFees: { ...v.volunteerFees, assistant_coach: Math.round(Number(e.target.value) * 100) } })} />
          </label>
          <label>
            Team mom fee ($)
            <input type="number" min={0} step="0.01" value={(v.volunteerFees?.team_manager ?? 2500) / 100} disabled={!canManage} onChange={(e) => setV({ ...v, volunteerFees: { ...v.volunteerFees, team_manager: Math.round(Number(e.target.value) * 100) } })} />
          </label>
          <label>
            Waitlist offer lasts (hours)
            <input type="number" min={1} max={168} value={v.offerHours ?? 48} disabled={!canManage} onChange={(e) => setV({ ...v, offerHours: Number(e.target.value) })} />
          </label>
          <label>
            Hold a spot for (minutes)
            <input type="number" min={5} max={120} value={v.holdMinutes} disabled={!canManage} onChange={(e) => setV({ ...v, holdMinutes: Number(e.target.value) })} />
          </label>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Example, {money(sample)} division: family pays <strong>{money(total)}</strong>
          {v.feeMode === "parent" ? ` (includes ${money(total - sample)} fee)` : ""}. Check the rate against the league's Square pricing.
        </p>
        {canManage && (
          <button className="btn" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        )}
      </form>
    </section>
  );
}

export default function AdminPaymentsPage() {
  return (
    <Suspense fallback={<main className="page muted">Loading…</main>}>
      <Payments />
    </Suspense>
  );
}
