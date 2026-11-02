"use client";

/** The interactive parts of the in-season home page. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { resultFor, type Game, type Standing } from "@/lib/schedule";
import { ordinal, record } from "@/lib/season-home";
import { TicketButton } from "@/components/ticket-button";

const TZ = "America/New_York";
const part = (iso: string, o: Intl.DateTimeFormatOptions) => new Date(iso).toLocaleString("en-US", { ...o, timeZone: TZ });

interface MyTeam {
  team: { id: string; name: string; divisionName: string };
  players: string[];
  coaching: boolean;
  games: Game[];
}
type Records = Record<string, { w: number; l: number; t: number; place: number; teams: number }>;

/** Signed-in families and coaches: their team at a glance. Everyone else: a team search. */
export function YourTeam({ records }: { records: Records }) {
  const [teams, setTeams] = useState<MyTeam[] | null | "none">(null);
  useEffect(() => {
    api
      .get<{ items: MyTeam[] }>("/my-schedule")
      .then((r) => setTeams(r.items.length ? r.items : "none"))
      .catch(() => setTeams("none"));
  }, []);
  if (teams === null) return <div className="sh-team-placeholder" aria-hidden="true" />;
  if (teams === "none") return <FindTeam />;
  return (
    <div className="sh-teams">
      {teams.slice(0, 4).map((t) => (
        <TeamCard key={t.team.id} t={t} rec={records[t.team.id]} />
      ))}
    </div>
  );
}

function TeamCard({ t, rec }: { t: MyTeam; rec?: Records[string] }) {
  const now = Date.now();
  const next = t.games.find((g) => (g.status === "scheduled" || g.status === "postponed") && new Date(g.startsAt).getTime() > now - 3 * 3600_000);
  const last = [...t.games].reverse().find((g) => g.status === "final");
  const res = last ? resultFor(last, t.team.id) : null;
  const vs = (g: Game) => `${t.team.name} ${g.homeTeamId === t.team.id ? "vs" : "at"} ${g.homeTeamId === t.team.id ? g.away : g.home}`;
  const who = t.coaching ? "Your team" : t.players.length ? `${t.players.join(" & ")}'s team` : "Your team";
  return (
    <div className="sh-team">
      <div>
        <div className="sh-lbl">{who}</div>
        <div className="sh-tname">
          {t.team.name}
          <small>{t.team.divisionName}</small>
        </div>
        {rec && (rec.w + rec.l + rec.t > 0 ? <div className="sh-rec">{`${record(rec)} · ${ordinal(rec.place)} place`}</div> : <div className="sh-rec muted-rec">No games played yet</div>)}
      </div>
      <div>
        <div className="sh-lbl">Next game</div>
        {next ? (
          <div className="sh-ev">
            <span className="sh-tile">
              {part(next.startsAt, { weekday: "short" }).toUpperCase()}
              <br />
              {part(next.startsAt, { month: "short" }).toUpperCase()}
              <b>{part(next.startsAt, { day: "numeric" })}</b>
            </span>
            <span>
              <span className="sh-t">{part(next.startsAt, { hour: "numeric", minute: "2-digit" })}</span>
              <span className="sh-m">{vs(next)}</span>
              <span className="sh-p">{next.location}</span>
              <span className="sh-tix">
                <TicketButton g={next} />
              </span>
            </span>
          </div>
        ) : (
          <p className="sh-p">No more games scheduled.</p>
        )}
      </div>
      <div>
        <div className="sh-lbl">{last ? `Last game · ${part(last.startsAt, { weekday: "short", month: "short", day: "numeric" })}` : "Last game"}</div>
        {last && res ? (
          <div className="sh-result">
            <span className={`sh-wl ${res[0]!.toLowerCase()}`}>{res[0]}</span>
            <span>{`${last.home} ${last.homeScore} – ${last.away} ${last.awayScore}`}</span>
          </div>
        ) : (
          <p className="sh-p">No results yet.</p>
        )}
        <p style={{ margin: "12px 0 0" }}>
          <Link className="sh-more" href={t.coaching ? `/my-team/${t.team.id}` : `/schedule?q=${encodeURIComponent(t.team.name)}`}>
            {t.coaching ? "Team page →" : "Team schedule →"}
          </Link>
        </p>
      </div>
    </div>
  );
}

function FindTeam() {
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form
      className="sh-find"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        router.push(q.trim() ? `/schedule?q=${encodeURIComponent(q.trim())}` : "/schedule");
      }}
    >
      <label htmlFor="find-team">Find your team</label>
      <input id="find-team" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Team or division" autoComplete="off" />
      <button className="btn small">Go</button>
      <span className="sh-p">
        Families: <Link href="/sign-in">sign in</Link> to see your child&rsquo;s team here.
      </span>
    </form>
  );
}

interface StandDiv {
  id: string;
  name: string;
  standings: Standing[];
}

/** Top three in each division, a tab per division, and the playoff race when set. */
export function StandingsTabs({ divisions, playoffSpots, playoffNote }: { divisions: StandDiv[]; playoffSpots: number; playoffNote: string }) {
  const [on, setOn] = useState(divisions[0]?.id);
  const d = divisions.find((x) => x.id === on) ?? divisions[0];
  if (!d) return null;
  const played = d.standings.some((s) => s.gp > 0);
  const spots = Math.min(playoffSpots, d.standings.length);
  const cut = d.standings[spots - 1];
  const gb = (s: Standing) => (cut ? (cut.w - s.w + (s.l - cut.l)) / 2 : 0);
  const out = d.standings.slice(spots, spots + 2);
  return (
    <>
      <div className="sh-tabs" role="tablist" aria-label="Divisions">
        {divisions.map((x) => (
          <button key={x.id} role="tab" aria-selected={x.id === d.id} className={x.id === d.id ? "on" : undefined} onClick={() => setOn(x.id)}>
            {x.name}
          </button>
        ))}
      </div>
      <div className={`sh-stand${spots > 0 && played ? " race" : ""}`} role="tabpanel">
        <div className="card">
          {played ? (
            <table className="simple sh-table">
              <thead>
                <tr>
                  <th aria-label="Place" />
                  <th>Team</th>
                  <th>W</th>
                  <th>L</th>
                  <th>T</th>
                  <th>PF</th>
                  <th>PA</th>
                </tr>
              </thead>
              <tbody>
                {d.standings.slice(0, 3).map((s, i) => (
                  <tr key={s.teamId}>
                    <td className="sh-rk">{i + 1}</td>
                    <td>{s.team}</td>
                    <td>{s.w}</td>
                    <td>{s.l}</td>
                    <td>{s.t}</td>
                    <td>{s.pf}</td>
                    <td>{s.pa}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="sh-p" style={{ margin: 0 }}>
              No games played yet in {d.name}.
            </p>
          )}
        </div>
        {spots > 0 && played && (
          <div className="card sh-race">
            <h3>Playoff race</h3>
            <p className="sh-p">{playoffNote || `Top ${spots} make the playoffs.`}</p>
            {d.standings.slice(0, spots).map((s, i) => (
              <div key={s.teamId} className="sh-pill">
                {`${i + 1}. ${s.team}`} <span>{record(s)}</span>
              </div>
            ))}
            {out.map((s) => (
              <div key={s.teamId} className="sh-pill out">
                {s.team}
                <span>{gb(s) <= 0 ? "Tied for the last spot" : `${gb(s)} ${gb(s) === 1 ? "game" : "games"} back`}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
