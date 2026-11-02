"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError, authApi } from "@/lib/api";
import { fmtDate, fmtDateTime, money, StatusBadge } from "@/lib/format";
import { EventRow } from "@/components/event-row";
import { TicketButton } from "@/components/ticket-button";
import { Modal } from "@/components/modal";
import { GAME_STATUS, resultFor, type Game, type Practice } from "@/lib/schedule";
import { useFlags } from "@/lib/use-flags";
import { isAdmin, useMe } from "@/lib/use-me";

interface Household {
  id: string;
  displayName: string;
  phone: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
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
  team: { name: string; coach: { name: string; email: string } | null } | null;
  withdrawal: { status: "open" | "withdrawn" | "declined" | "completed"; createdAt: string; adminNote: string | null } | null;
}
interface MyTeam {
  id: string;
  name: string;
  roleKey: string;
  divisionName: string;
  seasonName: string;
  published: boolean;
}
interface MyApplication {
  id: string;
  roleKey: string;
  roleLabel: string;
  status: string;
  seasonName: string;
}

/** Parent dashboard: family, players, registrations and payment status, security. */
export default function DashboardPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [household, setHousehold] = useState<Household | null | undefined>(
    undefined,
  );
  const [editingFamily, setEditingFamily] = useState(false);

  useEffect(() => {
    if (!me) return;
    api
      .get<{ household: Household }>("/households/me")
      .then((r) => setHousehold(r.household))
      .catch((err) =>
        setHousehold(
          err instanceof ApiError && err.status === 404 ? null : undefined,
        ),
      );
  }, [me]);

  async function signOut() {
    await authApi.signOut();
    router.replace("/");
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <h1 style={{ margin: 0 }}>Welcome, {me.user.name.split(" ")[0]}</h1>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
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
            <FamilyForm submitLabel="Save" onSaved={setHousehold} create />
          )}
          {household && !editingFamily && (
            <>
              <dl className="kv">
                <dt>Family</dt>
                <dd>{household.displayName}</dd>
                <dt>Phone</dt>
                <dd>{household.phone ?? "—"}</dd>
                <dt>Address</dt>
                <dd>
                  {household.addressLine1 ? (
                    <>
                      {household.addressLine1}
                      <br />
                      {[household.city, household.state]
                        .filter(Boolean)
                        .join(", ")}{" "}
                      {household.postalCode ?? ""}
                    </>
                  ) : (
                    "—"
                  )}
                </dd>
              </dl>
              <button
                className="btn ghost small"
                style={{ marginTop: 16 }}
                onClick={() => setEditingFamily(true)}
              >
                Edit
              </button>
            </>
          )}
          {household && editingFamily && (
            <FamilyForm
              initial={household}
              submitLabel="Save changes"
              onSaved={(h) => {
                setHousehold(h);
                setEditingFamily(false);
              }}
              onCancel={() => setEditingFamily(false)}
            />
          )}
        </section>
        {household && <PlayersCard />}
        <ScheduleCard />
        {household && <RegistrationsCard />}
        {household && <WaitlistCard />}
        <StaffCard />
        <RefereeCard />
        <SecurityCard
          enabled={me.mfa.enabled}
          required={me.mfa.required === "totp"}
        />
      </div>
    </main>
  );
}

const ROLE: Record<string, string> = {
  head_coach: "Head coach",
  assistant_coach: "Assistant coach",
  team_manager: "Team mom",
};

interface TeamSchedule {
  team: { id: string; name: string; divisionName: string };
  players: string[];
  coaching: boolean;
  games: Game[];
  practices: Practice[];
}

function GameItem({ g, teamId }: { g: Game; teamId: string }) {
  const home = g.homeTeamId === teamId;
  const res = resultFor(g, teamId);
  return (
    <EventRow
      startsAt={g.startsAt}
      title={`Game ${home ? "vs" : "at"} ${home ? g.away : g.home}${res ? ` · ${res}` : ""}`}
      detail={g.location}
      struck={g.status === "cancelled"}
      badge={g.status !== "scheduled" ? <span className={`status ${GAME_STATUS[g.status].tone}`}>{GAME_STATUS[g.status].label}</span> : null}
      action={<TicketButton g={g} />}
    />
  );
}

