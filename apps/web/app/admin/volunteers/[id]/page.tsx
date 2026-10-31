"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { useMe } from "@/lib/use-me";
import { APP_STATUS, SCREENING } from "@/lib/volunteer";

interface Detail {
  application: {
    id: string;
    roleLabel: string;
    status: string;
    phone: string;
    experience: string | null;
    notes: string | null;
    shirtSize: string | null;
    agreements: { title: string; signerName: string; acceptedAt: string; version: string }[];
    totalCents: number;
    paidAt: string | null;
    screeningStatus: "not_started" | "pending" | "cleared" | "not_cleared";
    screeningProvider: string | null;
    screeningCompletedOn: string | null;
    screeningExpiresOn: string | null;
    screeningNotes: string | null;
    screeningUpdatedAt: string | null;
    decisionReason: string | null;
    decidedAt: string | null;
    createdAt: string;
  };
  applicant: { name: string; email: string };
  household: { displayName: string; phone: string | null } | null;
  division: { name: string } | null;
  player: { firstName: string; lastName: string } | null;
  season: { name: string } | null;
  payments: { id: string; amountCents: number; refundedCents: number; status: string; cardBrand: string | null; cardLast4: string | null; providerEnvironment: string; receiptUrl: string | null }[];
  refunds: { id: string; amountCents: number; status: string; reason: string; createdAt: string }[];
}

export default function AdminVolunteerPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, loading } = useMe();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Detail>(`/admin/staff/applications/${id}`)
      .then(setD)
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
  const a = d?.application;
  const s = a ? APP_STATUS[a.status] ?? { label: a.status, tone: "muted" } : null;

  return (
    <main className="page">
      <p>
        <Link href="/admin/volunteers">← Volunteers</Link>
      </p>
      <ErrorAlert error={error} />
      {notice && (
        <div className="alert ok" role="status">
          {notice}
        </div>
      )}
      {!d || !a ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
          <h1>{d.applicant.name}</h1>
          <p>
            <span className={`status ${s!.tone}`}>{s!.label}</span> <span className="muted">· {a.roleLabel} · {d.season?.name}</span>
          </p>
          <div className="grid" style={{ marginTop: 16 }}>
            <section className="card">
              <h2>Application</h2>
              <dl className="kv">
                <dt>Email</dt>
                <dd>
                  <a href={`mailto:${d.applicant.email}`}>{d.applicant.email}</a>
                </dd>
                <dt>Phone</dt>
                <dd>{a.phone}</dd>
                <dt>Division</dt>
                <dd>{d.division?.name ?? "No preference"}</dd>
                <dt>Child's team</dt>
                <dd>{d.player ? `${d.player.firstName} ${d.player.lastName}` : "—"}</dd>
                <dt>Shirt</dt>
                <dd>{a.shirtSize ?? "—"}</dd>
                <dt>Family</dt>
                <dd>{d.household ? d.household.displayName : "—"}</dd>
                <dt>Applied</dt>
                <dd>{fmtDateTime(a.createdAt)}</dd>
              </dl>
              {a.experience && (
                <>
                  <h3 style={{ fontSize: 22, color: "#fff", marginTop: 16 }}>Experience</h3>
                  <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{a.experience}</p>
                </>
              )}
              {a.notes && (
                <>
                  <h3 style={{ fontSize: 22, color: "#fff", marginTop: 16 }}>Notes</h3>
                  <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{a.notes}</p>
                </>
              )}
              {a.agreements.map((g) => (
                <p key={g.title} className="hint" style={{ marginTop: 12 }}>
                  Signed “{g.signerName}” · {g.title} · {fmtDateTime(g.acceptedAt)}
                </p>
              ))}
            </section>
            <ScreeningCard detail={d} canEdit={a.status !== "withdrawn"} onSaved={(m) => (setNotice(m), load())} />
            <section className="card">
              <h2>Fee</h2>
              {a.totalCents === 0 ? (
                <p className="muted">No fee for this role.</p>
              ) : d.payments.length === 0 ? (
                <p className="muted">Not paid yet ({money(a.totalCents)}).</p>
              ) : (
                d.payments.map((p) => (
                  <p key={p.id} className="muted">
                    {p.cardBrand ?? "Card"} •••• {p.cardLast4 ?? "????"} · {money(p.amountCents)} · {p.status}
                    {p.refundedCents ? ` · ${money(p.refundedCents)} refunded` : ""}
                    {p.providerEnvironment === "sandbox" ? " · TEST" : ""}
                  </p>
                ))
              )}
              {d.refunds.map((r) => (
                <p key={r.id} className="hint">
                  Refund {money(r.amountCents)} · {r.status} · {r.reason}
                </p>
              ))}
            </section>
          </div>
          <Decision detail={d} can={(p) => me.permissions.includes(p)} onDone={(m) => (setNotice(m), load())} />
        </>
      )}
    </main>
  );
}

