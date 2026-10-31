"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtDate, fmtDateTime } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Team {
  id: string;
  name: string;
}
interface RosterRow {
  id: string;
  teamId: string;
  source: "coach_child" | "draft" | "admin";
  pickNumber: number | null;
  registrationId: string;
  firstName: string;
  lastName: string;
  birthDate: string;
}
interface Available {
  registrationId: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
  birthDate: string;
  school: string | null;
}
interface Slot {
  pick: number;
  round: number;
  teamId: string;
}
interface Board {
  division: { id: string; name: string };
  draft: { status: "setup" | "live" | "complete"; order: string[]; publishedAt: string | null; completedAt: string | null };
  teams: Team[];
  roster: RosterRow[];
  available: Available[];
  awaitingReview: number;
  current: Slot | null;
  lastPick: number;
  holes: number;
}

const age = (birth: string) => {
  const b = new Date(`${birth}T12:00:00`);
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--;
  return a;
};

/** The draft for one division: set the order, run it live (in the room), then publish rosters. */
export default function DraftPage() {
  const { divisionId } = useParams<{ divisionId: string }>();
  const router = useRouter();
  const { me, loading } = useMe();
  const [b, setB] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only the newest response is applied, so a slow poll can't put an old board back.
  const seq = useRef(0);
  const apply = useCallback((board: Board, n: number) => {
    if (n >= applied.current) {
      applied.current = n;
      setB(board);
    }
  }, []);
  const applied = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    api
      .get<Board>(`/admin/teams/divisions/${divisionId}/draft`)
      .then((board) => apply(board, n))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load the draft.");
      });
  }, [divisionId, router, apply]);

  useEffect(() => {
    if (me) load();
  }, [me, load]);

  // Keep other screens (e.g. a projector) in sync while the draft is live.
  useEffect(() => {
    if (b?.draft.status !== "live") return;
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [b?.draft.status, load]);

  async function act<T>(fn: () => Promise<T>) {
    setBusy(true);
    setError(null);
    try {
      const n = ++seq.current;
      const r = await fn();
      if (r && typeof r === "object" && "draft" in (r as object)) apply(r as unknown as Board, n);
      else load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      load();
    } finally {
      setBusy(false);
    }
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;
  if (!b) return <main className="page">{error ? <ErrorAlert error={error} /> : <p className="muted">Loading…</p>}</main>;
  const teamName = (id: string) => b.teams.find((t) => t.id === id)?.name ?? "—";

  return (
    <main className="page" style={{ maxWidth: 1400 }}>
      <p>
        <Link href="/admin/teams">← Teams & draft</Link>
      </p>
      <h1>{b.division.name} draft</h1>
      <ErrorAlert error={error} />
      {b.awaitingReview > 0 && b.draft.status !== "complete" && (
        <div className="alert error" style={{ marginBottom: 16 }}>
          {b.awaitingReview} registration{b.awaitingReview === 1 ? " is" : "s are"} still awaiting review. Only approved players can be drafted.
        </div>
      )}

      {b.draft.status === "live" && b.holes > 0 && (
        <div className="alert error" style={{ marginBottom: 16 }}>
          {b.holes} earlier pick{b.holes === 1 ? " was" : "s were"} removed (registration cancelled or rejected). The draft keeps going; add
          players to short teams after it's finished.
        </div>
      )}
      {b.draft.status === "setup" && <Setup b={b} busy={busy} act={act} divisionId={divisionId} />}
      {b.draft.status === "live" && <Live b={b} busy={busy} act={act} divisionId={divisionId} teamName={teamName} />}
      {b.draft.status !== "setup" && <Rosters b={b} busy={busy} act={act} divisionId={divisionId} />}
    </main>
  );
}

type Act = <T>(fn: () => Promise<T>) => Promise<void>;

function Setup({ b, busy, act, divisionId }: { b: Board; busy: boolean; act: Act; divisionId: string }) {
  const [order, setOrder] = useState<string[]>(b.draft.order);
  useEffect(() => setOrder(b.draft.order), [b.draft.order]);
  const name = (id: string) => b.teams.find((t) => t.id === id)?.name ?? "—";
  const kids = (id: string) => b.roster.filter((r) => r.teamId === id && r.source === "coach_child");
  const move = (i: number, d: -1 | 1) => {
    const o = [...order];
    const j = i + d;
    if (j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j]!, o[i]!];
    setOrder(o);
  };
  const randomize = () => {
    const o = [...order];
    for (let i = o.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [o[i], o[j]] = [o[j]!, o[i]!];
    }
    setOrder(o);
  };
  const changed = order.join() !== b.draft.order.join();
  return (
    <section className="card">
      <h2>Draft order</h2>
      <p className="muted">
        Round 1 goes in this order; round 2 reverses it (snake), and so on. Coaches' and team moms' own children (★) fill their team's first
        rounds. {b.available.length} players are ready to draft.
      </p>
      {b.teams.length < 2 ? (
        <p className="muted">Add at least two teams on the Teams page first.</p>
      ) : (
        <>
          <ol className="list" style={{ listStyle: "none" }}>
            {order.map((id, i) => (
              <li key={id}>
                <span>
                  <span className="who">
                    {i + 1}. {name(id)}
                  </span>
                  {kids(id).length > 0 && (
                    <>
                      <br />
                      <span className="muted">★ {kids(id).map((k) => `${k.firstName} ${k.lastName}`).join(", ")}</span>
                    </>
                  )}
                </span>
                <span style={{ display: "flex", gap: 8 }}>
                  <button className="btn ghost small" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${name(id)} up`}>
                    ↑
                  </button>
                  <button className="btn ghost small" onClick={() => move(i, 1)} disabled={i === order.length - 1} aria-label={`Move ${name(id)} down`}>
                    ↓
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
            <button className="btn ghost" onClick={randomize} disabled={busy}>
              Randomize
            </button>
            <button className="btn ghost" onClick={() => act(() => api.put(`/admin/teams/divisions/${divisionId}/draft/order`, { order }))} disabled={busy || !changed}>
              Save order
            </button>
            <button
              className="btn"
              disabled={busy || changed}
              onClick={() => {
                if (window.confirm("Start the draft? The order and teams lock once it starts.")) void act(() => api.post(`/admin/teams/divisions/${divisionId}/draft/start`));
              }}
            >
              Start the draft
            </button>
          </div>
          {changed && <p className="hint">Save the order before starting.</p>}
        </>
      )}
    </section>
  );
}

function Live({ b, busy, act, divisionId, teamName }: { b: Board; busy: boolean; act: Act; divisionId: string; teamName: (id: string) => string }) {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"name" | "age">("name");
  // A selection belongs to one pick and team; if the clock moves, it's dropped.
  const [sel, setSel] = useState<{ p: Available; pick: number; teamId: string } | null>(null);
  const selected = sel && b.current && sel.pick === b.current.pick ? sel.p : null;
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const rows = b.available.filter((p) => !s || `${p.firstName} ${p.lastName} ${p.preferredName ?? ""}`.toLowerCase().includes(s));
    return sort === "age" ? [...rows].sort((x, y) => x.birthDate.localeCompare(y.birthDate)) : rows;
  }, [b.available, q, sort]);
  const recent = [...b.roster].filter((r) => r.source === "draft").sort((x, y) => (y.pickNumber ?? 0) - (x.pickNumber ?? 0)).slice(0, 6);
  const cur = b.current;

  useEffect(() => {
    if (sel && (!b.current || sel.pick !== b.current.pick || !b.available.some((a) => a.registrationId === sel.p.registrationId))) setSel(null);
  }, [b.current, b.available, sel]);

  return (
    <>
      <section className="card" style={{ borderTopColor: "var(--gold)", textAlign: "center" }}>
        {cur ? (
          <>
            <p className="muted" style={{ margin: 0, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              On the clock · Round {cur.round} · Pick {cur.pick}
            </p>
            <p style={{ margin: "4px 0 0", fontFamily: "var(--font-display)", fontSize: "clamp(48px, 8vw, 96px)", lineHeight: 1, color: "var(--gold)" }}>
              {teamName(cur.teamId)}
            </p>
          </>
        ) : (
          <p style={{ margin: 0, fontSize: 24 }}>All players have been drafted.</p>
        )}
        {selected && cur && sel && (
          <div style={{ marginTop: 16, display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 20 }}>
              Draft <strong>{selected.firstName} {selected.lastName}</strong> to <strong>{teamName(sel.teamId)}</strong>?
            </span>
            <button
              className="btn"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  const r = await api.post(`/admin/teams/divisions/${divisionId}/draft/pick`, { registrationId: sel.p.registrationId, expectedPick: sel.pick });
                  setSel(null);
                  return r;
                })
              }
            >
              Confirm pick
            </button>
            <button className="btn ghost" onClick={() => setSel(null)}>
              Cancel
            </button>
          </div>
        )}
      </section>

      <div className="grid" style={{ marginTop: 24, alignItems: "start" }}>
        <section className="card">
          <h2>Available ({b.available.length})</h2>
          <div className="filters" style={{ margin: "8px 0" }}>
            <label>
              Search
              <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Player name" />
            </label>
            <label>
              Sort
              <select value={sort} onChange={(e) => setSort(e.target.value as "name" | "age")}>
                <option value="name">Last name</option>
                <option value="age">Oldest first</option>
              </select>
            </label>
          </div>
          <ul className="list">
            {list.map((p) => (
              <li key={p.registrationId} style={selected?.registrationId === p.registrationId ? { outline: "2px solid var(--lime)" } : undefined}>
                <span>
                  <span className="who">
                    {p.firstName} {p.lastName}
                  </span>
                  {p.preferredName ? <span className="muted"> “{p.preferredName}”</span> : null}
                  <br />
                  <span className="muted">
                    Age {age(p.birthDate)} · born {fmtDate(p.birthDate)}
                    {p.school ? ` · ${p.school}` : ""}
                  </span>
                </span>
                <button className="btn small" disabled={!cur || busy} onClick={() => cur && setSel({ p, pick: cur.pick, teamId: cur.teamId })}>
                  Select
                </button>
              </li>
            ))}
            {list.length === 0 && <li className="muted">No players match.</li>}
          </ul>
        </section>

        <section className="card">
          <h2>Recent picks</h2>
          {recent.length === 0 ? (
            <p className="muted">No picks yet.</p>
          ) : (
            <ul className="list">
              {recent.map((r) => (
                <li key={r.id}>
                  <span>
                    <span className="who">
                      #{r.pickNumber} {r.firstName} {r.lastName}
                    </span>
                    <br />
                    <span className="muted">{teamName(r.teamId)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
            <button
              className="btn ghost"
              disabled={busy || recent.length === 0}
              onClick={() => {
                if (window.confirm(`Undo pick #${recent[0]?.pickNumber} (${recent[0]?.firstName} ${recent[0]?.lastName})?`)) void act(() => api.post(`/admin/teams/divisions/${divisionId}/draft/undo`, { expectedPick: recent[0]?.pickNumber }));
              }}
            >
              Undo last pick
            </button>
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => {
                const msg = b.available.length
                  ? `${b.available.length} player(s) haven't been drafted. Finish anyway? You can add them to teams afterwards.`
                  : "Finish the draft?";
                if (window.confirm(msg)) void act(() => api.post(`/admin/teams/divisions/${divisionId}/draft/complete`));
              }}
            >
              Finish draft
            </button>
          </div>
        </section>
      </div>
    </>
  );
}

function Rosters({ b, busy, act, divisionId }: { b: Board; busy: boolean; act: Act; divisionId: string }) {
  const order = b.draft.order.length ? b.draft.order : b.teams.map((t) => t.id);
  const editable = b.draft.status === "complete";
  const [addTo, setAddTo] = useState<Record<string, string>>({});
  return (
    <section style={{ marginTop: 24 }}>
      {b.draft.status === "complete" && (
        <div className="card" style={{ marginBottom: 24 }}>
          {b.draft.publishedAt ? (
            <p style={{ margin: 0 }}>
              <span className="status ok">Published</span> <span className="muted">{fmtDateTime(b.draft.publishedAt)} · coaches and families can see their teams.</span>
            </p>
          ) : (
            <>
              <h2>Publish rosters</h2>
              <p className="muted">
                Check the teams below, make any moves, then publish. Coaches get access to their roster and every family is emailed their child's
                team and head coach.
              </p>
              <button
                className="btn"
                disabled={busy}
                onClick={() => {
                  if (window.confirm("Publish rosters and email every family?")) void act(() => api.post(`/admin/teams/divisions/${divisionId}/draft/publish`));
                }}
              >
                Publish rosters
              </button>
            </>
          )}
        </div>
      )}
      <div className="grid">
        {order.map((teamId) => {
          const t = b.teams.find((x) => x.id === teamId);
          if (!t) return null;
          const rows = b.roster.filter((r) => r.teamId === teamId).sort((x, y) => (x.pickNumber ?? 0) - (y.pickNumber ?? 0));
          return (
            <section key={teamId} className="card">
              <h2>
                {t.name} <span className="muted" style={{ fontSize: 20 }}>({rows.length})</span>
              </h2>
              <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                {rows.map((r) => (
                  <li key={r.id} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
                    <span>
                      {r.source === "coach_child" ? "★ " : r.pickNumber ? `#${r.pickNumber} ` : "+ "}
                      {r.firstName} {r.lastName}
                    </span>
                    {editable && (
                      <select
                        aria-label={`Move ${r.firstName} ${r.lastName}`}
                        value=""
                        disabled={busy}
                        style={{ width: "auto", minHeight: 36, padding: "4px 8px", fontSize: 15 }}
                        onChange={(e) => {
                          const to = e.target.value;
                          if (to === "__remove") {
                            if (window.confirm(`Take ${r.firstName} ${r.lastName} off ${b.teams.find((x) => x.id === teamId)?.name}? They go back to "Not on a team". No email is sent.`))
                              void act(() => api.del(`/admin/teams/roster/${r.id}`));
                          } else if (to && window.confirm(`Move ${r.firstName} to ${b.teams.find((x) => x.id === to)?.name}?`)) void act(() => api.post(`/admin/teams/roster/${r.id}/move`, { teamId: to }));
                        }}
                      >
                        <option value="">Move or remove…</option>
                        {b.teams
                          .filter((x) => x.id !== teamId)
                          .map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        <option value="__remove">Remove from team</option>
                      </select>
                    )}
                  </li>
                ))}
                {rows.length === 0 && <li className="muted">No players yet.</li>}
              </ul>
            </section>
          );
        })}
      </div>
      {editable && b.available.length > 0 && (
        <section className="card" style={{ marginTop: 24 }}>
          <h2>Not on a team ({b.available.length})</h2>
          <p className="muted">Approved after the draft, or left over. Add each to a team.</p>
          <ul className="list">
            {b.available.map((p) => (
              <li key={p.registrationId}>
                <span className="who">
                  {p.firstName} {p.lastName}
                </span>
                <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <select value={addTo[p.registrationId] ?? ""} onChange={(e) => setAddTo({ ...addTo, [p.registrationId]: e.target.value })} style={{ width: "auto" }} aria-label={`Team for ${p.firstName}`}>
                    <option value="">Choose team…</option>
                    {b.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn small"
                    disabled={busy || !addTo[p.registrationId]}
                    onClick={() => act(() => api.post(`/admin/teams/teams/${addTo[p.registrationId]}/roster`, { registrationId: p.registrationId }))}
                  >
                    Add
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