function PracticeItem({ p }: { p: Practice }) {
  return (
    <EventRow
      startsAt={p.startsAt}
      title={`Practice · ${p.durationMinutes} min`}
      detail={`${p.location}${p.notes ? ` · ${p.notes}` : ""}`}
      struck={p.status === "cancelled"}
      badge={p.status === "cancelled" ? <span className="status bad">Cancelled</span> : null}
    />
  );
}

/**
 * The family's (or coach's) teams: the next game and next practice for each,
 * with buttons that open the full season's games or practices in a pop-up.
 */
function ScheduleCard() {
  const [items, setItems] = useState<TeamSchedule[] | null>(null);
  const [open, setOpen] = useState<{ teamId: string; kind: "games" | "practices" } | null>(null);
  useEffect(() => {
    api
      .get<{ items: TeamSchedule[] }>("/my-schedule")
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  const flags = useFlags();
  const gamesOn = !!flags?.has("r4.games");
  const practicesOn = !!flags?.has("r3.practices");
  if (!items || items.length === 0 || !flags || (!gamesOn && !practicesOn)) return null;
  // Still "next" until a few hours after it starts (covers the game in progress).
  const cutoff = Date.now() - 3 * 3600_000;
  const upcoming = <T extends { startsAt: string; status: string }>(xs: T[]) => xs.find((x) => new Date(x.startsAt).getTime() > cutoff && x.status !== "cancelled");
  const shown = open ? items.find((t) => t.team.id === open.teamId) : undefined;

  return (
    <section className="card">
      <h2>Schedule</h2>
      {items.map((t) => {
        const nextGame = upcoming(t.games);
        const nextPractice = upcoming(t.practices);
        const last = t.games.filter((g) => g.status === "final").at(-1);
        return (
          <div key={t.team.id} style={{ marginBottom: 20 }}>
            <h3 style={{ margin: "8px 0 4px" }}>
              {t.team.name}{" "}
              <span className="muted" style={{ fontSize: 16 }}>
                · {t.team.divisionName}
                {t.players.length ? ` · ${t.players.join(", ")}` : ""}
              </span>
            </h3>
            {last && (
              <p className="muted" style={{ margin: "0 0 8px" }}>
                Last game: {resultFor(last, t.team.id)} {last.homeTeamId === t.team.id ? "vs" : "at"} {last.homeTeamId === t.team.id ? last.away : last.home}
              </p>
            )}
            {!nextGame && !nextPractice ? (
              <p className="muted">Nothing coming up. Your coach adds practices here, and the league posts games after the draft.</p>
            ) : (
              <ul className="events">
                {nextPractice && (!nextGame || nextPractice.startsAt < nextGame.startsAt) && <PracticeItem p={nextPractice} />}
                {nextGame && <GameItem g={nextGame} teamId={t.team.id} />}
                {nextPractice && nextGame && nextPractice.startsAt >= nextGame.startsAt && <PracticeItem p={nextPractice} />}
              </ul>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
              {gamesOn && (
                <button className="btn ghost small" disabled={!t.games.length} onClick={() => setOpen({ teamId: t.team.id, kind: "games" })}>
                  Games ({t.games.length})
                </button>
              )}
              {practicesOn && (
                <button className="btn ghost small" disabled={!t.practices.length} onClick={() => setOpen({ teamId: t.team.id, kind: "practices" })}>
                  Practices ({t.practices.length})
                </button>
              )}
            </div>
          </div>
        );
      })}
      <Modal open={!!shown} title={shown ? `${shown.team.name} ${open!.kind === "games" ? "games" : "practices"}` : ""} onClose={() => setOpen(null)}>
        {shown && (
          <ul className="events">
            {open!.kind === "games"
              ? shown.games.map((g) => <GameItem key={g.id} g={g} teamId={shown.team.id} />)
              : shown.practices.map((p) => <PracticeItem key={p.id} p={p} />)}
          </ul>
        )}
      </Modal>
    </section>
  );
}

const APP_LINE: Record<string, string> = {
  pending_payment: "Fee not paid yet",
  processing: "Payment processing",
  submitted: "Submitted · under review",
  rejected: "Not approved",
  revoked: "Approval removed",
};

/** Coaches & team staff: application status, team assignment, and the roster once it's published. */
/** Referee sign-up or status, when the Referees switch is on. */
function RefereeCard() {
  const [home, setHome] = useState<{ application: { status: string } | null; approved: boolean; payouts: { setup: string } } | null | undefined>(undefined);
  useEffect(() => {
    api
      .get<{ application: { status: string } | null; approved: boolean; payouts: { setup: string } }>("/referees/me")
      .then(setHome)
      .catch(() => setHome(null));
  }, []);
  if (!home) return null;
  const line = home.approved
    ? home.payouts.setup === "ready"
      ? "Approved referee. Pick games and see your pay."
      : "Approved referee. Set up payouts so the league can pay you."
    : home.application?.status === "submitted"
      ? "Your referee sign-up is being reviewed."
      : "Referee NFFL games and get paid by direct deposit.";
  return (
    <section className="card">
      <h2>Referee</h2>
      <p className="muted">{line}</p>
      <Link className="btn ghost small" href="/referees">
        {home.approved ? "My referee page" : home.application?.status === "submitted" ? "View sign-up" : "Sign up to referee"}
      </Link>
    </section>
  );
}

function StaffCard() {
  const [teams, setTeams] = useState<MyTeam[] | null>(null);
  const [apps, setApps] = useState<MyApplication[] | null>(null);
  useEffect(() => {
    api
      .get<{ items: MyTeam[] }>("/my-teams")
      .then((r) => setTeams(r.items))
      .catch(() => setTeams([]));
    api
      .get<{ items: MyApplication[] }>("/volunteer/applications")
      .then((r) => setApps(r.items))
      .catch(() => setApps([]));
  }, []);
  // Approved applications not yet placed on a team, and applications still in progress.
  const waiting = (apps ?? []).filter(
    (a) =>
      a.status === "approved" &&
      !(teams ?? []).some(
        (t) => t.roleKey === a.roleKey && t.seasonName === a.seasonName,
      ),
  );
  const other = (apps ?? []).filter((a) => a.status in APP_LINE);
  const empty =
    teams?.length === 0 && waiting.length === 0 && other.length === 0;
  return (
    <section className="card">
      <h2>{teams?.length ? "My teams" : "Coaches & team staff"}</h2>
      {empty && (
        <p className="muted">Coach a team or be a team mom this season.</p>
      )}
      {teams?.length || waiting.length || other.length ? (
        <ul className="list">
          {teams?.map((t) => (
            <li key={t.id}>
              <span>
                <span className="who">{t.name}</span>
                <br />
                <span className="muted">
                  {ROLE[t.roleKey] ?? t.roleKey} · {t.divisionName} ·{" "}
                  {t.seasonName}
                  {!t.published && (
                    <>
                      <br />
                      The roster opens here after the draft.
                    </>
                  )}
                </span>
              </span>
              {t.published && (
                <Link className="btn small" href={`/my-team/${t.id}`}>
                  Roster
                </Link>
              )}
            </li>
          ))}
          {waiting.map((a) => (
            <li key={a.id}>
              <span>
                <span className="who">{a.roleLabel}</span>
                <br />
                <span className="muted">
                  {a.seasonName} · The league will put you on a team before the
                  draft.
                </span>
              </span>
              <span className="status ok">Approved</span>
            </li>
          ))}
          {other.map((a) => (
            <li key={a.id}>
              <span>
                <span className="who">{a.roleLabel}</span>
                <br />
                <span className="muted">{a.seasonName}</span>
              </span>
              <Link className="status muted" href="/coaches-staff">
                {APP_LINE[a.status]}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <Link
        className="btn ghost small"
        href="/coaches-staff"
        style={{ marginTop: 12 }}
      >
        {apps?.length ? "Applications" : "Apply"}
      </Link>
    </section>
  );
}

/** Create or edit the family's details. Empty optional fields are cleared. */
function FamilyForm({
  initial,
  submitLabel,
  onSaved,
  onCancel,
  create,
}: {
  initial?: Household;
  submitLabel: string;
  onSaved: (h: Household) => void;
  onCancel?: () => void;
  create?: boolean;
}) {
  const { busy, error, run } = useAction();
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (k: string) => String(f.get(k) ?? "").trim();
    const body = {
      displayName: v("displayName"),
      phone: v("phone"),
      addressLine1: v("addressLine1"),
      city: v("city"),
      state: v("state"),
      postalCode: v("postalCode"),
    };
    const res = await run(() =>
      create
        ? api.post<{ household: Household }>("/households", body)
        : api.patch<{ household: Household }>("/households/me", body),
    );
    if (res) onSaved(res.household);
  }
  return (
    <form className="stack" onSubmit={onSubmit}>
      <ErrorAlert error={error} />
      <label>
        Family name (as you'd like it shown)
        <input
          type="text"
          name="displayName"
          required
          maxLength={120}
          placeholder="The Smith Family"
          defaultValue={initial?.displayName ?? ""}
        />
      </label>
      <label>
        Mobile phone
        <input
          type="tel"
          name="phone"
          autoComplete="tel"
          maxLength={32}
          defaultValue={initial?.phone ?? ""}
        />
      </label>
      <label>
        Street address (optional)
        <input
          type="text"
          name="addressLine1"
          autoComplete="address-line1"
          maxLength={200}
          defaultValue={initial?.addressLine1 ?? ""}
        />
      </label>
      <div className="form-row">
        <label>
          City
          <input
            type="text"
            name="city"
            autoComplete="address-level2"
            maxLength={100}
            defaultValue={initial?.city ?? ""}
          />
        </label>
        <label>
          State
          <input
            type="text"
            name="state"
            autoComplete="address-level1"
            maxLength={2}
            placeholder="FL"
            defaultValue={initial?.state ?? ""}
          />
        </label>
        <label>
          ZIP
          <input
            type="text"
            inputMode="numeric"
            name="postalCode"
            autoComplete="postal-code"
            maxLength={10}
            defaultValue={initial?.postalCode ?? ""}
          />
        </label>
      </div>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button className="btn" disabled={busy}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
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
  const reload = () =>
    api
      .get<{ items: Reg[] }>("/registrations")
      .then((r) => setRegs(r.items))
      .catch(() => setRegs([]));
  useEffect(() => {
    void reload();
    api
      .get<{ enabled: boolean; window: { open: boolean } }>(
        "/registration/options",
      )
      .then((o) => setOpen(o.enabled && o.window.open))
      .catch(() => setOpen(false));
  }, []);
  return (
    <section className="card">
      <h2>Registrations</h2>
      {!regs ? (
        <p className="muted">Loading…</p>
      ) : regs.length === 0 ? (
        <p className="muted">
          {open
            ? "Registration is open."
            : "Registration isn't open yet. You can add your players now."}
        </p>
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
                  {r.payment?.refundedCents
                    ? ` · ${money(r.payment.refundedCents)} refunded`
                    : ""}
                </span>
                {r.team && (
                  <>
                    <br />
                    <span>
                      <strong>Team: {r.team.name}</strong>
                      {r.team.coach && (
                        <>
                          {" · Coach "}
                          {r.team.coach.name} (
                          <a href={`mailto:${r.team.coach.email}`}>
                            {r.team.coach.email}
                          </a>
                          )
                        </>
                      )}
                    </span>
                  </>
                )}
                {r.status === "rejected" && r.decisionReason && (
                  <>
                    <br />
                    <span className="muted">Reason: {r.decisionReason}</span>
                  </>
                )}
                {(r.status === "paid" || r.status === "approved") && <Withdraw r={r} onChange={reload} />}
              </span>
              <span
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <StatusBadge status={r.status} />
                {(r.status === "pending_payment" || r.status === "expired") &&
                  open && (
                    <Link
                      className="btn small"
                      href={`/register?registration=${r.id}`}
                    >
                      Finish payment
                    </Link>
                  )}
                {r.payment?.receiptUrl && (
                  <a
                    href={r.payment.receiptUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
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

interface WaitlistItem {
  id: string;
  status: "waiting" | "offered" | "expired";
  playerName: string;
  playerLastName: string;
  divisionName: string;
  offerExpiresAt: string | null;
  position: number | null;
}

/** Shown only when the family is on a waitlist (or had an offer expire). */
function WaitlistCard() {
  const [items, setItems] = useState<WaitlistItem[] | null>(null);
  const load = () =>
    api
      .get<{ items: WaitlistItem[] }>("/waitlist")
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  useEffect(() => {
    void load();
  }, []);
  async function leave(id: string) {
    if (!window.confirm("Leave the waitlist? You'll lose your place in line."))
      return;
    await api.post(`/waitlist/${id}/leave`).catch(() => undefined);
    void load();
  }
  if (!items || items.length === 0) return null;
  return (
    <section className="card">
      <h2>Waitlist</h2>
      <ul className="list">
        {items.map((w) => (
          <li key={w.id}>
            <span>
              <span className="who">
                {w.playerName} {w.playerLastName}
              </span>
              <br />
              <span className="muted">
                {w.divisionName}
                {w.status === "waiting" && ` · #${w.position} in line`}
                {w.status === "offered" &&
                  w.offerExpiresAt &&
                  ` · claim by ${fmtDateTime(w.offerExpiresAt)}`}
                {w.status === "expired" && " · offer expired"}
              </span>
            </span>
            <span
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              {w.status === "offered" && (
                <Link className="btn small" href={`/register?offer=${w.id}`}>
                  Claim the spot
                </Link>
              )}
              {w.status === "waiting" && (
                <span className="status info">Waiting</span>
              )}
              {w.status !== "expired" && (
                <button className="link-btn" onClick={() => leave(w.id)}>
                  {w.status === "offered" ? "Decline" : "Leave"}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Optional two-step sign-in: turn on (choose method) or off (needs password). */
function SecurityCard({
  enabled,
  required,
}: {
  enabled: boolean;
  required: boolean;
}) {
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
          <p className="muted">
            Optional. Adds a code check when you sign in on a new device.
          </p>
          <Link className="btn ghost" href="/setup-mfa">
            Turn on
          </Link>
        </>
      )}
      {on && required && (
        <p className="muted">Required by the league for your role.</p>
      )}
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
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
            />
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" disabled={busy}>
              Turn off
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Ask the league to withdraw a paid registration, or take an open request back. */
function Withdraw({ r, onChange }: { r: Reg; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const w = r.withdrawal;

  if (w?.status === "open")
    return (
      <span style={{ display: "block", marginTop: 8 }}>
        <span className="status warn">Withdrawal requested</span>{" "}
        <span className="muted">{fmtDate(w.createdAt)} · the league will email you.</span>{" "}
        <button
          type="button"
          className="link-btn"
          disabled={busy}
          onClick={async () => {
            if (window.confirm(`Take back your request to withdraw ${r.playerName}?`) && (await run(() => api.del(`/registrations/${r.id}/withdrawal`))) !== undefined) onChange();
          }}
        >
          Take back
        </button>
        <ErrorAlert error={error} />
      </span>
    );

  return (
    <span style={{ display: "block", marginTop: 8 }}>
      {w?.status === "declined" && w.adminNote && (
        <span className="muted" style={{ display: "block" }}>
          Withdrawal not approved: {w.adminNote}
        </span>
      )}
      {!asking ? (
        <button type="button" className="link-btn" onClick={() => setAsking(true)}>
          Request to withdraw
        </button>
      ) : (
        <form
          className="stack"
          style={{ marginTop: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if ((await run(() => api.post(`/registrations/${r.id}/withdrawal`, { reason: reason || null }))) !== undefined) {
              setAsking(false);
              setReason("");
              onChange();
            }
          }}
        >
          <ErrorAlert error={error} />
          <label>
            Reason <span className="muted">(optional)</span>
            <textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. We're moving out of the area" />
          </label>
          <p className="muted" style={{ margin: 0, fontSize: 15 }}>
            The league reviews each request and emails you, including whether a refund applies. {r.playerName} stays registered until then.
          </p>
          <span style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn small" disabled={busy}>
              Send request
            </button>
            <button type="button" className="btn ghost small" onClick={() => setAsking(false)}>
              Cancel
            </button>
          </span>
        </form>
      )}
    </span>
  );
}
