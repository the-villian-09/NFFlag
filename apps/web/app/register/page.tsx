"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { Markdown } from "@/components/markdown";
import { PromoField } from "@/components/promo-field";
import { SquareCard, type SquareCardHandle } from "@/components/square-card";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime, GENDER_POLICY, money } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Division {
  id: string;
  name: string;
  genderPolicy: string;
  birthDateFrom: string | null;
  birthDateTo: string | null;
  eligibilityNotes: string | null;
  full: boolean;
  priceCents: number;
  feeCents: number;
  totalCents: number;
}
interface Options {
  enabled: boolean;
  season: { id: string; name: string } | null;
  window: { open: boolean; reason: string | null };
  feeMode?: "league" | "parent";
  holdMinutes?: number;
  waitlist?: boolean;
  promoCodes?: boolean;
  offerHours?: number;
  divisions: Division[];
  waivers: { slug: string; title: string; body: string; isPlaceholder: boolean }[];
  square: { applicationId: string; locationId: string; environment: "sandbox" | "production" } | null;
}
interface Player {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string;
  gender: "boy" | "girl";
}
interface Registration {
  id: string;
  status: string;
  playerId: string;
  divisionName?: string;
  priceCents: number;
  feeCents: number;
  totalCents: number;
  discountCents?: number;
  promoCode?: string | null;
  holdExpiresAt: string | null;
  paymentError?: string | null;
}

interface WaitlistItem {
  id: string;
  status: "waiting" | "offered" | "expired";
  playerId: string;
  divisionId: string;
  divisionName: string;
  offerExpiresAt: string | null;
  position: number | null;
}

type Step = "player" | "division" | "waivers" | "pay" | "done" | "waitlist";
const STEPS: { key: Step; label: string }[] = [
  { key: "player", label: "1 Player" },
  { key: "division", label: "2 Division" },
  { key: "waivers", label: "3 Waivers" },
  { key: "pay", label: "4 Payment" },
];

