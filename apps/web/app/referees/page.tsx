"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { EventRow } from "@/components/event-row";
import { ErrorAlert, useAction } from "@/components/form";
import { StripeConnectComponent } from "@/components/stripe-connect";
import { api, ApiError } from "@/lib/api";
import { fmtDate, money } from "@/lib/format";
import { matchup, OFFICIAL_STATUS, PAYOUT_SETUP, PAYOUT_STATUS, REF_STATUS } from "@/lib/referees";
import { useMe } from "@/lib/use-me";

interface Home {
  season: { id: string; name: string } | null;
  minAge: number;
  dropCutoffHours: number;
  application: {
    id: string;
    status: string;
    certification: string;
    certificationExpiresOn: string | null;
    decisionReason: string | null;
  } | null;
  approved: boolean;
  payouts: { available: boolean; setup: string; payoutsEnabled: boolean };
}
interface OpenGame {
  gameId: string;
  startsAt: string;
  location: string;
  division: string;
  home: string | null;
  away: string | null;
  rateCents: number;
  slots: number;
  filled: number;
}
interface MyGame {
  officialId: string;
  gameId: string;
  startsAt: string;
  location: string;
  gameStatus: string;
  division: string;
  home: string | null;
  away: string | null;
  status: string;
  rateCents: number;
  payoutStatus: string | null;
}
interface Payout {
  id: string;
  amountCents: number;
  status: string;
  lastError: string | null;
  paidAt: string | null;
  createdAt: string;
  games: { startsAt: string; division: string; home: string | null; away: string | null; rateCents: number }[];
}

