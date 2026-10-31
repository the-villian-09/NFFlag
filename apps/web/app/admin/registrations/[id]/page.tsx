"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime, GENDER_POLICY, money, StatusBadge } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Detail {
  registration: {
    id: string;
    status: string;
    priceCents: number;
    feeCents: number;
    totalCents: number;
    waivers: { slug: string; title: string; version: string; signerName: string; acceptedAt: string }[];
    decision: string | null;
    decisionReason: string | null;
    decidedAt: string | null;
    paidAt: string | null;
    paymentError: string | null;
    createdAt: string;
  };
  team: { entryId: string; teamId: string; name: string; source: string } | null;
  player: { firstName: string; lastName: string; preferredName: string | null; birthDate: string; gender: string; shirtSize: string | null; school: string | null; grade: string | null };
  division: { name: string; genderPolicy: string; birthDateFrom: string | null; birthDateTo: string | null };
  season: { name: string } | null;
  household: { displayName: string; phone: string | null };
  guardians: { name: string; email: string; memberRole: string }[];
  payments: { id: string; providerPaymentId: string; providerEnvironment: string; status: string; amountCents: number; refundedCents: number; cardBrand: string | null; cardLast4: string | null; receiptUrl: string | null; createdAt: string }[];
  refunds: { id: string; amountCents: number; status: string; reason: string; createdAt: string }[];
  medical: Record<string, string | null> | null;
  canSeeMedical: boolean;
}

const MEDICAL_LABELS: [string, string][] = [
  ["allergies", "Allergies"],
  ["medicalConditions", "Conditions"],
  ["medications", "Medications"],
  ["medicalInstructions", "Instructions"],
  ["physicianName", "Doctor"],
  ["physicianPhone", "Doctor's phone"],
  ["emergencyContactName", "Emergency contact"],
  ["emergencyContactPhone", "Emergency phone"],
  ["emergencyContactRelationship", "Relationship"],
];

