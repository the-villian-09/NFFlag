/**
 * The home page once the season is under way: the next game day, the
 * signed-in family's team, latest scores, standings, league news and
 * sponsors. Wording and photos are edited in Admin → Site content.
 */
import Link from "next/link";
import { siteImageUrl, type ImageSlots, type SeasonHome as Settings } from "@nffl/shared";
import { StandingsTabs, YourTeam } from "@/components/season-home-client";
import { imageFor, latestScores, nextGameDay, teamRecords, type HomeDivision } from "@/lib/season-home";

export interface NewsItem {
  id: string;
  title: string;
  body: string;
  imageUrl: string | null;
  linkText: string | null;
  linkUrl: string | null;
  publishedAt: string;
}

const newsDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const firstPara = (s: string) => s.split(/\n\s*\n/)[0]!.trim();

export function SeasonHome({
  s,
  images,
  season,
  divisions,
  news,
}: {
  s: Settings;
  images: Partial<ImageSlots>;
  season: { name: string; seasonPassUrl?: string | null };
  divisions: HomeDivision[];
  news: NewsItem[];
}) {
  const now = Date.now();
  const day = nextGameDay(divisions, now);
  const scores = s.showScores ? latestScores(divisions, now) : null;
  const where = s.whereText || (day ? (day.locations.length > 3 ? `${day.locations.slice(0, 3).join(", ")} +${day.locations.length - 3} more` : day.locations.join(", ")) : "");
  const withStandings = divisions.filter((d) => d.standings.length);
  const sponsors = s.showSponsors ? s.sponsors : [];

  return (
    <main className="sh">
      <section className="sh-hero" aria-labelledby="sh-title">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageFor(images, "seasonLeft")} alt="" className="sh-photo left" fetchPriority="high" />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageFor(images, "seasonRight")} alt="" className="sh-photo right" fetchPriority="high" />
        <div className="sh-tint" aria-hidden="true" />
        <div className="sh-copy">
          {day && s.statusText && <span className="sh-status">{s.statusText}</span>}
          {day ? (
            <>
              <span className="sh-kicker">{s.heroKicker || season.name}</span>
              <h1 id="sh-title" className="sh-big">
                {day.heading}
                <br />
                <b>{day.date}</b>
              </h1>
              <div className="sh-facts">
                <div>
                  <span>First kickoff</span>
                  <strong>{day.firstKickoff}</strong>
                </div>
                <div>
                  <span>Games</span>
                  <strong>{`${day.games} ${day.games === 1 ? "game" : "games"}${day.divisions > 1 ? ` across ${day.divisions} divisions` : ""}`}</strong>
                </div>
                {where && (
                  <div>
                    <span>Where</span>
                    <strong>{where}</strong>
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              <span className="sh-kicker">{season.name}</span>
              <h1 id="sh-title" className="sh-big">
                {s.noGamesTitle}
              </h1>
              {s.noGamesText && <p className="sh-lead">{s.noGamesText}</p>}
            </>
          )}
          <div className="sh-cta">
            {season.seasonPassUrl && (
              <a className="btn" href={season.seasonPassUrl} target="_blank" rel="noopener noreferrer">
                {s.passesLabel}
              </a>
            )}
            {s.ticketsUrl && (
              <a className="btn ghost" href={s.ticketsUrl} target="_blank" rel="noopener noreferrer">
                {s.ticketsLabel}
              </a>
            )}
            <Link className="sh-more" href="/schedule">
              Full schedule →
            </Link>
          </div>
        </div>
      </section>

      {s.showYourTeam && (
        <section className="sh-sec" aria-label="Your team">
          <YourTeam records={teamRecords(divisions)} />
        </section>
      )}

      {scores && scores.divisions.length > 0 && (
        <section className="sh-sec" aria-labelledby="sh-scores">
          <div className="sh-head">
            <h2 id="sh-scores">{s.scoresTitle}</h2>
            <span className="sh-when">
              {scores.date} · <Link href="/schedule">All results →</Link>
            </span>
          </div>
          <div className="sh-scores">
            {scores.divisions.map((d) => (
              <div key={d.id} className={`sh-sc ${d.gender}`}>
                <div className="sh-div">
                  {d.name}
                  <i>Final</i>
                </div>
                {d.games.map((g) => (
                  <div key={g.id} className="sh-game" aria-label={`${g.home} ${g.homeScore}, ${g.away} ${g.awayScore}`}>
                    <div className={`sh-row${g.homeScore! > g.awayScore! ? " w" : ""}`}>
                      <span>{g.home}</span>
                      <b>{g.homeScore}</b>
                    </div>
                    <div className={`sh-row${g.awayScore! > g.homeScore! ? " w" : ""}`}>
                      <span>{g.away}</span>
                      <b>{g.awayScore}</b>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}

      {s.showStandings && withStandings.length > 0 && (
        <section className="sh-sec" aria-labelledby="sh-standings">
          <div className="sh-head">
            <h2 id="sh-standings">{s.standingsTitle}</h2>
            <Link className="sh-more" href="/schedule">
              Full standings →
            </Link>
          </div>
          <StandingsTabs divisions={withStandings.map((d) => ({ id: d.id, name: d.name, standings: d.standings }))} playoffSpots={s.playoffSpots} playoffNote={s.playoffNote} />
        </section>
      )}

      {s.showNews && news.length > 0 && (
        <section className="sh-sec" aria-labelledby="sh-news">
          <div className="sh-head">
            <h2 id="sh-news">{s.newsTitle}</h2>
            <Link className="sh-more" href="/news">
              All news →
            </Link>
          </div>
          <div className="sh-news">
            {news.slice(0, 3).map((n) => (
              <article key={n.id} className={`sh-post${n.imageUrl ? "" : " text"}`}>
                {n.imageUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={n.imageUrl} alt="" loading="lazy" />
                )}
                <div className="sh-pb">
                  <div className="sh-d">{newsDate(n.publishedAt)}</div>
                  <h3>
                    <Link href={`/news#post-${n.id}`}>{n.title}</Link>
                  </h3>
                  {n.body && <p>{firstPara(n.body)}</p>}
                  {n.linkUrl && (
                    <p style={{ marginTop: 10 }}>
                      <a className="sh-more" href={n.linkUrl} {...(n.linkUrl.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
                        {`${n.linkText || "Read more"} →`}
                      </a>
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {sponsors.length > 0 && (
        <section className="sh-sec" aria-label={s.sponsorsTitle}>
          <div className="sh-sponsors">
            <span>{s.sponsorsTitle}</span>
            {sponsors.map((sp, i) => {
              const inner = sp.logoId ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={siteImageUrl(sp.logoId)} alt={sp.name} loading="lazy" />
              ) : (
                sp.name
              );
              return sp.url ? (
                <a key={i} className="sh-sp" href={sp.url} target="_blank" rel="noopener noreferrer">
                  {inner}
                </a>
              ) : (
                <span key={i} className="sh-sp">
                  {inner}
                </span>
              );
            })}
          </div>
        </section>
      )}
    </main>
  );
}
