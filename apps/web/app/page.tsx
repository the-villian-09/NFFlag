import Link from "next/link";

import { DEFAULT_HOMEPAGE, DEFAULT_SEASON_HOME, type Homepage, type ImageSlots, type SeasonHome as SeasonSettings } from "@nffl/shared";
import { SeasonHome, type NewsItem } from "@/components/season-home";
import { serverGet } from "@/lib/server-api";
import { imageFor, type HomeDivision } from "@/lib/season-home";
import { DivisionFinderTeaser, HowItWorks } from "@/components/home-sections";
import { RegisterBar } from "@/components/register-bar";
import { registrationWindow } from "@/lib/registration-window";
import { HeroVideo } from "@/components/hero-video";

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
  const [content, schedule, current] = await Promise.all([
    serverGet<{ homepage: Homepage; seasonHome?: SeasonSettings; images?: Partial<ImageSlots> }>("/homepage"),
    serverGet<ScheduleData>("/schedule"),
    serverGet<{ season: { name: string; registrationOpensAt: string | null; registrationClosesAt: string | null } | null }>("/divisions/current"),
  ]);
  const reg = registrationWindow(current?.season?.registrationOpensAt, current?.season?.registrationClosesAt);
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
          {h.tagline && (
            <p className="tagline">
              {/* Wraps between items, never in the middle of one. */}
              {h.tagline.split(" · ").map((t, i, all) => (
                <span key={t + i}>
                  <span className="tg-item">
                    {t}
                    {i < all.length - 1 && <span aria-hidden="true"> ·</span>}
                  </span>
                  {i < all.length - 1 && " "}
                </span>
              ))}
            </p>
          )}
          <Link href="/sign-up" className="btn">
            {h.registerButton}
          </Link>
        </div>
        <div className="hero-half boys">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageFor(images, "heroBoy")} alt="" className="hero-photo" fetchPriority="high" />
          <HeroVideo src="/videos/hero-boys.mp4" phoneSrc="/videos/hero-boys-540.mp4" className="hero-photo hero-video" />
          <div className="hero-tint" aria-hidden="true" />
          <div className="hero-label">
            <strong>Boys</strong>
            <span>{h.boysAgeRange}</span>
          </div>
        </div>
        <div className="hero-half girls">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageFor(images, "heroGirl")} alt="" className="hero-photo" fetchPriority="high" />
          <HeroVideo src="/videos/hero-girls.mp4" phoneSrc="/videos/hero-girls-540.mp4" className="hero-photo hero-video" />
          <div className="hero-tint" aria-hidden="true" />
          <div className="hero-label">
            <strong>Girls</strong>
            <span>{h.girlsAgeRange}</span>
          </div>
        </div>
      </section>

      {(h.keyDates.length > 0 || reg.days !== null) && (
        <section className="dates-band" aria-label="Key dates">
          <div className="container">
            {reg.days !== null && (reg.state === "before" || reg.state === "open") && (
              <div className="countdown-box">
                <b>{reg.days}</b>
                <span>
                  <strong>{reg.days === 1 ? "day" : "days"}</strong>
                  {reg.state === "before" ? "until registration opens" : "left to register"}
                </span>
              </div>
            )}
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
        {h.venueName && (
          <div>
            <h2 style={{ marginBottom: 0 }}>{h.venueTitle || "Game location"}</h2>
            <div className="rule pink" />
            <p className="big-line">{h.venueName}</p>
            {h.venueAddress && <p className="muted-line">{h.venueAddress}</p>}
            <a
              className="directions"
              href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([h.venueName, h.venueAddress].filter(Boolean).join(", "))}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Get directions →
            </a>
          </div>
        )}
      </section>

      <HowItWorks />
      <DivisionFinderTeaser h={h} />

      <section className="container" aria-labelledby="fee-strip-title">
        <div className="fee-strip">
          <div className="fee-strip-main">
            <h2 id="fee-strip-title">Fees</h2>
            <span className="fee-strip-amount">{h.registrationFee}</span>
            <span className="muted">{h.registrationFeeNote}</span>
          </div>
          <Link href="/fees" className="directions">
            What&rsquo;s included &amp; refunds →
          </Link>
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
      <RegisterBar title={[current?.season?.name, h.registrationFee].filter(Boolean).join(" · ")} detail={reg.short} />
    </main>
  );
}
