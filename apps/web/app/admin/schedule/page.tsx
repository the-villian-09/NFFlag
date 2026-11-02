"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { fmtWhen, GAME_STATUS, type Game } from "@/lib/schedule";
import { useMe } from "@/lib/use-me";

interface Season {
  id: string;
  name: string;
  isCurrent: string | null;
}
interface Division {
  id: string;
  name: string;
  teams: { id: string; name: string }[];
}
interface ImportResult {
  rows: { line: number; date: string; time: string; division: string; home: string; away: string; location: string; error?: string; duplicate?: boolean }[];
  errors: number;
  duplicates: number;
  ready: number;
  added: number;
}

/** Admin: games for a season — add one, import a spreadsheet, edit, cancel, and enter final scores. */
export default function AdminSchedulePage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState("");
  const [divFilter, setDivFilter] = useState("");
  const [data, setData] = useState<{ divisions: Division[]; games: Game[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canScore = me?.permissions.includes("scores.enter");

  useEffect(() => {
    if (!me) return;
    api
      .get<{ items: Season[] }>("/admin/league/seasons")
      .then((r) => {
        setSeasons(r.items);
        setSeasonId((r.items.find((s) => s.isCurrent) ?? r.items[0])?.id ?? "");
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [me, router]);

  const load = useCallback(() => {
    if (!seasonId) return;
    api
      .get<{ divisions: Division[]; games: Game[] }>(`/admin/schedule/seasons/${seasonId}`)
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load the schedule.");
      });
  }, [seasonId, router]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const games = data?.games.filter((g) => !divFilter || g.divisionId === divFilter) ?? [];
  const divName = (id: string) => data?.divisions.find((d) => d.id === id)?.name ?? "";

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Schedule & scores</h1>
      <p className="muted">
        All times are Eastern Time. Final scores update the <Link href="/schedule">public standings</Link> within a minute.
      </p>
      <ErrorAlert error={error} />
      <div className="filters">
        <label>
          Season
          <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)}>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Division
          <select value={divFilter} onChange={(e) => setDivFilter(e.target.value)}>
            <option value="">All divisions</option>
            {data?.divisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {data && (
        <>
          <div className="grid" style={{ marginTop: 16, alignItems: "start" }}>
            <AddGame divisions={data.divisions} onDone={load} />
            <ImportGames seasonId={seasonId} divisions={data.divisions} onDone={load} />
          </div>
          <section className="card" style={{ marginTop: 24 }}>
            <h2>Games ({games.length})</h2>
            {games.length === 0 ? (
              <p className="muted">No games yet. Add one above or import a spreadsheet.</p>
            ) : (
              <ul className="list">
                {games.map((g) => (
                  <GameRow key={g.id} g={g} division={data.divisions.find((d) => d.id === g.divisionId)} divName={divName(g.divisionId)} canScore={!!canScore} onDone={load} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function AddGame({ divisions, onDone }: { divisions: Division[]; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [f, setF] = useState({ divisionId: "", homeTeamId: "", awayTeamId: "", startsAt: "", location: "", notes: "", ticketUrl: "" });
  const [ok, setOk] = useState(false);
  const teams = divisions.find((d) => d.id === f.divisionId)?.teams ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setOk(false);
    const r = await run(() => api.post("/admin/schedule/games", { ...f, notes: f.notes || null, ticketUrl: f.ticketUrl.trim() || null }));
    if (r) {
      setOk(true);
      // Keep division, time and place: the next game is usually right after.
      setF({ ...f, homeTeamId: "", awayTeamId: "", notes: "", ticketUrl: "" });
      onDone();
    }
  }

  return (
    <section className="card">
      <h2>Add a game</h2>
      <form className="stack" onSubmit={submit}>
        <ErrorAlert error={error} />
        {ok && <div className="alert ok">Game added.</div>}
        <label>
          Division
          <select required value={f.divisionId} onChange={(e) => setF({ ...f, divisionId: e.target.value, homeTeamId: "", awayTeamId: "" })}>
            <option value="">Choose…</option>
            {divisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <div className="form-row">
          <label>
            Home
            <select required value={f.homeTeamId} onChange={(e) => setF({ ...f, homeTeamId: e.target.value })}>
              <option value="">Team…</option>
              {teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Away
            <select required value={f.awayTeamId} onChange={(e) => setF({ ...f, awayTeamId: e.target.value })}>
              <option value="">Team…</option>
              {teams
                .filter((t) => t.id !== f.homeTeamId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
          </label>
        </div>
        <label>
          Date and time
          <input type="datetime-local" required value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
        </label>
        <label>
          Location
          <input type="text" required maxLength={200} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="e.g. Hendricks Park, Field 2" />
        </label>
        <label>
          Notes for the teams <span className="muted">(optional, not public)</span>
          <input type="text" maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <label>
          Ticket link <span className="muted">(optional; shows a Buy tickets button)</span>
          <input type="url" inputMode="url" maxLength={500} value={f.ticketUrl} onChange={(e) => setF({ ...f, ticketUrl: e.target.value })} placeholder="https://…" pattern="https://.*" title="Starts with https://" />
        </label>
        <button className="btn" disabled={busy}>
          Add game
        </button>
      </form>
    </section>
  );
}

function ImportGames({ seasonId, divisions, onDone }: { seasonId: string; divisions: Division[]; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [csv, setCsv] = useState("");
  const [result, setResult] = useState<ImportResult | null>(null);

  const template = useMemo(() => {
    const d = divisions.find((x) => x.teams.length >= 2);
    const a = d?.teams[0]?.name ?? "Sharks";
    const b = d?.teams[1]?.name ?? "Jets";
    const rows = ["Date,Time,Division,Home,Away,Location,Notes,Tickets", `1/16/2027,9:00 AM,${d?.name ?? "8U"},${a},${b},Field 1,,https://`];
    return `data:text/csv;charset=utf-8,${encodeURIComponent(rows.join("\n"))}`;
  }, [divisions]);

  async function check(dryRun: boolean) {
    const r = await run(() => api.post<ImportResult>(`/admin/schedule/seasons/${seasonId}/import`, { csv, dryRun }));
    if (r) {
      setResult(r);
      if (!dryRun && r.added) {
        setCsv("");
        onDone();
      }
    }
  }

  return (
    <section className="card">
      <h2>Import a spreadsheet</h2>
      <p className="muted">
        Save as CSV with columns <strong>Date, Time, Division, Home, Away, Location</strong> (Notes and Tickets optional; Tickets is the ticket link). Team and division names must match the
        site. <a href={template} download="nffl-games-template.csv">Download a template</a>.
      </p>
      <ErrorAlert error={error} />
      <div className="stack" style={{ display: "grid", gap: 12 }}>
        <input
          type="file"
          accept=".csv,text/csv"
          aria-label="CSV file"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            setResult(null);
            if (file) setCsv(await file.text());
          }}
        />
        <textarea rows={5} value={csv} onChange={(e) => (setCsv(e.target.value), setResult(null))} placeholder="…or paste the CSV here" aria-label="CSV text" />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <button className="btn ghost" disabled={busy || !csv.trim()} onClick={() => check(true)}>
            Check
          </button>
          <button className="btn" disabled={busy || !result || result.errors > 0 || result.ready === 0 || result.added > 0} onClick={() => check(false)}>
            Import {result && result.ready > 0 && !result.added ? `${result.ready} game${result.ready === 1 ? "" : "s"}` : ""}
          </button>
        </div>
      </div>
      {result && (
        <div style={{ marginTop: 16 }}>
          {result.added > 0 ? (
            <div className="alert ok">
              Added {result.added} game{result.added === 1 ? "" : "s"}
              {result.duplicates ? `; skipped ${result.duplicates} already on the schedule` : ""}.
            </div>
          ) : result.errors > 0 ? (
            <div className="alert error">
              {result.errors} row{result.errors === 1 ? " needs" : "s need"} fixing. Nothing was imported.
            </div>
          ) : (
            <p className="muted">
              {result.ready} ready to import{result.duplicates ? `, ${result.duplicates} already on the schedule (will be skipped)` : ""}.
            </p>
          )}
          {result.added === 0 && (
            <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", fontSize: 15 }}>
              {result.rows
                .filter((r) => r.error || r.duplicate)
                .map((r) => (
                  <li key={r.line} style={{ padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                    Line {r.line}: {r.home} vs {r.away} — <span className={r.error ? "" : "muted"}>{r.error ?? "already on the schedule"}</span>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function GameRow({ g, division, divName, canScore, onDone }: { g: Game; division?: Division; divName: string; canScore: boolean; onDone: () => void }) {
  const { busy, error, run } = useAction();
  const [mode, setMode] = useState<"view" | "edit" | "score">("view");
  const [home, setHome] = useState(g.homeScore?.toString() ?? "");
  const [away, setAway] = useState(g.awayScore?.toString() ?? "");
  const [f, setF] = useState({ homeTeamId: g.homeTeamId, awayTeamId: g.awayTeamId, startsAt: g.startsAtLocal, location: g.location, notes: g.notes ?? "", ticketUrl: g.ticketUrl ?? "", status: g.status === "final" ? "scheduled" : g.status, notify: false });
  const st = GAME_STATUS[g.status];

  async function saveScore(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => api.put(`/admin/schedule/games/${g.id}/score`, { homeScore: Number(home), awayScore: Number(away) }))) {
      setMode("view");
      onDone();
    }
  }
  async function saveEdit(e: React.FormEvent) {
    e.preventDefault();
    if (await run(() => api.put(`/admin/schedule/games/${g.id}`, { ...f, notes: f.notes || null, ticketUrl: f.ticketUrl.trim() || null }))) {
      setMode("view");
      onDone();
    }
  }

  return (
    <li style={{ display: "block" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <span>
          <span className="who">
            {g.home} vs {g.away}
            {g.status === "final" && ` · ${g.homeScore}–${g.awayScore}`}
          </span>
          <br />
          <span className="muted">
            {divName} · {fmtWhen(g.startsAt)} · {g.location}
            {g.ticketUrl ? " · Tickets link set" : ""}
          </span>
        </span>
        <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span className={`status ${st.tone}`}>{st.label}</span>
          {mode === "view" && (
            <>
              {canScore && g.status !== "cancelled" && (
                <button className="btn small" onClick={() => setMode("score")}>
                  {g.status === "final" ? "Fix score" : "Score"}
                </button>
              )}
              {g.status !== "final" && (
                <button className="btn ghost small" onClick={() => setMode("edit")}>
                  Edit
                </button>
              )}
            </>
          )}
        </span>
      </div>
      <ErrorAlert error={error} />
      {mode === "score" && (
        <form onSubmit={saveScore} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end", marginTop: 12 }}>
          <label style={{ maxWidth: 140 }}>
            {g.home}
            <input type="number" inputMode="numeric" min={0} max={199} required value={home} onChange={(e) => setHome(e.target.value)} />
          </label>
          <label style={{ maxWidth: 140 }}>
            {g.away}
            <input type="number" inputMode="numeric" min={0} max={199} required value={away} onChange={(e) => setAway(e.target.value)} />
          </label>
          <button className="btn small" disabled={busy}>
            Save final
          </button>
          {g.status === "final" && (
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={async () => {
                if (window.confirm("Clear this score? The game goes back to scheduled and leaves the standings.") && (await run(() => api.del(`/admin/schedule/games/${g.id}/score`)))) {
                  setMode("view");
                  onDone();
                }
              }}
            >
              Clear score
            </button>
          )}
          <button type="button" className="btn ghost small" onClick={() => setMode("view")}>
            Cancel
          </button>
        </form>
      )}
      {mode === "edit" && (
        <form className="stack" onSubmit={saveEdit} style={{ marginTop: 12 }}>
          <div className="form-row">
            <label>
              Home
              <select value={f.homeTeamId} onChange={(e) => setF({ ...f, homeTeamId: e.target.value })}>
                {division?.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Away
              <select value={f.awayTeamId} onChange={(e) => setF({ ...f, awayTeamId: e.target.value })}>
                {division?.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label>
              Date and time
              <input type="datetime-local" required value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
            </label>
            <label>
              Status
              <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as typeof f.status })}>
                <option value="scheduled">Scheduled</option>
                <option value="postponed">Postponed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
          <label>
            Location
            <input type="text" required maxLength={200} value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} />
          </label>
          <label>
            Notes for the teams
            <input type="text" maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </label>
          <label>
            Ticket link <span className="muted">(optional)</span>
            <input type="url" inputMode="url" maxLength={500} value={f.ticketUrl} onChange={(e) => setF({ ...f, ticketUrl: e.target.value })} placeholder="https://…" pattern="https://.*" title="Starts with https://" />
          </label>
          <label className="check">
            <input type="checkbox" checked={f.notify} onChange={(e) => setF({ ...f, notify: e.target.checked })} /> Email both teams about this change
          </label>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <button className="btn small" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn ghost small" onClick={() => setMode("view")}>
              Cancel
            </button>
            <button
              type="button"
              className="btn ghost small"
              disabled={busy}
              onClick={async () => {
                if (window.confirm("Delete this game? To call off a game, set it to Cancelled instead so families can see it.") && (await run(() => api.del(`/admin/schedule/games/${g.id}`))) !== undefined) onDone();
              }}
            >
              Delete
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
