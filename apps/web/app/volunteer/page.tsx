"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { Markdown } from "@/components/markdown";
import { SquareCard, type SquareCardHandle } from "@/components/square-card";
import { api, ApiError } from "@/lib/api";
import { money } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Role {
  key: "head_coach" | "assistant_coach" | "team_manager";
  label: string;
  priceCents: number;
  feeCents: number;
  totalCents: number;
}
interface Options {
  enabled: boolean;
  season: { id: string; name: string } | null;
  roles: Role[];
  divisions: { id: string; name: string }[];
  agreement: { title: string; body: string } | null;
  square: { applicationId: string; locationId: string; environment: "sandbox" | "production" } | null;
}
interface Application {
  id: string;
  roleKey: string;
  roleLabel: string;
  status: string;
  totalCents: number;
  feeCents: number;
  processingFeeCents: number;
  paymentError: string | null;
  decisionReason: string | null;
  screeningStatus: string;
  seasonName: string;
}

const STATUS: Record<string, { label: string; tone: string; help: string }> = {
  pending_payment: { label: "Awaiting fee", tone: "warn", help: "Pay the volunteer fee to submit your application." },
  processing: { label: "Confirming payment", tone: "info", help: "We're confirming your payment. Please don't pay again." },
  submitted: { label: "Submitted", tone: "info", help: "The league will contact you about your background check." },
  approved: { label: "Approved", tone: "ok", help: "You're on the coaching staff this season. Thank you!" },
  rejected: { label: "Not approved", tone: "bad", help: "Any fee you paid has been refunded." },
};

