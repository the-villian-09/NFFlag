import type { Metadata } from "next";
import Link from "next/link";
import { serverGet } from "@/lib/server-api";
import { EventRow } from "@/components/event-row";
import { TicketButton } from "@/components/ticket-button";
import { GAME_STATUS, pct, type Game, type Standing } from "@/lib/schedule";

export const metadata: Metadata = { title: "Schedule & standings" };
export const revalidate = 60;

interface Data {
  season: { id: string; name: string };
  divisions: { id: string; name: string; games: Game[]; standings: Standing[] }[];
}

/** Public game schedule, results and standings for the current season. */
export default async function SchedulePage() {
  const data = await serverGet<Data>("/schedule");
  const divs = data?.divisions.filter((d) => d.games.length) ?? [];

  return (
    <main className="page">
      <h1 className="page-title">Schedule & standings</h1>
      <div className="rule" />
      {!data ? (
        <p className="muted">The schedule is temporarily unavailable. Please try again shortly.</p>
      ) : divs.length === 0 ? (
        <section className="card">
          <h2>Games coming soon</h2>
          <p className="muted">
            The {data.season.name} game schedule is posted after the draft. Practice nights and the season calendar are on the{" "}
            <Link href="/#schedule">home page</Link>.
          </p>
        </section>
      ) : (
        <>
          <p className="muted">{data.season.name}. All times are Jacksonville time.</p>
          {divs.length > 1 && (
            <nav className="chips" aria-label="Divisions" style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "8px 0 24px" }}>
              {divs.map((d) => (
                <a key={d.id} className="btn ghost small" href={`#d-${d.id}`}>
                  {d.name}
                </a>
              ))}
            </nav>
          )}
          {divs.map((d) => (
            <section key={d.id} id={`d-${d.id}`} style={{ marginBottom: 40, scrollMarginTop: 96 }}>
              <h2>{d.name}</h2>
              <div className="grid" style={{ alignItems: "start" }}>
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
                          <tr key={s.teamId}>
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
                <div className="card">
                  <h3 style={{ marginTop: 0 }}>Games</h3>
                  <ul className="events">
                    {d.games.map((g) => (
                      <EventRow
                        key={g.id}
                        startsAt={g.startsAt}
                        title={g.status === "final" ? `${g.home} ${g.homeScore} – ${g.away} ${g.awayScore}` : `${g.home} vs ${g.away}`}
                        detail={g.location}
                        struck={g.status === "cancelled"}
                        badge={g.status !== "scheduled" ? <span className={`status ${GAME_STATUS[g.status].tone}`}>{GAME_STATUS[g.status].label}</span> : null}
                        action={<TicketButton g={g} />}
                      />
                    ))}
                  </ul>
                </div>
              </div>
            </section>
          ))}
        </>
      )}
    </main>
  );
}
