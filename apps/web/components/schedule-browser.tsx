"use client";

/**
 * Public schedule: a search over divisions and teams, each division's
 * standings with its next game, and every game in a pop-up with its own search.
 */
import { useEffect, useMemo, useState } from "react";
import { EventRow } from "@/components/event-row";
import { Modal } from "@/components/modal";
import { TicketButton } from "@/components/ticket-button";
import { GAME_STATUS, pct, type Game, type Standing } from "@/lib/schedule";

export interface ScheduleDivision {
  id: string;
  name: string;
  games: Game[];
  standings: Standing[];
}

const TZ = "America/New_York";
/** A game stays "next" until a few hours after it starts (covers the game in progress). */
const LIVE_WINDOW = 3 * 3600_000;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const words = (q: string) => norm(q).split(" ").filter(Boolean);
/** Every word of the search appears somewhere in the text. */
const matches = (text: string, q: string) => {
  const t = norm(text);
  return words(q).every((w) => t.includes(w));
};

const isUpcoming = (g: Game, now: number) => (g.status === "scheduled" || g.status === "postponed") && new Date(g.startsAt).getTime() > now - LIVE_WINDOW;

/** Searchable text for a game: teams, place, date in a few spellings, status. */
function gameText(g: Game) {
  const d = new Date(g.startsAt);
  const f = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString("en-US", { ...o, timeZone: TZ });
  return [
    g.home,
    g.away,
    g.location,
    f({ weekday: "long", month: "long", day: "numeric" }),
    f({ weekday: "short", month: "short", day: "numeric" }),
    f({ month: "numeric", day: "numeric" }),
    GAME_STATUS[g.status].label,
  ].join(" ");
}

const dayKey = (iso: string) => new Date(iso).toLocaleDateString("en-CA", { timeZone: TZ });

