import Link from "next/link";

import { DEFAULT_HOMEPAGE, DEFAULT_SEASON_HOME, type Homepage, type ImageSlots, type SeasonHome as SeasonSettings } from "@nffl/shared";
import { SeasonHome, type NewsItem } from "@/components/season-home";
import { serverGet } from "@/lib/server-api";
import { imageFor, type HomeDivision } from "@/lib/season-home";

/**
 * Public home. Before and during registration: the "Split Field" sign-up page
 * (Site content → Homepage). Once the season is in season or in the playoffs:
 * the game-day page (Site content → In-season home page). Admins can force
 * either. Photos can be replaced in Site content → Photos.
 */
export const revalidate = 60;

interface ScheduleData {
  season: { id: string; name: string; status?: string; seasonPassUrl?: string | null };
  divisions: HomeDivision[];
}

export default async function Home() {
  const [content, schedule] = await Promise.all([
    serverGet<{ homepage: Homepage; seasonHome?: SeasonSettings; images?: Partial<ImageSlots> }>("/homepage"),
    serverGet<ScheduleData>("/schedule"),
  ]);
  const h: Homepage = content?.homepage ?? DEFAULT_HOMEPAGE;
  const sh: SeasonSettings = { ...DEFAULT_SEASON_HOME, ...content?.seasonHome };
  const images = content?.images ?? {};
  const inSeason = schedule && (sh.mode === "season" || (sh.mode === "auto" && (schedule.season.status === "in_season" || schedule.season.status === "playoffs")));
  if (inSeason) {
    const news = sh.showNews ? ((await serverGet<{ items: NewsItem[] }>("/news?limit=3"))?.items ?? []) : [];
    return <SeasonHome s={sh} images={images} season={schedule.season} divisions={schedule.divisions} news={news} />;
  }
  return (
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/nffl-logo.svg" alt="NFFL logo" className="logo-outline-lg" width={300} height={233} fetchPriority="high" />
          <h1 id="hero-title">North Florida Flag League</h1>
          {h.tagline && <p className="tagline">{h.tagline}</p>}
          <Link href="/sign-up" className="btn">
            {h.registerButton}
          </Link>
        </div>
        <div className="hero-half boys">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageFor(images, "heroBoy")} alt="" className="hero-photo" fetchPriority="high" />
          <div className="hero-tint" aria-hidden="true" />
          <div className="hero-label">
            <strong>Boys</strong>
            <span>{h.boysAgeRange}</span>
          </div>
        </div>
        <div className="hero-half girls">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageFor(images, "heroGirl")} alt="" className="hero-photo" fetchPriority="high" />
          <div className="hero-tint" aria-hidden="true" />
          <div className="hero-label">
            <strong>Girls</strong>
            <span>{h.girlsAgeRange}</span>
          </div>
        </div>
      </section>

      {h.keyDates.length > 0 && (
        <section className="dates-band" aria-label="Key dates">
          <div className="container">
            {h.keyDates.map((d) => (
              <div key={d.label + d.value}>
                <span>{d.label}</span>
                <strong>{d.value}</strong>
              </div>
            ))}
          </div>
        </section>
      )}

      <section id="schedule" className="container section cols" aria-label="Weekly schedule">
        <div>
          <h2 style={{ marginBottom: 0 }}>Practice</h2>
          <div className="rule" />
          <p className="big-line">{h.practiceDays}</p>
          <p className="muted-line">{h.practiceTimes}</p>
        </div>
        <div>
          <h2 style={{ marginBottom: 0 }}>Games</h2>
          <div className="rule blue" />
          <p className="big-line">{h.gameDays}</p>
          <p className="muted-line">{h.gameDates}</p>
        </div>
      </section>

      <section id="divisions" className="container section" aria-labelledby="divisions-title">
        <h2 id="divisions-title">Divisions</h2>
        <div className="cols">
          <article className="division">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageFor(images, "divisionBoys")} alt="Boys division players" loading="lazy" style={{ objectPosition: "50% 30%" }} />
            <div className="ages">
              <h3>Boys</h3>
              {h.boysDivisions.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </div>
          </article>
          <article className="division girls">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageFor(images, "divisionGirls")} alt="Girls division players" loading="lazy" style={{ objectPosition: "55% 35%" }} />
            <div className="ages">
              <h3>Girls</h3>
              {h.girlsDivisions.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section id="fees" className="container section" aria-labelledby="fees-title">
        <h2 id="fees-title">Fees</h2>
        <div className="cols" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(260px, 100%), 1fr))" }}>
          <div className="fee primary">
            <span className="label">Registration</span>
            <span className="amount">{h.registrationFee}</span>
            <span className="label" style={{ fontSize: 17 }}>{h.registrationFeeNote}</span>
          </div>
          <div className="fee">
            <span className="label" style={{ color: "#6fbfff" }}>League fees</span>
            {h.leagueFees.map((f) => (
              <div className="row" key={f.label}>
                <span>{f.label}</span>
                <b>{f.value}</b>
              </div>
            ))}
          </div>
          <div className="fee">
            <span className="label" style={{ color: "var(--gold)" }}>Gate fee</span>
            {h.gateFees.map((f) => (
              <div className="row" key={f.label}>
                <span>{f.label}</span>
                <b style={/^free$/i.test(f.value) ? { color: "var(--lime)" } : undefined}>{f.value}</b>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="cta-band">
        <div className="container">
          <div>
            <h2>{h.ctaTitle}</h2>
            <p>{h.ctaText}</p>
          </div>
          <Link href="/sign-up" className="btn">
            Register your player
          </Link>
        </div>
      </section>
    </main>
  );
}
