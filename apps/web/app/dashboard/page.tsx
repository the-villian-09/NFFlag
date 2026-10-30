"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError, authApi } from "@/lib/api";
import { fmtDate, money, StatusBadge } from "@/lib/format";
import { isAdmin, useMe } from "@/lib/use-me";

interface Household {
  id: string;
  displayName: string;
  phone: string | null;
}

interface Player {
  id: string;
  firstName: string;
  lastName: string;
  birthDate: string;
}
interface Reg {
  id: string;
  status: string;
  playerName: string;
  playerLastName: string;
  divisionName: string;
  seasonName: string;
  totalCents: number;
  decisionReason: string | null;
  payment: { receiptUrl: string | null; refundedCents: number } | null;
}

/** Parent dashboard: family, players, registrations and payment status, security. */
export default function DashboardPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [household, setHousehold] = useState<Household | null | undefined>(undefined);
  const { busy, error, run } = useAction();

  useEffect(() => {
    if (!me) return;
    api
      .get<{ household: Household }>("/households/me")
      .then((r) => setHousehold(r.household))
      .catch((err) => setHousehold(err instanceof ApiError && err.status === 404 ? null : undefined));
  }, [me]);

  async function createHousehold(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const res = await run(() =>
      api.post<{ household: Household }>("/households", {
        displayName: String(f.get("displayName")),
        phone: String(f.get("phone") || "") || undefined,
      }),
    );
    if (res) setHousehold(res.household);
  }

  async function signOut() {
    await authApi.signOut();
    router.replace("/");
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0 }}>Welcome, {me.user.name.split(" ")[0]}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {isAdmin(me) && (
            <Link className="btn accent" href="/admin">
              Admin portal
            </Link>
          )}
          <button className="btn ghost" onClick={signOut}>
            Sign out
          </button>
        </div>
      </div>

      <div className="grid" style={{ marginTop: 24 }}>
        <section className="card">
          <h2>Your family</h2>
          {household === undefined && <p className="muted">Loading…</p>}
          {household === null && (
            <form className="stack" onSubmit={createHousehold}>
              <ErrorAlert error={error} />
              <label>
                Family name (as you'd like it shown)
                <input type="text" name="displayName" required maxLength={120} placeholder="The Smith Family" />
              </label>
              <label>
                Mobile phone
                <input type="text" name="phone" autoComplete="tel" maxLength={32} />
              </label>
              <button className="btn" disabled={busy}>
                Save
              </button>
            </form>
          )}
          {household && (
            <p>
              <strong>{household.displayName}</strong>
              {household.phone ? <><br />{household.phone}</> : null}
            </p>
          )}
        </section>
        {household && <PlayersCard />}
        {household && <RegistrationsCard />}
        <SecurityCard enabled={me.mfa.enabled} required={me.mfa.required === "totp"} />
      </div>
    </main>
  );
}

function PlayersCard() {
  const [players, setPlayers] = useState<Player[] | null>(null);
  useEffect(() => {
    api
      .get<{ items: Player[] }>("/players")
      .then((r) => setPlayers(r.items))
      .catch(() => setPlayers([]));
  }, []);
  return (
    <section className="card">
      <h2>Players</h2>
      {!players ? (
        <p className="muted">Loading…</p>
      ) : players.length === 0 ? (
        <p className="muted">Add each child who will play.</p>
      ) : (
        <ul className="list">
          {players.map((p) => (
            <li key={p.id}>
              <span>
                <span className="who">
                  {p.firstName} {p.lastName}
                </span>
                <br />
                <span className="muted">Born {fmtDate(p.birthDate)}</span>
              </span>
              <Link className="btn ghost small" href={`/players/${p.id}`}>
                Edit
              </Link>
            </li>
          ))}
        </ul>
      )}
      <p style={{ marginTop: 16 }}>
        <Link className="btn ghost small" href="/players/new">
          + Add a player
        </Link>
      </p>
    </section>
  );
}

function RegistrationsCard() {
  const [regs, setRegs] = useState<Reg[] | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .get<{ items: Reg[] }>("/registrations")
      .then((r) => setRegs(r.items))
      .catch(() => setRegs([]));
    api
      .get<{ enabled: boolean; window: { open: boolean } }>("/registration/options")
      .then((o) => setOpen(o.enabled && o.window.open))
      .catch(() => setOpen(false));
  }, []);
  return (
    <section className="card">
      <h2>Registrations</h2>
      {!regs ? (
        <p className="muted">Loading…</p>
      ) : regs.length === 0 ? (
        <p className="muted">{open ? "Registration is open." : "Registration isn't open yet. You can add your players now."}</p>
      ) : (
        <ul className="list">
          {regs.map((r) => (
            <li key={r.id}>
              <span>
                <span className="who">
                  {r.playerName} {r.playerLastName}
                </span>
                <br />
                <span className="muted">
                  {r.divisionName} · {r.seasonName} · {money(r.totalCents)}
                  {r.payment?.refundedCents ? ` · ${money(r.payment.refundedCents)} refunded` : ""}
                </span>
                {r.status === "rejected" && r.decisionReason && (
                  <>
                    <br />
                    <span className="muted">Reason: {r.decisionReason}</span>
                  </>
                )}
              </span>
              <span style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <StatusBadge status={r.status} />
                {(r.status === "pending_payment" || r.status === "expired") && open && (
                  <Link className="btn small" href={`/register?registration=${r.id}`}>
                    Finish payment
                  </Link>
                )}
                {r.payment?.receiptUrl && (
                  <a href={r.payment.receiptUrl} target="_blank" rel="noopener noreferrer">
                    Receipt
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <p style={{ marginTop: 16 }}>
          <Link className="btn" href="/register">
            Register a player
          </Link>
        </p>
      )}
    </section>
  );
}

/** Optional two-step sign-in: turn on (choose method) or off (needs password). */
function SecurityCard({ enabled, required }: { enabled: boolean; required: boolean }) {
  const { busy, error, run } = useAction();
  const [on, setOn] = useState(enabled);
  const [confirming, setConfirming] = useState(false);

  async function turnOff(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password"));
    if ((await run(() => authApi.disableTwoStep(password))) !== undefined) {
      setOn(false);
      setConfirming(false);
    }
  }

  return (
    <section className="card">
      <h2>Security</h2>
      <p>
        Two-step sign-in: <strong>{on ? "On" : "Off"}</strong>
      </p>
      {!on && (
        <>
          <p className="muted">Optional. Adds a code check when you sign in on a new device.</p>
          <Link className="btn ghost" href="/setup-mfa">
            Turn on
          </Link>
        </>
      )}
      {on && required && <p className="muted">Required by the league for your role.</p>}
      {on && !required && !confirming && (
        <button className="btn ghost" onClick={() => setConfirming(true)}>
          Turn off
        </button>
      )}
      {on && !required && confirming && (
        <form className="stack" onSubmit={turnOff}>
          <ErrorAlert error={error} />
          <label>
            Confirm your password
            <input type="password" name="password" autoComplete="current-password" required />
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" disabled={busy}>
              Turn off
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