/** Final scores from the most recent day games were played (oldest kickoff first). */
function latestResults(games: Game[], now: number) {
  const finals = games.filter((g) => g.status === "final" && g.homeScore !== null && g.awayScore !== null && new Date(g.startsAt).getTime() <= now);
  if (!finals.length) return [];
  const day = dayKey(finals.reduce((a, b) => (b.startsAt > a.startsAt ? b : a)).startsAt);
  return finals.filter((g) => dayKey(g.startsAt) === day).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function LatestResults({ games, teams }: { games: Game[]; teams: Set<string> }) {
  const when = new Date(games[0]!.startsAt).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: TZ });
  return (
    <div className="card">
      <div className="games-head">
        <h3 style={{ margin: 0 }}>Latest results</h3>
        <span className="muted">{when}</span>
      </div>
      <ul className="results">
        {games.map((g) => {
          const h = g.homeScore!;
          const a = g.awayScore!;
          const side = (name: string, id: string, score: number, other: number) => (
            <span className={`res-team${score > other ? " won" : ""}${teams.has(id) ? " hit" : ""}`}>
              <span>{name}</span>
              <b>{score}</b>
            </span>
          );
          return (
            <li key={g.id} aria-label={`${g.home} ${h}, ${g.away} ${a}`}>
              {side(g.home, g.homeTeamId, h, a)}
              <span className="res-vs" aria-hidden="true">
                vs
              </span>
              {side(g.away, g.awayTeamId, a, h)}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function GameRow({ g }: { g: Game }) {
  return (
    <EventRow
      startsAt={g.startsAt}
      title={g.status === "final" ? `${g.home} ${g.homeScore} – ${g.away} ${g.awayScore}` : `${g.home} vs ${g.away}`}
      detail={g.location}
      struck={g.status === "cancelled"}
      badge={g.status !== "scheduled" ? <span className={`status ${GAME_STATUS[g.status].tone}`}>{GAME_STATUS[g.status].label}</span> : null}
      action={<TicketButton g={g} />}
    />
  );
}

function SearchBox({ value, onChange, label, placeholder }: { value: string; onChange: (v: string) => void; label: string; placeholder: string }) {
  return (
    <div className="sched-search">
      <input type="search" value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === "Escape" && value && (e.stopPropagation(), e.preventDefault(), onChange(""))} placeholder={placeholder} aria-label={label} autoComplete="off" />
    </div>
  );
}

export function ScheduleBrowser({ divisions, season }: { divisions: ScheduleDivision[]; season: { name: string; seasonPassUrl?: string | null } }) {
  const [q, setQ] = useState("");
  // Links like /schedule?q=Fire (from the home page) open already searched.
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("q");
    if (fromUrl) setQ(fromUrl.slice(0, 80));
  }, []);
  const [open, setOpen] = useState<{ div: ScheduleDivision; q: string } | null>(null);
  const now = Date.now();

  /** Divisions to show, and which of their teams the search named. */
  const shown = useMemo(() => {
    if (!words(q).length) return divisions.map((d) => ({ d, teams: new Set<string>() }));
    return divisions.flatMap((d) => {
      if (matches(d.name, q)) return [{ d, teams: new Set<string>() }];
      const names = new Map<string, string>();
      for (const s of d.standings) names.set(s.teamId, s.team);
      for (const g of d.games) {
        names.set(g.homeTeamId, g.home);
        names.set(g.awayTeamId, g.away);
      }
      const teams = new Set([...names].filter(([, n]) => matches(n, q)).map(([id]) => id));
      return teams.size ? [{ d, teams }] : [];
    });
  }, [divisions, q]);

  return (
    <>
      <SearchBox value={q} onChange={setQ} label="Find a division or team" placeholder="Find a division or team" />
      {shown.length > 1 && (
        <nav className="chips" aria-label="Divisions" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 24px" }}>
          {shown.map(({ d }) => (
            <a key={d.id} className="btn ghost small" href={`#d-${d.id}`}>
              {d.name}
            </a>
          ))}
        </nav>
      )}
      {shown.length === 0 && (
        <p className="muted" role="status">
          No division or team matches “{q.trim()}”.
        </p>
      )}
      {shown.map(({ d, teams }) => {
        // With a team searched, its next game; otherwise the division's.
        const mine = (g: Game) => !teams.size || teams.has(g.homeTeamId) || teams.has(g.awayTeamId);
        const next = d.games.find((g) => mine(g) && isUpcoming(g, now));
        const last = latestResults(d.games.filter(mine), now);
        const teamLabel = teams.size === 1 ? d.standings.find((s) => teams.has(s.teamId))?.team : undefined;
        return (
          <section key={d.id} id={`d-${d.id}`} style={{ marginBottom: 40, scrollMarginTop: 96 }}>
            <h2>{d.name}</h2>
            <div className="grid" style={{ alignItems: "start" }}>
              <div className="sched-col">
                {last.length > 0 && <LatestResults games={last} teams={teams} />}
              <div className="card">
                <h3 style={{ marginTop: 0 }}>Standings</h3>
                <div className="table-wrap">
                  <table className="simple standings">
                    <thead>
                      <tr>
                        <th>Team</th>
                        <th>W</th>
                        <th>L</th>
                        <th>T</th>
                        <th>Pct</th>
                        <th>PF</th>
                        <th>PA</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.standings.map((s) => (
                        <tr key={s.teamId} className={teams.has(s.teamId) ? "hit" : undefined}>
                          <td>
                            <strong>{s.team}</strong>
                          </td>
                          <td>{s.w}</td>
                          <td>{s.l}</td>
                          <td>{s.t}</td>
                          <td>{pct(s.pct)}</td>
                          <td>{s.pf}</td>
                          <td>{s.pa}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              </div>
              <div className="card">
                <div className="games-head">
                  <h3 style={{ margin: 0 }}>Next game</h3>
                  {season.seasonPassUrl && (
                    <a className="btn small" href={season.seasonPassUrl} target="_blank" rel="noopener noreferrer" aria-label={`Buy ${season.name} weekly or season passes`}>
                      Buy weekly / season passes
                    </a>
                  )}
                </div>
                {next ? (
                  <ul className="events">
                    <GameRow g={next} />
                  </ul>
                ) : (
                  <p className="muted">{teamLabel ? `No more games scheduled for ${teamLabel}.` : "No more games scheduled."}</p>
                )}
                <button type="button" className="btn ghost small" style={{ marginTop: 16 }} onClick={() => setOpen({ div: d, q: teams.size ? q : "" })}>
                  All games ({d.games.length})
                </button>
              </div>
            </div>
          </section>
        );
      })}
      {open && <AllGames div={open.div} initialQ={open.q} now={now} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Every game in a division: upcoming first, then results (newest first), with a search. */
function AllGames({ div, initialQ, now, onClose }: { div: ScheduleDivision; initialQ: string; now: number; onClose: () => void }) {
  const [q, setQ] = useState(initialQ);
  const hits = div.games.filter((g) => !words(q).length || matches(gameText(g), q));
  const upcoming = hits.filter((g) => isUpcoming(g, now));
  const past = hits.filter((g) => !isUpcoming(g, now)).reverse();
  return (
    <Modal open title={`${div.name} games`} onClose={onClose}>
      <SearchBox value={q} onChange={setQ} label="Search games" placeholder="Team, field or date (e.g. Nov 14)" />
      {hits.length === 0 ? (
        <p className="muted" role="status">
          No games match “{q.trim()}”.
        </p>
      ) : (
        <>
          {upcoming.length > 0 && (
            <>
              <h3 className="modal-sub">Upcoming ({upcoming.length})</h3>
              <ul className="events">
                {upcoming.map((g) => (
                  <GameRow key={g.id} g={g} />
                ))}
              </ul>
            </>
          )}
          {past.length > 0 && (
            <>
              <h3 className="modal-sub">Results ({past.length})</h3>
              <ul className="events">
                {past.map((g) => (
                  <GameRow key={g.id} g={g} />
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </Modal>
  );
}
