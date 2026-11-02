"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { PAYOUT_SETUP, REF_STATUS } from "@/lib/referees";
import { useMe } from "@/lib/use-me";
import { SCREENING } from "@/lib/volunteer";

interface App {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string;
  birthDate: string;
  age: number;
  minAge: number;
  meetsMinAge: boolean;
  experience: string | null;
  certification: string;
  certificationExpiresOn: string | null;
  certificationVerified: boolean;
  certificationVerifiedAt: string | null;
  certificationExpired: boolean;
  status: string;
  screeningStatus: "not_started" | "pending" | "cleared" | "not_cleared";
  screeningProvider: string | null;
  screeningCompletedOn: string | null;
  screeningExpiresOn: string | null;
  screeningNotes: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  payoutSetup: string;
  createdAt: string;
}

export default function AdminRefereePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, loading } = useMe();
  const [a, setA] = useState<App | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ application: App }>(`/admin/referees/applications/${id}`)
      .then((r) => setA(r.application))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [id, router]);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const done = (m: string) => (setNotice(m), load());
  const s = a ? REF_STATUS[a.status] ?? { label: a.status, tone: "muted" } : null;
  const ps = a ? PAYOUT_SETUP[a.payoutSetup] ?? { label: a.payoutSetup, tone: "muted" } : null;

  return (
    <main className="page">
      <p>
        <Link href="/admin/referees">← Referees</Link>
      </p>
      <ErrorAlert error={error} />
      {notice && (
        <div className="alert ok" role="status">
          {notice}
        </div>
      )}
      {!a ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
          <h1>{a.name}</h1>
          <p>
            <span className={`status ${s!.tone}`}>{s!.label}</span> <span className={`status ${ps!.tone}`}>Payouts: {ps!.label}</span>
          </p>
          <div className="grid" style={{ marginTop: 16, alignItems: "start" }}>
            <section className="card">
              <h2>Sign-up</h2>
              <dl className="kv">
                <dt>Email</dt>
                <dd>{a.email}</dd>
                <dt>Phone</dt>
                <dd>{a.phone}</dd>
                <dt>Age</dt>
                <dd>
                  {a.age} (born {fmtDate(a.birthDate)})
                  {!a.meetsMinAge && <span className="status bad"> Under {a.minAge}</span>}
                </dd>
                <dt>Signed up</dt>
                <dd>{fmtDateTime(a.createdAt)}</dd>
              </dl>
              {a.experience && (
                <>
                  <h3 style={{ fontSize: 22, color: "#fff", marginTop: 16 }}>Experience</h3>
                  <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{a.experience}</p>
                </>
              )}
            </section>
            <CertificationCard a={a} onSaved={done} />
            <ScreeningCard a={a} onSaved={done} />
          </div>
          <Decision a={a} onDone={done} />
        </>
      )}
    </main>
  );
}