function Register() {
  const router = useRouter();
  const params = useSearchParams();
  const { me, loading } = useMe();
  const [options, setOptions] = useState<Options | null>(null);
  const [players, setPlayers] = useState<Player[] | null>(null);
  const [regs, setRegs] = useState<Registration[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [noHousehold, setNoHousehold] = useState(false);

  const [step, setStep] = useState<Step>("player");
  const [player, setPlayer] = useState<Player | null>(null);
  const [division, setDivision] = useState<Division | null>(null);
  const [eligibility, setEligibility] = useState<Record<string, string | null>>({});
  const [reg, setReg] = useState<Registration | null>(null);
  const [waitlist, setWaitlist] = useState<WaitlistItem[]>([]);
  /** Claiming a waitlist offer (from the offer email link). */
  const [offerId, setOfferId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, r, w] = await Promise.all([
        api.get<Options>("/registration/options"),
        api.get<{ items: Registration[] }>("/registrations"),
        api.get<{ items: WaitlistItem[] }>("/waitlist").catch(() => ({ items: [] as WaitlistItem[] })),
      ]);
      setOptions(o);
      setRegs(r.items);
      setWaitlist(w.items);
      try {
        setPlayers((await api.get<{ items: Player[] }>("/players")).items);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) setNoHousehold(true);
        else throw err;
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load registration.");
    }
  }, []);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  // Deep links: ?player=<id> preselects a child; ?registration=<id> resumes a payment; ?offer=<id> claims a waitlist offer.
  useEffect(() => {
    if (!players || !options) return;
    const offer = params.get("offer");
    if (offer) {
      const w = waitlist.find((x) => x.id === offer);
      if (w?.status === "offered") startOffer(w);
      else setLoadError(w?.status === "expired" ? "This offer has expired, and the spot went to the next family." : "This offer is no longer available.");
      return;
    }
    const resume = params.get("registration");
    if (resume) {
      const r = regs.find((x) => x.id === resume && (x.status === "pending_payment" || x.status === "expired"));
      if (r) {
        setReg(r);
        setPlayer(players.find((p) => p.id === r.playerId) ?? null);
        setStep("pay");
      }
      return;
    }
    const pre = params.get("player");
    const p = pre ? players.find((x) => x.id === pre) : null;
    if (p) void choosePlayer(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players, options]);

  function startOffer(w: WaitlistItem) {
    const p = players?.find((x) => x.id === w.playerId) ?? null;
    const d = options?.divisions.find((x) => x.id === w.divisionId) ?? null;
    if (!p || !d) {
      setLoadError("This offer is no longer available.");
      return;
    }
    setOfferId(w.id);
    setPlayer(p);
    setDivision(d);
    setStep("waivers");
  }

  async function choosePlayer(p: Player) {
    setPlayer(p);
    setDivision(null);
    try {
      const e = await api.get<{ items: { divisionId: string; reason: string | null }[] }>(`/players/${p.id}/eligibility`);
      setEligibility(Object.fromEntries(e.items.map((i) => [i.divisionId, i.reason])));
    } catch {
      setEligibility({});
    }
    setStep("division");
  }

  const activeFor = useMemo(() => {
    const m = new Map<string, Registration>();
    for (const r of regs) if (["processing", "paid", "approved", "pending_payment"].includes(r.status)) m.set(r.playerId, r);
    return m;
  }, [regs]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  // A waitlist offer can be claimed even after general registration closes.
  const closed = options && (!options.enabled || !options.window.open) && !offerId;
  const waitlistFor = (playerId: string) => waitlist.find((w) => w.playerId === playerId && (w.status === "waiting" || w.status === "offered"));

  return (
    <main className="page" style={{ maxWidth: 1000 }}>
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1>Register{options?.season ? ` for ${options.season.name}` : ""}</h1>
      <ErrorAlert error={loadError} />
      {!options || !players ? (
        noHousehold ? (
          <div className="card">
            <p>First, add your family details on your account page.</p>
            <Link className="btn" href="/dashboard">
              Go to my account
            </Link>
          </div>
        ) : (
          !loadError && <p className="muted">Loading…</p>
        )
      ) : closed ? (
        <div className="card">
          <h2>Registration isn't open</h2>
          <p className="muted">{options.window.reason ?? "Check back soon."}</p>
        </div>
      ) : (
        <>
          {step !== "done" && (
            <ol className="steps">
              {STEPS.map((s) => (
                <li key={s.key} aria-current={s.key === step ? "step" : undefined}>
                  {s.label}
                </li>
              ))}
            </ol>
          )}
          {!options.square && step !== "done" && (
            <div className="alert error" style={{ marginBottom: 16 }}>
              Online payment is temporarily unavailable. You can still add your players; please check back soon to register.
            </div>
          )}

          {step === "player" && (
            <section>
              <h2 style={{ fontSize: 36, color: "#fff" }}>Who are you registering?</h2>
              {players.length === 0 && <p className="muted">You haven't added any players yet.</p>}
              <div className="choice-grid">
                {players.map((p) => {
                  const r = activeFor.get(p.id);
                  const busy = r && r.status !== "pending_payment";
                  const w = waitlistFor(p.id);
                  return (
                    <button
                      key={p.id}
                      className={`choice ${p.gender === "girl" ? "girls" : ""}`}
                      disabled={!!busy || w?.status === "waiting"}
                      onClick={() =>
                        w?.status === "offered"
                          ? startOffer(w)
                          : r?.status === "pending_payment"
                            ? (setReg(r), setPlayer(p), setStep("pay"))
                            : choosePlayer(p)
                      }
                    >
                      <strong>
                        {p.firstName} {p.lastName}
                      </strong>
                      <span className="muted">Born {fmtDate(p.birthDate)}</span>
                      {busy && <span className="muted">Already registered this season</span>}
                      {r?.status === "pending_payment" && <span className="countdown">Payment not finished — continue</span>}
                      {w?.status === "waiting" && (
                        <span className="muted">
                          #{w.position} on the {w.divisionName} waitlist
                        </span>
                      )}
                      {w?.status === "offered" && <span className="countdown">A spot opened in {w.divisionName} — claim it</span>}
                    </button>
                  );
                })}
                <Link className="choice" href="/players/new?next=register" style={{ textDecoration: "none", borderTopColor: "var(--lime)" }}>
                  <strong>+ Add a player</strong>
                  <span className="muted">Name, birth date, emergency contact</span>
                </Link>
              </div>
            </section>
          )}

          {step === "division" && player && (
            <section>
              <h2 style={{ fontSize: 36, color: "#fff" }}>Choose a division for {player.firstName}</h2>
              <div className="choice-grid">
                {options.divisions.map((d) => {
                  const reason = eligibility[d.id] ?? null;
                  const canWait = d.full && !reason && !!options.waitlist;
                  const disabled = (d.full && !canWait) || !!reason;
                  return (
                    <button
                      key={d.id}
                      className={`choice ${d.genderPolicy === "girls" ? "girls" : ""}`}
                      disabled={disabled}
                      aria-pressed={division?.id === d.id}
                      onClick={() => {
                        setDivision(d);
                        setStep(d.full ? "waitlist" : "waivers");
                      }}
                    >
                      <strong>{d.name}</strong>
                      <span className="muted">
                        {GENDER_POLICY[d.genderPolicy]}
                        {d.birthDateFrom || d.birthDateTo
                          ? ` · born ${d.birthDateFrom ? fmtDate(d.birthDateFrom) : "any time"} – ${d.birthDateTo ? fmtDate(d.birthDateTo) : "any time"}`
                          : ""}
                      </span>
                      {d.eligibilityNotes && <span className="muted">{d.eligibilityNotes}</span>}
                      <span className="price">{money(d.priceCents)}</span>
                      {reason ? (
                        <span className="hint">{reason}</span>
                      ) : d.full ? (
                        <span>
                          <span className="status bad">Full</span>
                          {canWait && <span className="countdown"> Join the waitlist</span>}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
              <p style={{ marginTop: 16 }}>
                <button className="link-btn" onClick={() => setStep("player")}>
                  ← Choose a different player
                </button>
              </p>
            </section>
          )}

          {step === "waitlist" && player && division && (
            <JoinWaitlist
              player={player}
              division={division}
              offerHours={options.offerHours ?? 48}
              onBack={() => setStep("division")}
            />
          )}

          {step === "waivers" && player && division && (
            <Waivers
              offerId={offerId}
              options={options}
              player={player}
              division={division}
              defaultSigner={me.user.name}
              onBack={() => setStep("division")}
              onStarted={(r) => {
                setReg(r);
                setStep("pay");
              }}
            />
          )}

          {step === "pay" && reg && player && (options.square || reg.totalCents === 0) && (
            <Pay
              reg={reg}
              player={player}
              square={options.square}
              promoCodes={!!options.promoCodes}
              onChange={(r) => setReg({ ...reg, ...r })}
              email={me.user.email}
              name={me.user.name}
              onPaid={() => setStep("done")}
              onCancel={async () => {
                await api.post(`/registrations/${reg.id}/cancel`).catch(() => undefined);
                setReg(null);
                await load();
                setStep("player");
              }}
            />
          )}

          {step === "done" && player && (
            <div className="card">
              <h2>You're all set</h2>
              <p>
                We received {player.firstName}'s registration and payment. A receipt is on its way to <strong>{me.user.email}</strong>.
              </p>
              <p className="muted">The league reviews each registration (age and division) and will email you once it's approved.</p>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                <button
                  className="btn"
                  onClick={async () => {
                    setReg(null);
                    setPlayer(null);
                    setDivision(null);
                    await load();
                    setStep("player");
                    router.replace("/register");
                  }}
                >
                  Register another child
                </button>
                <Link className="btn ghost" href="/dashboard">
                  Back to my account
                </Link>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function JoinWaitlist({ player, division, offerHours, onBack }: { player: Player; division: Division; offerHours: number; onBack: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState<number | null>(null);
  async function join() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ position: number }>("/waitlist", { playerId: player.id, divisionId: division.id });
      setPosition(r.position);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  if (position) {
    return (
      <div className="card">
        <h2>You're on the waitlist</h2>
        <p>
          {player.firstName} is <strong>#{position}</strong> on the {division.name} waitlist. We've emailed you a confirmation.
        </p>
        <p className="muted">
          If a spot opens, we'll email you an offer. You'll have {offerHours} hours to claim it and pay before it goes to the next family. Nothing is
          charged until you claim a spot.
        </p>
        <Link className="btn" href="/dashboard">
          Back to my account
        </Link>
      </div>
    );
  }
  return (
    <div className="card">
      <h2>{division.name} is full</h2>
      <p>
        Join the waitlist for {player.firstName}. Families are offered spots in the order they joined, and nothing is charged unless you claim one.
      </p>
      <p className="muted">When a spot opens, you'll get an email and have {offerHours} hours to claim it.</p>
      <ErrorAlert error={error} />
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" onClick={join} disabled={busy}>
          {busy ? "Joining…" : "Join the waitlist"}
        </button>
        <button type="button" className="link-btn" onClick={onBack}>
          ← Back
        </button>
      </div>
    </div>
  );
}

function Waivers({
  offerId,
  options,
  player,
  division,
  defaultSigner,
  onBack,
  onStarted,
}: {
  offerId: string | null;
  options: Options;
  player: Player;
  division: Division;
  defaultSigner: string;
  onBack: () => void;
  onStarted: (r: Registration) => void;
}) {
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [signer, setSigner] = useState(defaultSigner);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const all = options.waivers.every((w) => accepted[w.slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const acceptedWaivers = options.waivers.filter((w) => accepted[w.slug]).map((w) => w.slug);
      const r = offerId
        ? await api.post<{ registration: Registration }>(`/waitlist/${offerId}/accept`, { signerName: signer, acceptedWaivers })
        : await api.post<{ registration: Registration }>("/registrations", {
            playerId: player.id,
            divisionId: division.id,
            signerName: signer,
            acceptedWaivers,
          });
      onStarted({ ...r.registration, divisionName: division.name });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <h2 style={{ fontSize: 36, color: "#fff" }}>Waivers and agreements</h2>
      <p className="muted" style={{ margin: 0 }}>
        Registering <strong>{player.firstName}</strong> for <strong>{division.name}</strong>. Please read and accept each one.
      </p>
      {options.waivers.map((w) => (
        <div key={w.slug} className="waiver">
          <strong style={{ fontSize: 20, color: "#fff" }}>{w.title}</strong>
          <Markdown source={w.body} />
          <label className="check">
            <input type="checkbox" checked={!!accepted[w.slug]} onChange={(e) => setAccepted((a) => ({ ...a, [w.slug]: e.target.checked }))} />I
            have read and agree to the {w.title.toLowerCase()}.
          </label>
        </div>
      ))}
      <label>
        Parent or guardian's full name (your electronic signature)
        <input type="text" value={signer} onChange={(e) => setSigner(e.target.value)} required minLength={3} maxLength={120} autoComplete="name" />
      </label>
      <ErrorAlert error={error} />
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <button className="btn" disabled={busy || !all || !options.square}>
          {busy ? "Saving…" : "Continue to payment"}
        </button>
        <button type="button" className="link-btn" onClick={onBack}>
          ← Back
        </button>
      </div>
      <span className="hint">
        {offerId
          ? `${player.firstName}'s spot stays held until your offer deadline.`
          : `Continuing holds ${player.firstName}'s spot for ${options.holdMinutes ?? 15} minutes while you pay.`}
      </span>
    </form>
  );
}

function useCountdown(until: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!until) return null;
  const ms = new Date(until).getTime() - now;
  if (ms <= 0) return "0:00";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  // Long holds (waitlist offers) read better as a deadline than a countdown.
  if (m >= 90) return `until ${fmtDateTime(until)}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function Pay({
  reg,
  player,
  square,
  promoCodes,
  onChange,
  email,
  name,
  onPaid,
  onCancel,
}: {
  reg: Registration;
  player: Player;
  square: Options["square"];
  promoCodes: boolean;
  onChange: (r: Partial<Registration>) => void;
  email: string;
  name: string;
  onPaid: () => void;
  onCancel: () => void;
}) {
  const card = useRef<SquareCardHandle>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(reg.paymentError ?? null);
  const [pending, setPending] = useState(false);
  const left = useCountdown(reg.holdExpiresAt);

  const free = reg.totalCents === 0;
  // The card form is rebuilt when a code changes the total from $0 back to a price.
  useEffect(() => {
    if (free) setReady(false);
  }, [free]);

  async function applyCode(code: string | null) {
    const r = await api.put<{ registration: Registration }>(`/registrations/${reg.id}/promo`, { code });
    setError(null);
    onChange(r.registration);
  }

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      if (free) {
        await api.post(`/registrations/${reg.id}/pay`, {});
      } else {
        const [givenName, ...rest] = name.trim().split(/\s+/);
        const token = await card.current!.tokenize({ amountCents: reg.totalCents, givenName: givenName ?? "", familyName: rest.join(" "), email });
        await api.post(`/registrations/${reg.id}/pay`, { sourceId: token });
      }
      onPaid();
    } catch (err) {
      if (err instanceof ApiError && err.code === "PAYMENT_PENDING") setPending(true);
      setError(err instanceof Error ? err.message : "The payment didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <div className="card">
        <h2>Confirming your payment</h2>
        <p>{error}</p>
        <Link className="btn" href="/dashboard">
          Go to my account
        </Link>
      </div>
    );
  }

  return (
    <section className="grid" style={{ alignItems: "start" }}>
      <div className="card">
        <h2>Payment</h2>
        <div className="summary">
          <div>
            <span>
              {player.firstName} {player.lastName}
              {reg.divisionName ? ` · ${reg.divisionName}` : ""}
            </span>
            <span>{money(reg.priceCents)}</span>
          </div>
          {!!reg.discountCents && (
            <div className="discount">
              <span>Promo {reg.promoCode}</span>
              <span>−{money(reg.discountCents)}</span>
            </div>
          )}
          {reg.feeCents > 0 && (
            <div>
              <span>Card processing fee</span>
              <span>{money(reg.feeCents)}</span>
            </div>
          )}
          <div className="total">
            <span>Total</span>
            <span>{money(reg.totalCents)}</span>
          </div>
        </div>
        {promoCodes && <PromoField applied={reg.promoCode ?? null} onApply={applyCode} disabled={busy} />}
        {left && (
          <p className="countdown" style={{ marginTop: 12 }}>
            {left === "0:00"
              ? "Your hold has expired. You can still pay if there's room."
              : left.startsWith("until")
                ? `Spot held ${left}`
                : `Spot held for ${left}`}
          </p>
        )}
        <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>
          Cancel this registration
        </button>
      </div>
      {free ? (
        <div className="card">
          <h2>Nothing to pay</h2>
          <p className="muted">Your promo code covers the full price, so no card is needed.</p>
          <ErrorAlert error={error} />
          <button className="btn" style={{ marginTop: 16 }} onClick={pay} disabled={busy}>
            {busy ? "Saving…" : "Complete registration"}
          </button>
        </div>
      ) : square ? (
        <div className="card">
          <h2>Card</h2>
          <SquareCard ref={card} applicationId={square.applicationId} locationId={square.locationId} environment={square.environment} onReady={setReady} />
          <ErrorAlert error={error} />
          <button className="btn" style={{ marginTop: 16 }} onClick={pay} disabled={!ready || busy}>
            {busy ? "Processing…" : `Pay ${money(reg.totalCents)}`}
          </button>
          <p className="hint" style={{ marginTop: 8 }}>
            Payments are processed securely by Square. We never see or store your card number.
          </p>
        </div>
      ) : (
        <div className="card">
          <h2>Card</h2>
          <p className="muted">Online payment is temporarily unavailable. Please try again later.</p>
        </div>
      )}
    </section>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<main className="page muted">Loading…</main>}>
      <Register />
    </Suspense>
  );
}