function ScreeningCard({ detail, canEdit, onSaved }: { detail: Detail; canEdit: boolean; onSaved: (msg: string) => void }) {
  const a = detail.application;
  const [editing, setEditing] = useState(false);
  const { busy, error, run } = useAction();
  const sc = SCREENING[a.screeningStatus];
  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "");
    const res = await run(() =>
      api.put(`/admin/staff/applications/${a.id}/screening`, {
        status: v("status"),
        provider: v("provider"),
        completedOn: v("completedOn"),
        expiresOn: v("expiresOn"),
        notes: v("notes"),
      }),
    );
    if (res !== undefined) {
      setEditing(false);
      onSaved("Background check saved.");
    }
  }
  return (
    <section className="card">
      <h2>Background check</h2>
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
          <p className="hint">The check itself is done outside this app. Record the result here; approval requires “Cleared”.</p>
          {canEdit && (
            <button className="btn ghost small" onClick={() => setEditing(true)}>
              Update
            </button>
          )}
        </>
      ) : (
        <form className="stack" onSubmit={save}>
          <ErrorAlert error={error} />
          <label>
            Status
            <select name="status" defaultValue={a.screeningStatus}>
              <option value="not_started">Not started</option>
              <option value="pending">In progress</option>
              <option value="cleared">Cleared</option>
              <option value="not_cleared">Not cleared</option>
            </select>
          </label>
          <label>
            Provider
            <input type="text" name="provider" maxLength={120} defaultValue={a.screeningProvider ?? ""} placeholder="e.g. Sterling Volunteers" />
          </label>
          <div className="form-row">
            <label>
              Completed on
              <input type="date" name="completedOn" defaultValue={a.screeningCompletedOn ?? ""} />
            </label>
            <label>
              Valid until
              <input type="date" name="expiresOn" defaultValue={a.screeningExpiresOn ?? ""} />
            </label>
          </div>
          <label>
            Notes (no sensitive details)
            <textarea name="notes" rows={2} maxLength={1000} defaultValue={a.screeningNotes ?? ""} />
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

function Decision({ detail, can, onDone }: { detail: Detail; can: (p: string) => boolean; onDone: (msg: string) => void }) {
  const a = detail.application;
  const [rejecting, setRejecting] = useState(false);
  const { busy, error, run } = useAction();
  const paid = detail.payments.find((p) => p.status === "COMPLETED" || p.status === "APPROVED");
  const refundable = paid ? paid.amountCents - paid.refundedCents : 0;
  if (a.status !== "submitted") {
    return (
      <AfterDecision
        detail={detail}
        refundable={refundable}
        canRefund={can("refunds.issue")}
        onDone={onDone}
      />
    );
  }
  const cleared = a.screeningStatus === "cleared" && (!a.screeningExpiresOn || a.screeningExpiresOn >= new Date().toISOString().slice(0, 10));
  async function approve() {
    if ((await run(() => api.post(`/admin/staff/applications/${a.id}/decision`, { decision: "approved" }))) !== undefined) onDone("Approved. The volunteer has their role for this season and has been emailed.");
  }
  async function reject(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const refund = f.get("refund") === "on";
    const r = await run(() => api.post(`/admin/staff/applications/${a.id}/decision`, { decision: "rejected", reason: String(f.get("reason")), refund }));
    if (r !== undefined) onDone(refund ? "Not approved; the fee was refunded and the volunteer emailed." : "Not approved; the volunteer was emailed.");
  }
  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2>Decision</h2>
      <ErrorAlert error={error} />
      {!rejecting ? (
        <>
          {!cleared && <p className="hint">Approve becomes available once the background check is marked Cleared and current.</p>}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn" onClick={approve} disabled={busy || !cleared}>
              Approve
            </button>
            <button className="btn ghost" onClick={() => setRejecting(true)}>
              Don't approve…
            </button>
          </div>
        </>
      ) : (
        <form className="stack" onSubmit={reject}>
          <label>
            Reason (emailed to the volunteer)
            <input type="text" name="reason" required minLength={3} maxLength={500} />
          </label>
          {refundable > 0 && can("refunds.issue") && (
            <label className="check">
              <input type="checkbox" name="refund" defaultChecked /> Refund the {money(refundable)} fee
            </label>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn danger" disabled={busy}>
              {busy ? "Working…" : "Confirm"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setRejecting(false)}>
              Back
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** After a decision: remove an approval, or refund money still held (e.g. a refund that failed earlier). */
function AfterDecision({ detail, refundable, canRefund, onDone }: { detail: Detail; refundable: number; canRefund: boolean; onDone: (msg: string) => void }) {
  const a = detail.application;
  const [revoking, setRevoking] = useState(false);
  const { busy, error, run } = useAction();
  async function revoke(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get("reason"));
    if ((await run(() => api.post(`/admin/staff/applications/${a.id}/revoke`, { reason }))) !== undefined) onDone("Approval removed; their role for this season is gone.");
  }
  async function refundRest() {
    const r = await run(() => api.post(`/admin/staff/applications/${a.id}/refund`, { reason: "Refund of volunteer fee" }));
    if (r !== undefined) onDone("Refund issued.");
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
      {a.status === "approved" &&
        (revoking ? (
          <form className="stack" onSubmit={revoke}>
            <label>
              Why are you removing this approval? (kept in the audit log)
              <input type="text" name="reason" required minLength={3} maxLength={500} />
            </label>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button className="btn danger" disabled={busy}>
                {busy ? "Working…" : "Remove approval"}
              </button>
              <button type="button" className="btn ghost" onClick={() => setRevoking(false)}>
                Back
              </button>
            </div>
          </form>
        ) : (
          <button className="btn ghost" onClick={() => setRevoking(true)}>
            Remove approval…
          </button>
        ))}
      {a.status !== "approved" && refundable > 0 && canRefund && (
        <>
          <p className="hint">{money(refundable)} of this volunteer's fee hasn't been refunded yet.</p>
          <button className="btn" onClick={refundRest} disabled={busy}>
            Refund {money(refundable)}
          </button>
        </>
      )}
    </section>
  );
}