function CertificationCard({ a, onSaved }: { a: App; onSaved: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const expires = String(f.get("expiresOn") ?? "");
    const r = await run(() =>
      api.put(`/admin/referees/applications/${a.id}/certification`, {
        verified: f.get("verified") === "on",
        certification: String(f.get("certification") ?? "").trim(),
        expiresOn: expires || null,
      }),
    );
    if (r !== undefined) {
      setEditing(false);
      onSaved("Certification saved.");
    }
  }
  return (
    <section className="card">
      <h2>Certification</h2>
      <ErrorAlert error={error} />
      {!editing ? (
        <>
          <dl className="kv">
            <dt>Certification</dt>
            <dd>{a.certification}</dd>
            <dt>Expires</dt>
            <dd>
              {fmtDate(a.certificationExpiresOn)}
              {a.certificationExpired && <span className="status bad"> Expired</span>}
            </dd>
            <dt>Verified</dt>
            <dd>{a.certificationVerified ? <span className="status ok">Verified {fmtDate(a.certificationVerifiedAt)}</span> : <span className="status warn">Not yet</span>}</dd>
          </dl>
          <p className="hint">Check the certificate (a photo or the certifying body&apos;s lookup), then mark it verified.</p>
          {a.status !== "withdrawn" && (
            <button className="btn ghost small" onClick={() => setEditing(true)}>
              {a.certificationVerified ? "Update" : "Verify…"}
            </button>
          )}
        </>
      ) : (
        <form className="stack" onSubmit={save}>
          <label>
            Certification
            <input type="text" id="cert-name" name="certification" defaultValue={a.certification} required minLength={2} maxLength={200} />
          </label>
          <label>
            Expires
            <input type="date" id="cert-exp" name="expiresOn" defaultValue={a.certificationExpiresOn ?? ""} />
          </label>
          <label className="check">
            <input type="checkbox" id="cert-verified" name="verified" defaultChecked /> I checked this
            certification and it&apos;s valid
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ScreeningCard({ a, onSaved }: { a: App; onSaved: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  const sc = SCREENING[a.screeningStatus]!;
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "");
    const r = await run(() =>
      api.put(`/admin/referees/applications/${a.id}/screening`, {
        status: v("status"),
        provider: v("provider"),
        completedOn: v("completedOn") || null,
        expiresOn: v("expiresOn") || null,
        notes: v("notes"),
      }),
    );
    if (r !== undefined) {
      setEditing(false);
      onSaved("Background check saved.");
    }
  }
  return (
    <section className="card">
      <h2>Background check</h2>
      <ErrorAlert error={error} />
      {!editing ? (
        <>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <span className={`status ${sc.tone}`}>{sc.label}</span>
            </dd>
            <dt>Provider</dt>
            <dd>{a.screeningProvider ?? "—"}</dd>
            <dt>Completed</dt>
            <dd>{fmtDate(a.screeningCompletedOn)}</dd>
            <dt>Valid until</dt>
            <dd>{fmtDate(a.screeningExpiresOn)}</dd>
            {a.screeningNotes && (
              <>
                <dt>Notes</dt>
                <dd>{a.screeningNotes}</dd>
              </>
            )}
          </dl>
          <p className="hint">The check is done outside this site. Record the result here; approval requires Cleared.</p>
          {a.status !== "withdrawn" && (
            <button className="btn ghost small" onClick={() => setEditing(true)}>
              Update
            </button>
          )}
        </>
      ) : (
        <form className="stack" onSubmit={save}>
          <label>
            Status
            <select id="scr-status" name="status" defaultValue={a.screeningStatus}>
              <option value="not_started">Not started</option>
              <option value="pending">In progress</option>
              <option value="cleared">Cleared</option>
              <option value="not_cleared">Not cleared</option>
            </select>
          </label>
          <label>
            Provider
            <input type="text" id="scr-provider" name="provider" maxLength={120} defaultValue={a.screeningProvider ?? ""} placeholder="e.g. Sterling Volunteers" />
          </label>
          <div className="form-row">
            <label>
              Completed on
              <input type="date" id="scr-done" name="completedOn" defaultValue={a.screeningCompletedOn ?? ""} />
            </label>
            <label>
              Valid until
              <input type="date" id="scr-until" name="expiresOn" defaultValue={a.screeningExpiresOn ?? ""} />
            </label>
          </div>
          <label>
            Notes (no sensitive details)
            <textarea id="scr-notes" name="notes" rows={2} maxLength={1000} defaultValue={a.screeningNotes ?? ""} />
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function Decision({ a, onDone }: { a: App; onDone: (m: string) => void }) {
  const [mode, setMode] = useState<"idle" | "reject" | "revoke">("idle");
  const { busy, error, run } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const missing = [
    a.screeningStatus !== "cleared" || (a.screeningExpiresOn && a.screeningExpiresOn < today) ? "a cleared, current background check" : null,
    !a.certificationVerified || a.certificationExpired ? "a verified, current certification" : null,
    !a.meetsMinAge ? `age ${a.minAge} or older` : null,
  ].filter(Boolean);

  async function approve() {
    if ((await run(() => api.post(`/admin/referees/applications/${a.id}/decision`, { decision: "approved" }))) !== undefined) {
      onDone("Approved. They've been emailed to set up payouts and pick games.");
    }
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get("reason"));
    if (mode === "reject") {
      if ((await run(() => api.post(`/admin/referees/applications/${a.id}/decision`, { decision: "rejected", reason }))) !== undefined) onDone("Not approved; they've been emailed.");
    } else {
      const r = await run(() => api.post<{ gamesRemoved: number }>(`/admin/referees/applications/${a.id}/revoke`, { reason }));
      if (r) onDone(`Approval removed; they were taken off ${r.gamesRemoved} upcoming game${r.gamesRemoved === 1 ? "" : "s"}. Pay already owed is still sent.`);
    }
  }

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2>Decision</h2>
      <ErrorAlert error={error} />
      {a.decidedAt && (
        <p className="muted">
          {fmtDateTime(a.decidedAt)}
          {a.decisionReason ? ` · ${a.decisionReason}` : ""}
        </p>
      )}
      {mode !== "idle" ? (
        <form className="stack" onSubmit={submit}>
          <label>
            {mode === "reject" ? "Reason (emailed to the referee)" : "Why are you removing this approval? (emailed, and kept in the audit log)"}
            <input type="text" id="decision-reason" name="reason" required minLength={3} maxLength={500} />
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn danger" disabled={busy}>
              {busy ? "Working…" : mode === "reject" ? "Don't approve" : "Remove approval"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode("idle")}>
              Back
            </button>
          </div>
        </form>
      ) : a.status === "submitted" ? (
        <>
          {missing.length > 0 && <p className="hint">Approve needs {missing.join(", ")}.</p>}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={approve} disabled={busy || missing.length > 0}>
              Approve
            </button>
            <button className="btn ghost" onClick={() => setMode("reject")}>
              Don&apos;t approve…
            </button>
          </div>
        </>
      ) : a.status === "approved" ? (
        <button className="btn ghost" onClick={() => setMode("revoke")}>
          Remove approval…
        </button>
      ) : null}
    </section>
  );
}
