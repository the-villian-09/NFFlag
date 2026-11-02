"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime, money } from "@/lib/format";
import { matchup, PAYOUT_SETUP, PAYOUT_STATUS } from "@/lib/referees";
import { useMe } from "@/lib/use-me";

interface OwedGame {
  officialId: string;
  gameId: string;
  startsAt: string;
  division: string;
  home: string | null;
  away: string | null;
  rateCents: number;
  status: string;
}
interface Owed {
  userId: string;
  name: string;
  email: string;
  payoutSetup: string;
  games: OwedGame[];
  totalCents: number;
}
interface PayoutRow {
  id: string;
  name: string;
  amountCents: number;
  status: string;
  lastError: string | null;
  attempts: number;
  createdAt: string;
  paidAt: string | null;
  payoutSetup: string;
}
interface Overview {
  stripe: { configured: boolean; environment: "test" | "live" };
  balance: { availableCents: number; pendingCents: number } | null;
  balanceError: string | null;
  owed: Owed[];
  waiting: PayoutRow[];
  recent: PayoutRow[];
}

/** Admin: approve referee pay for final games and send it through Stripe. */
export default function AdminRefereePayPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [d, setD] = useState<Overview | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error: actionError, run } = useAction();

  const load = useCallback(() => {
    api
      .get<Overview>("/admin/referees/pay")
      .then((r) => {
        setD(r);
        // Everything payable starts selected.
        setPicked(new Set(r.owed.flatMap((o) => o.games.filter((g) => g.status !== "no_show").map((g) => g.officialId))));
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [router]);
  useEffect(() => {
    if (me) load();
  }, [me, load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  const selectedTotal = d?.owed.flatMap((o) => o.games).filter((g) => picked.has(g.officialId)).reduce((n, g) => n + g.rateCents, 0) ?? 0;
  const short = d?.balance ? selectedTotal - d.balance.availableCents : 0;

  function toggle(id: string) {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }
  async function approve() {
    setNotice(null);
    const r = await run(() => api.post<{ payouts: { status: string; amountCents: number }[] }>("/admin/referees/pay/approve", { officialIds: [...picked] }));
    if (r) {
      const sent = r.payouts.filter((p) => p.status === "paid");
      const waiting = r.payouts.length - sent.length;
      setNotice(
        `Sent ${sent.length} payment${sent.length === 1 ? "" : "s"} (${money(sent.reduce((n, p) => n + p.amountCents, 0))})` +
          (sent.length ? "; those referees have been emailed a pay statement." : ".") +
          (waiting ? ` ${waiting} not sent yet; see Waiting to send below.` : ""),
      );
      load();
    }
  }
  async function setGame(g: OwedGame, body: { status?: string; rateCents?: number }) {
    if ((await run(() => api.patch(`/admin/referees/officials/${g.officialId}`, body))) !== undefined) load();
  }
  async function voidIt(p: PayoutRow) {
    const r = await run(() => api.post<{ games: number }>(`/admin/referees/pay/payouts/${p.id}/void`, { reason: "Voided by an admin" }));
    if (r) {
      setNotice(`Voided ${money(p.amountCents)} for ${p.name}. Their ${r.games} game${r.games === 1 ? " is" : "s are"} back under Owed.`);
      load();
    }
  }
  async function retry(p: PayoutRow) {
    const r = await run(() => api.post<{ payout: { status: string } }>(`/admin/referees/pay/payouts/${p.id}/retry`));
    if (r) {
      setNotice(r.payout.status === "paid" ? `Sent ${money(p.amountCents)} to ${p.name}.` : `Still not sent to ${p.name}; see the reason below.`);
      load();
    }
  }

  return (
    <main className="page">
      <p>
        <Link href="/admin/referees">← Referees</Link>
      </p>
      <h1>Pay referees</h1>
      <p className="muted">
        Final games are listed here. Approving sends each referee one payment from the league&apos;s Stripe balance; it reaches their bank in
        about 2 business days, or within minutes if they choose an instant payout.
      </p>
      <ErrorAlert error={error || actionError} />
      {notice && (
        <div className="alert ok" role="status">
          {notice}
        </div>
      )}
      {!d ? (
        !error && <p className="muted">Loading…</p>
      ) : !d.stripe.configured ? (
        <section className="card">
          <p style={{ margin: 0 }}>Stripe isn&apos;t set up yet, so referees can&apos;t be paid. See Admin → Payments.</p>
        </section>
      ) : (
        <>
          <div className="grid" style={{ alignItems: "start" }}>
            <BalanceCard d={d} onAdded={(m) => (setNotice(m), load())} />
            <section className="card">
              <h2>Year-end</h2>
              <p className="muted">
                Stripe prepares 1099 forms for referees paid over the IRS threshold (Stripe dashboard → Connect → Tax forms). This report lists
                what each referee was paid, for the league&apos;s accountant.
              </p>
              <a className="btn ghost small" href={`/api/v1/admin/referees/pay/report.csv?year=${new Date().getFullYear()}`}>
                Download {new Date().getFullYear()} report (CSV)
              </a>
            </section>
          </div>

          <section className="card" style={{ marginTop: 16 }}>
            <h2>Owed for final games</h2>
            {d.owed.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Nothing owed. Games show up here once their final score is entered.
              </p>
            ) : (
              <>
                {d.owed.map((o) => {
                  const ps = PAYOUT_SETUP[o.payoutSetup] ?? { label: o.payoutSetup, tone: "muted" };
                  return (
                    <div key={o.userId} className="owed-ref">
                      <p style={{ margin: "0 0 4px" }}>
                        <strong>{o.name}</strong> <span className={`status ${ps.tone}`}>{ps.label}</span>
                        {o.payoutSetup !== "ready" && <span className="hint"> Their pay waits until they finish payout setup.</span>}
                      </p>
                      {o.games.map((g) => (
                        <div key={g.officialId} className="owed-game">
                          <label className="check grow">
                            <input
                              type="checkbox"
                              checked={picked.has(g.officialId)}
                              disabled={g.status === "no_show" || busy}
                              onChange={() => toggle(g.officialId)}
                            />{" "}
                            {fmtDate(g.startsAt)} · {matchup(g)} <span className="muted">· {g.division}</span>
                          </label>
                          {g.status === "no_show" ? (
                            <>
                              <span className="status bad">No-show</span>
                              <button className="link-btn" onClick={() => setGame(g, { status: "assigned" })} disabled={busy}>
                                Undo
                              </button>
                            </>
                          ) : (
                            <>
                              <RateInput g={g} onSave={(rateCents) => setGame(g, { rateCents })} disabled={busy} />
                              <button className="link-btn" onClick={() => setGame(g, { status: "no_show" })} disabled={busy}>
                                No-show
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })}
                <div style={{ marginTop: 16, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <button className="btn" onClick={approve} disabled={busy || picked.size === 0}>
                    {busy ? "Sending…" : `Approve & pay ${money(selectedTotal)}`}
                  </button>
                  {d.balance && short > 0 && (
                    <span className="countdown">The Stripe balance is {money(short)} short. Add funds first, or some payments will wait.</span>
                  )}
                </div>
              </>
            )}
          </section>

          {d.waiting.length > 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <h2>Waiting to send</h2>
              <p className="muted">
                Payments for referees still finishing payout setup are sent automatically once they finish. Others can be retried here. Void a
                payment Stripe keeps refusing; its games go back under Owed so they can be approved again.
              </p>
              <PayoutTable rows={d.waiting} onRetry={retry} onVoid={voidIt} busy={busy} />
            </section>
          )}

          {d.recent.length > 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <h2>Recently paid</h2>
              <PayoutTable rows={d.recent} busy={busy} />
            </section>
          )}
        </>
      )}
    </main>
  );
}

function RateInput({ g, onSave, disabled }: { g: OwedGame; onSave: (cents: number) => void; disabled: boolean }) {
  const [v, setV] = useState((g.rateCents / 100).toFixed(2));
  const cents = Math.round(Number(v) * 100);
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
      $
      <input
        type="number"
        aria-label="Pay for this game"
        min={0}
        step="0.01"
        value={v}
        disabled={disabled}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (Number.isFinite(cents) && cents >= 0 && cents !== g.rateCents) onSave(cents);
        }}
      />
    </span>
  );
}

function BalanceCard({ d, onAdded }: { d: Overview; onAdded: (m: string) => void }) {
  const [amount, setAmount] = useState("");
  const { busy, error, run } = useAction();
  async function add(e: React.FormEvent) {
    e.preventDefault();
    const cents = Math.round(Number(amount) * 100);
    const r = await run(() => api.post<{ topup: { expectedAvailableOn: string | null } }>("/admin/referees/pay/add-funds", { amountCents: cents }));
    if (r) {
      setAmount("");
      onAdded(`Adding ${money(cents)} from the league's bank account${r.topup.expectedAvailableOn ? `; available about ${fmtDate(r.topup.expectedAvailableOn)}` : ""}.`);
    }
  }
  return (
    <section className="card">
      <h2>Stripe balance</h2>
      {d.stripe.environment === "test" && <span className="status warn">Test mode</span>}
      {d.balance ? (
        <dl className="kv" style={{ marginTop: 8 }}>
          <dt>Available to pay</dt>
          <dd>
            <strong>{money(d.balance.availableCents)}</strong>
          </dd>
          <dt>Still settling</dt>
          <dd>{money(d.balance.pendingCents)}</dd>
        </dl>
      ) : (
        <p className="muted">{d.balanceError ?? "Couldn't read the balance."}</p>
      )}
      <form className="stack" onSubmit={add} style={{ marginTop: 12 }}>
        <ErrorAlert error={error} />
        <label>
          Add funds from the league&apos;s bank ($)
          <input type="number" id="add-funds" min={1} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <button className="btn ghost small" disabled={busy || !amount}>
          {busy ? "Adding…" : "Add funds"}
        </button>
        <p className="hint" style={{ margin: 0 }}>
          Takes up to about 5 business days. Registration payments also add to this balance once they settle (about 2 business days).
        </p>
      </form>
    </section>
  );
}

function PayoutTable({ rows, onRetry, onVoid, busy }: { rows: PayoutRow[]; onRetry?: (p: PayoutRow) => void; onVoid?: (p: PayoutRow) => void; busy: boolean }) {
  return (
    <div className="table-wrap">
      <table className="simple stack">
        <thead>
          <tr>
            <th>Referee</th>
            <th>Amount</th>
            <th>Status</th>
            <th>{onRetry ? "Approved" : "Paid"}</th>
            {onRetry && <th></th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const s = PAYOUT_STATUS[p.status] ?? { label: p.status, tone: "muted" };
            return (
              <tr key={p.id}>
                <td data-label="Referee">{p.name}</td>
                <td data-label="Amount">{money(p.amountCents)}</td>
                <td data-label="Status">
                  <span className={`status ${s.tone}`}>{s.label}</span>
                  {p.lastError && <div className="hint">{p.lastError}</div>}
                </td>
                <td data-label={onRetry ? "Approved" : "Paid"}>{fmtDateTime(onRetry ? p.createdAt : p.paidAt)}</td>
                {onRetry && (
                  <td data-label="">
                    <span style={{ display: "inline-flex", gap: 8, flexWrap: "wrap" }}>
                      <button className="btn ghost small" onClick={() => onRetry(p)} disabled={busy || p.payoutSetup !== "ready"}>
                        Retry
                      </button>
                      {onVoid && p.status === "failed" && <VoidButton onConfirm={() => onVoid(p)} disabled={busy} />}
                    </span>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Two-step confirm (the page can't use browser dialogs). */
function VoidButton({ onConfirm, disabled }: { onConfirm: () => void; disabled: boolean }) {
  const [sure, setSure] = useState(false);
  return sure ? (
    <>
      <button className="btn danger small" onClick={onConfirm} disabled={disabled}>
        Void payment
      </button>
      <button className="link-btn" onClick={() => setSure(false)}>
        Keep
      </button>
    </>
  ) : (
    <button className="link-btn" onClick={() => setSure(true)} title="Cancel this payment; its games go back under Owed so they can be approved again">
      Void…
    </button>
  );
}