/** Apply to coach or be a team manager; pay the volunteer fee; see status. */
export default function VolunteerPage() {
  const { me, loading } = useMe();
  const [opts, setOpts] = useState<Options | null>(null);
  const [apps, setApps] = useState<Application[] | null>(null);
  const [kids, setKids] = useState<{ id: string; firstName: string; lastName: string }[]>([]);
  const [paying, setPaying] = useState<Application | null>(null);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, a] = await Promise.all([api.get<Options>("/volunteer/options"), api.get<{ items: Application[] }>("/volunteer/applications")]);
      setOpts(o);
      setApps(a.items);
      api
        .get<{ items: { id: string; firstName: string; lastName: string }[] }>("/players")
        .then((p) => setKids(p.items))
        .catch(() => setKids([]));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't load.");
    }
  }, []);

  useEffect(() => {
    if (me) void load();
  }, [me, load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page" style={{ maxWidth: 1000 }}>
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1>Volunteer</h1>
      <p className="muted">Coach or be a team manager (team mom). Every volunteer who works with players completes a background check before being approved.</p>
      <ErrorAlert error={error} />
      {!opts || !apps ? (
        !error && <p className="muted">Loading…</p>
      ) : paying ? (
        <PayFee
          app={paying}
          square={opts.square}
          email={me.user.email}
          name={me.user.name}
          onDone={async () => {
            setPaying(null);
            await load();
          }}
        />
      ) : (
        <>
          {apps.length > 0 && (
            <section className="card" style={{ marginTop: 16 }}>
              <h2>Your applications</h2>
              <ul className="list">
                {apps.map((a) => {
                  const s = STATUS[a.status] ?? { label: a.status, tone: "muted", help: "" };
                  return (
                    <li key={a.id}>
                      <span>
                        <span className="who">{a.roleLabel}</span>
                        <br />
                        <span className="muted">
                          {a.seasonName}
                          {a.totalCents ? ` · ${money(a.totalCents)}` : ""} · {s.help}
                        </span>
                        {a.decisionReason && a.status === "rejected" && (
                          <>
                            <br />
                            <span className="muted">Reason: {a.decisionReason}</span>
                          </>
                        )}
                        {a.paymentError && a.status === "pending_payment" && (
                          <>
                            <br />
                            <span className="hint">{a.paymentError}</span>
                          </>
                        )}
                      </span>
                      <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <span className={`status ${s.tone}`}>{s.label}</span>
                        {a.status === "pending_payment" && (
                          <button className="btn small" onClick={() => setPaying(a)}>
                            Pay {money(a.totalCents)}
                          </button>
                        )}
                        {(a.status === "pending_payment" || a.status === "submitted") && (
                          <button
                            className="link-btn"
                            onClick={async () => {
                              if (!window.confirm(a.status === "submitted" ? "Withdraw your application? Your fee will be refunded." : "Withdraw your application?")) return;
                              await api.post(`/volunteer/applications/${a.id}/withdraw`).catch((err) => setError(err instanceof Error ? err.message : "Couldn't withdraw."));
                              await load();
                            }}
                          >
                            Withdraw
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {!opts.enabled ? (
            <section className="card" style={{ marginTop: 16 }}>
              <h2>Applications aren't open yet</h2>
              <p className="muted">Check back soon.</p>
            </section>
          ) : applying ? (
            <ApplyForm
              opts={opts}
              kids={kids}
              defaultSigner={me.user.name}
              onCancel={() => setApplying(false)}
              onCreated={async (a) => {
                setApplying(false);
                await load();
                if (a.status === "pending_payment") setPaying({ ...a, roleLabel: opts.roles.find((r) => r.key === a.roleKey)?.label ?? a.roleKey } as Application);
              }}
            />
          ) : (
            <section className="card" style={{ marginTop: 16 }}>
              <h2>Apply for {opts.season?.name}</h2>
              <ul>
                {opts.roles.map((r) => (
                  <li key={r.key}>
                    {r.label}: {r.totalCents ? `${money(r.totalCents)} volunteer fee` : "no fee"}
                  </li>
                ))}
              </ul>
              <p className="muted">The fee is paid when you apply and refunded if you're not approved.</p>
              <button className="btn" onClick={() => setApplying(true)}>
                Start an application
              </button>
            </section>
          )}
        </>
      )}
    </main>
  );
}

function ApplyForm({
  opts,
  kids,
  defaultSigner,
  onCancel,
  onCreated,
}: {
  opts: Options;
  kids: { id: string; firstName: string; lastName: string }[];
  defaultSigner: string;
  onCancel: () => void;
  onCreated: (a: Application) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [role, setRole] = useState<Role["key"]>("head_coach");
  const selected = opts.roles.find((r) => r.key === role)!;

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? "").trim();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ application: Application }>("/volunteer/applications", {
        roleKey: role,
        preferredDivisionId: s("preferredDivisionId") || undefined,
        playerId: s("playerId") || undefined,
        phone: s("phone"),
        experience: s("experience"),
        notes: s("notes"),
        shirtSize: s("shirtSize"),
        signerName: s("signerName"),
        acceptAgreement: f.get("acceptAgreement") === "on",
      });
      onCreated(r.application);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2>Volunteer application</h2>
      <form className="stack" onSubmit={submit}>
        <div className="toggle-row" role="radiogroup" aria-label="Role">
          {opts.roles.map((r) => (
            <button type="button" key={r.key} className="choice" aria-pressed={role === r.key} onClick={() => setRole(r.key)}>
              <strong style={{ fontSize: 26 }}>{r.label}</strong>
              <span className="muted">{r.totalCents ? `${money(r.totalCents)} fee` : "No fee"}</span>
            </button>
          ))}
        </div>
        <div className="form-row">
          <label>
            Mobile phone
            <input type="tel" name="phone" required minLength={7} maxLength={32} autoComplete="tel" />
          </label>
          <label>
            Division you'd like (optional)
            <select name="preferredDivisionId" defaultValue="">
              <option value="">No preference</option>
              {opts.divisions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-row">
          {kids.length > 0 && (
            <label>
              My child's team (optional)
              <select name="playerId" defaultValue="">
                <option value="">None</option>
                {kids.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.firstName} {k.lastName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Shirt size
            <select name="shirtSize" defaultValue="">
              <option value="">Choose…</option>
              {["AS", "AM", "AL", "AXL", "A2XL", "A3XL"].map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Coaching or volunteer experience
          <textarea name="experience" rows={3} maxLength={2000} placeholder="Teams, sports, ages, years" />
        </label>
        <label>
          Anything else we should know? (optional)
          <textarea name="notes" rows={2} maxLength={1000} placeholder="Availability, co-coach request…" />
        </label>
        {opts.agreement && (
          <div className="waiver">
            <strong style={{ fontSize: 20, color: "#fff" }}>{opts.agreement.title}</strong>
            <Markdown source={opts.agreement.body} />
            <label className="check">
              <input type="checkbox" name="acceptAgreement" required /> I have read and agree.
            </label>
          </div>
        )}
        <label>
          Your full name (electronic signature)
          <input type="text" name="signerName" required minLength={3} maxLength={120} defaultValue={defaultSigner} autoComplete="name" />
        </label>
        <ErrorAlert error={error} />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button className="btn" disabled={busy}>
            {busy ? "Saving…" : selected.totalCents ? `Continue to pay ${money(selected.totalCents)}` : "Submit application"}
          </button>
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </section>
  );
}

function PayFee({
  app,
  square,
  email,
  name,
  onDone,
}: {
  app: Application;
  square: Options["square"];
  email: string;
  name: string;
  onDone: () => void;
}) {
  const card = useRef<SquareCardHandle>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(app.paymentError);
  const [done, setDone] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const [givenName, ...rest] = name.trim().split(/\s+/);
      const token = await card.current!.tokenize({ amountCents: app.totalCents, givenName: givenName ?? "", familyName: rest.join(" "), email });
      await api.post(`/volunteer/applications/${app.id}/pay`, { sourceId: token });
      setDone("Thanks! Your application is submitted and a receipt is on its way. The league will contact you about your background check.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The payment didn't go through.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Application submitted</h2>
        <p>{done}</p>
        <button className="btn" onClick={onDone}>
          Done
        </button>
      </div>
    );
  }
  return (
    <section className="grid" style={{ alignItems: "start", marginTop: 16 }}>
      <div className="card">
        <h2>Volunteer fee</h2>
        <div className="summary">
          <div>
            <span>{app.roleLabel}</span>
            <span>{money(app.feeCents || app.totalCents)}</span>
          </div>
          {app.processingFeeCents > 0 && (
            <div>
              <span>Card processing fee</span>
              <span>{money(app.processingFeeCents)}</span>
            </div>
          )}
          <div className="total">
            <span>Total</span>
            <span>{money(app.totalCents)}</span>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          Refunded if your application isn't approved.
        </p>
        <button className="link-btn" onClick={onDone} disabled={busy}>
          Pay later
        </button>
      </div>
      <div className="card">
        <h2>Card</h2>
        {square ? (
          <>
            <SquareCard ref={card} applicationId={square.applicationId} locationId={square.locationId} environment={square.environment} onReady={setReady} />
            <ErrorAlert error={error} />
            <button className="btn" style={{ marginTop: 16 }} onClick={pay} disabled={!ready || busy}>
              {busy ? "Processing…" : `Pay ${money(app.totalCents)}`}
            </button>
          </>
        ) : (
          <div className="alert error">Online payment is temporarily unavailable. Please check back soon.</div>
        )}
      </div>
    </section>
  );
}