export default function AdminRegistrationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { me, loading } = useMe();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Detail>(`/admin/league/registrations/${id}`)
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
  const can = (p: string) => me.permissions.includes(p);
  const paid = d?.payments.find((p) => p.status === "COMPLETED" || p.status === "APPROVED");
  const refundable = paid ? paid.amountCents - paid.refundedCents : 0;

  return (
    <main className="page">
      <p>
        <Link href="/admin/registrations">← Registrations</Link>
      </p>
      <ErrorAlert error={error} />
      {notice && (
        <div className="alert ok" role="status">
          {notice}
        </div>
      )}
      {!d ? (
        !error && <p className="muted">Loading…</p>
      ) : (
        <>
          <h1>
            {d.player.firstName} {d.player.lastName}
          </h1>
          <p>
            <StatusBadge status={d.registration.status} /> <span className="muted">· {d.division.name} · {d.season?.name}</span>
          </p>

          <div className="grid" style={{ marginTop: 16 }}>
            <section className="card">
              <h2>Player</h2>
              <dl className="kv">
                <dt>Born</dt>
                <dd>{fmtDate(d.player.birthDate)}</dd>
                <dt>Plays in</dt>
                <dd>{d.player.gender === "girl" ? "Girls" : "Boys"} divisions</dd>
                {d.player.preferredName && (
                  <>
                    <dt>Goes by</dt>
                    <dd>{d.player.preferredName}</dd>
                  </>
                )}
                <dt>Shirt</dt>
                <dd>{d.player.shirtSize ?? "—"}</dd>
                <dt>School / grade</dt>
                <dd>
                  {d.player.school ?? "—"} {d.player.grade ? `· ${d.player.grade}` : ""}
                </dd>
              </dl>
              {d.team && (
                <TeamLine
                  team={d.team}
                  canRemove={!!me?.permissions.includes("teams.manage")}
                  onRemoved={() => {
                    setNotice(`Removed from ${d.team!.name}.`);
                    load();
                  }}
                />
              )}
              <h3 style={{ fontSize: 24, color: "#fff", marginTop: 16 }}>Division rules</h3>
              <p className="muted" style={{ margin: 0 }}>
                {GENDER_POLICY[d.division.genderPolicy]} · born {d.division.birthDateFrom ? fmtDate(d.division.birthDateFrom) : "any time"} –{" "}
                {d.division.birthDateTo ? fmtDate(d.division.birthDateTo) : "any time"}
              </p>
            </section>

            <section className="card">
              <h2>Family</h2>
              <dl className="kv">
                <dt>Family</dt>
                <dd>{d.household.displayName}</dd>
                <dt>Phone</dt>
                <dd>{d.household.phone ?? "—"}</dd>
                {d.guardians.map((g) => (
                  <Fragment key={g.email}>
                    <dt>{g.memberRole === "primary" ? "Guardian" : "Other guardian"}</dt>
                    <dd>
                      {g.name} · <a href={`mailto:${g.email}`}>{g.email}</a>
                    </dd>
                  </Fragment>
                ))}
              </dl>
            </section>

            <section className="card">
              <h2>Medical</h2>
              {!d.canSeeMedical ? (
                <p className="muted">You don't have access to medical details.</p>
              ) : !d.medical ? (
                <p className="muted">None provided.</p>
              ) : (
                <dl className="kv">
                  {MEDICAL_LABELS.map(([k, label]) => (
                    <Fragment key={k}>
                      <dt>{label}</dt>
                      <dd>{d.medical![k] || "—"}</dd>
                    </Fragment>
                  ))}
                </dl>
              )}
              {d.canSeeMedical && <p className="hint">Viewing medical details is recorded in the audit log.</p>}
            </section>
          </div>

          <div className="grid" style={{ marginTop: 24 }}>
            <section className="card">
              <h2>Payment</h2>
              <dl className="kv">
                <dt>Division price</dt>
                <dd>{money(d.registration.priceCents)}</dd>
                {d.registration.feeCents > 0 && (
                  <>
                    <dt>Processing fee</dt>
                    <dd>{money(d.registration.feeCents)}</dd>
                  </>
                )}
                <dt>Total</dt>
                <dd>{money(d.registration.totalCents)}</dd>
                <dt>Paid</dt>
                <dd>{fmtDateTime(d.registration.paidAt)}</dd>
                {d.registration.paymentError && (
                  <>
                    <dt>Last error</dt>
                    <dd>{d.registration.paymentError}</dd>
                  </>
                )}
              </dl>
              {d.payments.map((p) => (
                <p key={p.id} className="muted">
                  {p.cardBrand ?? "Card"} •••• {p.cardLast4 ?? "????"} · {money(p.amountCents)} · {p.status}
                  {p.refundedCents ? ` · ${money(p.refundedCents)} refunded` : ""}
                  {p.providerEnvironment === "sandbox" ? " · TEST" : ""}
                  {p.receiptUrl && (
                    <>
                      {" "}
                      ·{" "}
                      <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer">
                        receipt
                      </a>
                    </>
                  )}
                </p>
              ))}
              {d.refunds.length > 0 && (
                <>
                  <h3 style={{ fontSize: 24, color: "#fff" }}>Refunds</h3>
                  <ul>
                    {d.refunds.map((r) => (
                      <li key={r.id}>
                        {money(r.amountCents)} · {r.status} · {r.reason} · {fmtDateTime(r.createdAt)}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>

            <section className="card">
              <h2>Waivers</h2>
              {d.registration.waivers.length === 0 ? (
                <p className="muted">None recorded.</p>
              ) : (
                <ul>
                  {d.registration.waivers.map((w) => (
                    <li key={w.slug}>
                      {w.title} — signed “{w.signerName}” {fmtDateTime(w.acceptedAt)}
                      <br />
                      <span className="hint">Version of {fmtDateTime(w.version)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <Actions
            detail={d}
            refundable={refundable}
            can={can}
            onDone={(msg) => {
              setNotice(msg);
              load();
            }}
          />
        </>
      )}
    </main>
  );
}

function Actions({ detail, refundable, can, onDone }: { detail: Detail; refundable: number; can: (p: string) => boolean; onDone: (msg: string) => void }) {
  const status = detail.registration.status;
  const id = detail.registration.id;
  const [mode, setMode] = useState<"reject" | "refund" | "cancel" | null>(null);
  const { busy, error, run } = useAction();

  async function approve() {
    if ((await run(() => api.post(`/admin/league/registrations/${id}/decision`, { decision: "approved" }))) !== undefined) {
      onDone("Approved. The family has been emailed.");
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const reason = String(f.get("reason") ?? "");
    const refund = f.get("refund") === "on";
    if (mode === "reject") {
      const r = await run(() => api.post(`/admin/league/registrations/${id}/decision`, { decision: "rejected", reason, refund }));
      if (r !== undefined) onDone(refund ? "Rejected and refunded. The family has been emailed." : "Rejected. The family has been emailed.");
    } else if (mode === "refund") {
      const amount = Math.round(Number(f.get("amount")) * 100);
      const r = await run(() => api.post(`/admin/league/registrations/${id}/refund`, { reason, amountCents: amount }));
      if (r !== undefined) onDone("Refund issued.");
    } else if (mode === "cancel") {
      const r = await run(() => api.post(`/admin/league/registrations/${id}/cancel`, { reason, refund }));
      if (r !== undefined) onDone(refund ? "Cancelled and refunded." : "Cancelled.");
    }
    setMode(null);
  }

  const canDecide = can("eligibility.decide") && (status === "paid" || status === "approved");
  const canRefund = can("refunds.issue") && refundable > 0;
  const canCancel = can("registrations.manage") && !["cancelled"].includes(status);
  if (!canDecide && !canRefund && !canCancel) return null;

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <h2>Actions</h2>
      <ErrorAlert error={error} />
      {!mode && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          {canDecide && status === "paid" && (
            <button className="btn" onClick={approve} disabled={busy}>
              Approve
            </button>
          )}
          {canDecide && (
            <button className="btn ghost" onClick={() => setMode("reject")}>
              Reject…
            </button>
          )}
          {canRefund && (
            <button className="btn ghost" onClick={() => setMode("refund")}>
              Refund…
            </button>
          )}
          {canCancel && (
            <button className="btn ghost" onClick={() => setMode("cancel")}>
              Cancel registration…
            </button>
          )}
        </div>
      )}
      {mode && (
        <form className="stack" onSubmit={submit}>
          <strong style={{ color: "#fff" }}>
            {mode === "reject" ? "Reject this registration" : mode === "refund" ? "Issue a refund" : "Cancel this registration"}
          </strong>
          {mode === "refund" && (
            <label>
              Amount ($)
              <input type="number" name="amount" step="0.01" min="0.01" max={(refundable / 100).toFixed(2)} defaultValue={(refundable / 100).toFixed(2)} required />
              <span className="hint">Up to {money(refundable)}.</span>
            </label>
          )}
          <label>
            {mode === "reject" ? "Reason (emailed to the family)" : "Reason"}
            <input type="text" name="reason" required minLength={3} maxLength={190} />
          </label>
          {mode !== "refund" && refundable > 0 && can("refunds.issue") && (
            <label className="check">
              <input type="checkbox" name="refund" defaultChecked={mode === "reject"} /> Refund the remaining {money(refundable)} to their card
            </label>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className={`btn ${mode === "refund" ? "" : "danger"}`} disabled={busy}>
              {busy ? "Working…" : "Confirm"}
            </button>
            <button type="button" className="btn ghost" onClick={() => setMode(null)}>
              Back
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Shows the player's team; an admin can take them off it (e.g. after a refund). */
function TeamLine({ team, canRemove, onRemoved }: { team: { entryId: string; name: string }; canRemove: boolean; onRemoved: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ fontSize: 24, color: "#fff", margin: "0 0 4px" }}>Team</h3>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <strong>{team.name}</strong>
        {canRemove && (
          <button
            className="btn ghost small"
            disabled={busy}
            onClick={async () => {
              if (window.confirm(`Take this player off ${team.name}? They won't be on any team until an admin adds them back. No email is sent.`) && (await run(() => api.del(`/admin/teams/roster/${team.entryId}`))) !== undefined) onRemoved();
            }}
          >
            Remove from team
          </button>
        )}
      </div>
      <ErrorAlert error={error} />
    </div>
  );
}