/** Referee sign-up, then the referee's home: payout setup, games and pay. */
export default function RefereesPage() {
  const { me, loading } = useMe();
  const [home, setHome] = useState<Home | null>(null);
  const [closed, setClosed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<Home>("/referees/me")
      .then(setHome)
      .catch((err) => {
        if (err instanceof ApiError && err.code === "FEATURE_DISABLED") setClosed(true);
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, []);

  useEffect(() => {
    if (me) load();
  }, [me, load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1>Referees</h1>
      <ErrorAlert error={error} />
      {closed ? (
        <section className="card">
          <p style={{ margin: 0 }}>Referee sign-up isn&apos;t open yet. Check back soon.</p>
        </section>
      ) : !home ? (
        !error && <p className="muted">Loading…</p>
      ) : !home.season ? (
        <section className="card">
          <p style={{ margin: 0 }}>Referee sign-up opens when the next season is set up.</p>
        </section>
      ) : home.approved ? (
        <RefereeHome home={home} userId={me.user.id} onChanged={load} />
      ) : home.application && ["submitted", "revoked"].includes(home.application.status) ? (
        <ApplicationStatus home={home} onChanged={load} />
      ) : (
        <>
          {home.application && <ApplicationStatus home={home} onChanged={load} />}
          <SignUp home={home} name={me.user.name} onDone={load} />
        </>
      )}
    </main>
  );
}

function SignUp({ home, name, onDone }: { home: Home; name: string; onDone: () => void }) {
  const { busy, error, run } = useAction();
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    const r = await run(() =>
      api.post("/referees/applications", {
        phone: v("phone"),
        birthDate: v("birthDate"),
        certification: v("certification"),
        certificationExpiresOn: v("certificationExpiresOn"),
        experience: v("experience") || undefined,
      }),
    );
    if (r !== undefined) onDone();
  }
  return (
    <section className="grid" style={{ alignItems: "start", marginTop: 16 }}>
      <div className="card">
        <h2>Referee for {home.season!.name}</h2>
        <p>Sign up to referee NFFL games and get paid by direct deposit.</p>
        <ul className="ticks">
          <li>At least {home.minAge} years old</li>
          <li>A current referee certification</li>
          <li>A background check (the league contacts you about it)</li>
        </ul>
        <p className="muted">
          Once you&apos;re approved, you set up payouts with Stripe here on the site, then sign up for open games. The league can also assign
          you. Pay for each game is sent after the game, usually weekly.
        </p>
      </div>
      <form className="card stack" onSubmit={submit}>
        <h2>Sign up</h2>
        <ErrorAlert error={error} />
        <p className="muted" style={{ margin: 0 }}>
          Signing up as <strong>{name}</strong>.
        </p>
        <label>
          Mobile phone
          <input type="tel" id="ref-phone" name="phone" required minLength={7} maxLength={40} autoComplete="tel" />
        </label>
        <label>
          Date of birth
          <input type="date" id="ref-dob" name="birthDate" required />
        </label>
        <label>
          Certification
          <input type="text" id="ref-cert" name="certification" required minLength={2} maxLength={200} placeholder="e.g. NFL FLAG Official" />
        </label>
        <label>
          Certification expires
          <input type="date" id="ref-cert-exp" name="certificationExpiresOn" />
        </label>
        <label>
          Experience (optional)
          <textarea id="ref-exp" name="experience" rows={3} maxLength={2000} placeholder="Leagues, ages and seasons you've refereed" />
        </label>
        <button className="btn" disabled={busy}>
          {busy ? "Sending…" : "Sign up to referee"}
        </button>
      </form>
    </section>
  );
}

function ApplicationStatus({ home, onChanged }: { home: Home; onChanged: () => void }) {
  const a = home.application!;
  const s = REF_STATUS[a.status] ?? { label: a.status, tone: "muted" };
  const { busy, error, run } = useAction();
  async function withdraw() {
    if ((await run(() => api.post(`/referees/applications/${a.id}/withdraw`))) !== undefined) onChanged();
  }
  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <h2>Your sign-up</h2>
      <p>
        <span className={`status ${s.tone}`}>{s.label}</span> <span className="muted">· {home.season?.name}</span>
      </p>
      <ErrorAlert error={error} />
      {a.status === "submitted" && (
        <>
          <p>
            Thanks! The league is reviewing your sign-up. They&apos;ll contact you about your background check and verify your certification
            ({a.certification}
            {a.certificationExpiresOn ? `, valid until ${fmtDate(a.certificationExpiresOn)}` : ""}). We&apos;ll email you when you&apos;re approved.
          </p>
          <button className="btn ghost small" onClick={withdraw} disabled={busy}>
            Withdraw my sign-up
          </button>
        </>
      )}
      {(a.status === "rejected" || a.status === "revoked") && (
        <p>
          {a.status === "revoked" ? "The league removed your approval to referee." : "The league wasn't able to approve you this season."}
          {a.decisionReason ? ` Reason: ${a.decisionReason}` : ""} Contact the league with any questions.
        </p>
      )}
      {a.status === "withdrawn" && <p className="muted">You withdrew this sign-up. You can sign up again below.</p>}
    </section>
  );
}

function RefereeHome({ home, userId, onChanged }: { home: Home; userId: string; onChanged: () => void }) {
  const [games, setGames] = useState<{ open: OpenGame[]; mine: MyGame[] } | null>(null);
  const [pay, setPay] = useState<Payout[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const loadGames = useCallback(() => {
    api.get<{ open: OpenGame[]; mine: MyGame[] }>("/referees/games").then(setGames).catch(() => setGames({ open: [], mine: [] }));
    api.get<{ payouts: Payout[] }>("/referees/pay").then((r) => setPay(r.payouts)).catch(() => setPay([]));
  }, []);
  useEffect(loadGames, [loadGames]);

  async function claim(g: OpenGame) {
    setNotice(null);
    if ((await run(() => api.post(`/referees/games/${g.gameId}/claim`))) !== undefined) {
      setNotice(`You're on ${matchup(g)}. It's in My games.`);
      loadGames();
    }
  }
  async function drop(g: MyGame) {
    setNotice(null);
    if ((await run(() => api.del(`/referees/games/${g.gameId}/claim`))) !== undefined) {
      setNotice(`You're off ${matchup(g)}.`);
      loadGames();
    }
  }

  const now = Date.now();
  const upcoming = games?.mine.filter((g) => new Date(g.startsAt).getTime() > now - 3 * 3600_000 && g.gameStatus !== "final") ?? [];
  const past = games?.mine.filter((g) => !upcoming.includes(g)).reverse() ?? [];
  const owedCents = past.filter((g) => g.gameStatus === "final" && g.status !== "no_show" && g.payoutStatus !== "paid").reduce((n, g) => n + g.rateCents, 0);

  return (
    <>
      <p>
        <span className="status ok">Approved referee</span> <span className="muted">· {home.season?.name}</span>
      </p>
      <PayoutSetup home={home} userId={userId} onChanged={onChanged} />
      {notice && (
        <div className="alert ok" role="status">
          {notice}
        </div>
      )}
      <ErrorAlert error={error} />
      <div className="grid" style={{ marginTop: 16, alignItems: "start" }}>
        <section className="card">
          <h2>My games</h2>
          {!games ? (
            <p className="muted">Loading…</p>
          ) : upcoming.length === 0 ? (
            <p className="muted">No upcoming games. Pick some from Open games.</p>
          ) : (
            <ul className="events">
              {upcoming.map((g) => {
                const canDrop = g.status === "assigned" && new Date(g.startsAt).getTime() - now > home.dropCutoffHours * 3600_000;
                return (
                  <EventRow
                    key={g.officialId}
                    startsAt={g.startsAt}
                    title={matchup(g)}
                    detail={`${g.division} · ${g.location} · ${money(g.rateCents)}`}
                    badge={g.gameStatus !== "scheduled" ? <span className="status warn">{g.gameStatus}</span> : undefined}
                    action={
                      canDrop ? (
                        <button className="btn ghost small" onClick={() => drop(g)} disabled={busy}>
                          Drop
                        </button>
                      ) : undefined
                    }
                  />
                );
              })}
            </ul>
          )}
          <p className="hint">
            You can drop a game up to {home.dropCutoffHours} hours before it starts. After that, contact the league so they can find a
            replacement.
          </p>
        </section>
        <section className="card">
          <h2>Open games</h2>
          {!games ? (
            <p className="muted">Loading…</p>
          ) : games.open.length === 0 ? (
            <p className="muted">No open games right now. New games show up here as the league schedules them.</p>
          ) : (
            <ul className="events">
              {games.open.map((g) => (
                <EventRow
                  key={g.gameId}
                  startsAt={g.startsAt}
                  title={matchup(g)}
                  detail={`${g.division} · ${g.location} · ${money(g.rateCents)} · ${g.slots - g.filled} of ${g.slots} spot${g.slots === 1 ? "" : "s"} open`}
                  action={
                    <button className="btn small" onClick={() => claim(g)} disabled={busy}>
                      Take game
                    </button>
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Pay</h2>
        {owedCents > 0 && (
          <p>
            <strong>{money(owedCents)}</strong> for finished games is waiting for the league to approve. Pay is usually approved weekly.
          </p>
        )}
        {!pay ? (
          <p className="muted">Loading…</p>
        ) : pay.length === 0 ? (
          <p className="muted">No pay yet. After your games are final, the league approves pay and it&apos;s sent to your payout account.</p>
        ) : (
          <div className="table-wrap">
            <table className="simple stack">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Games</th>
                  <th>Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pay.map((p) => {
                  const s = PAYOUT_STATUS[p.status] ?? { label: p.status, tone: "muted" };
                  return (
                    <tr key={p.id}>
                      <td data-label="Date">{fmtDate(p.paidAt ?? p.createdAt)}</td>
                      <td data-label="Games">
                        {p.games.map((g, i) => (
                          <div key={i}>
                            {fmtDate(g.startsAt)} · {matchup(g)} · {money(g.rateCents)}
                          </div>
                        ))}
                      </td>
                      <td data-label="Amount">{money(p.amountCents)}</td>
                      <td data-label="Status">
                        <span className={`status ${s.tone}`}>{s.label}</span>
                        {p.lastError && <div className="hint">{p.lastError}</div>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {past.length > 0 && (
          <details style={{ marginTop: 12 }}>
            <summary>Past games ({past.length})</summary>
            <ul className="plain-list">
              {past.map((g) => {
                const s = g.payoutStatus === "paid" ? { label: "Paid", tone: "ok" } : OFFICIAL_STATUS[g.status] ?? { label: g.status, tone: "muted" };
                return (
                  <li key={g.officialId}>
                    {fmtDate(g.startsAt)} · {matchup(g)} · {money(g.rateCents)} <span className={`status ${s.tone}`}>{s.label}</span>
                  </li>
                );
              })}
            </ul>
          </details>
        )}
      </section>
    </>
  );
}

/** Stripe payout setup, then payouts (with Get paid now) and tax forms, all embedded. */
function PayoutSetup({ home, userId, onChanged }: { home: Home; userId: string; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const setup = PAYOUT_SETUP[home.payouts.setup] ?? { label: home.payouts.setup, tone: "muted" };
  const ready = home.payouts.setup === "ready";

  async function finished() {
    await api.post("/referees/payouts/refresh").catch(() => undefined);
    setOpen(false);
    onChanged();
  }

  if (!home.payouts.available) {
    return (
      <section className="card" style={{ marginTop: 16 }}>
        <h2>Payouts</h2>
        <p className="muted" style={{ margin: 0 }}>
          Payout setup isn&apos;t available yet. The league will let you know.
        </p>
      </section>
    );
  }
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>Payouts</h2>
      <p>
        <span className={`status ${setup.tone}`}>{setup.label}</span>
      </p>
      {!ready && !open && (
        <>
          <p>
            Set up payouts so the league can pay you by direct deposit. Stripe, the league&apos;s payment processor, asks for your legal name,
            date of birth, address, Social Security number (for tax forms) and the bank account or debit card to pay into. That information
            goes to Stripe, not to the league.
          </p>
          <button className="btn" onClick={() => setOpen(true)}>
            {home.payouts.setup === "not_started" ? "Set up payouts" : "Finish payout setup"}
          </button>
        </>
      )}
      {open && (
        <>
          <StripeConnectComponent tag="account-onboarding" userId={userId} onExit={finished} />
          <button className="link-btn" onClick={finished}>
            Close
          </button>
        </>
      )}
      {ready && (
        <>
          <StripeConnectComponent tag="notification-banner" userId={userId} />
          <p className="muted">
            Pay reaches your bank about 2 business days after the league sends it. Need it sooner? Use <strong>Instant payout</strong> below;
            Stripe shows the fee before you confirm.
          </p>
          <StripeConnectComponent tag="payouts" userId={userId} />
          <details style={{ marginTop: 16 }}>
            <summary>Tax forms and account details</summary>
            <div style={{ marginTop: 12, display: "grid", gap: 16 }}>
              <StripeConnectComponent tag="documents" userId={userId} />
              <StripeConnectComponent tag="account-management" userId={userId} />
            </div>
          </details>
        </>
      )}
    </section>
  );
}
