import Link from "next/link";

/**
 * Public home — "Split Field" look. Dates, fees and age groups are from the
 * 2027 season flyer. R1a moves this copy into admin-editable content blocks.
 */

const KEY_DATES = [
  { label: "Registration", value: "Dec 1 – Jan 3" },
  { label: "Draft", value: "Jan 4, 2027" },
  { label: "First practice", value: "Jan 6, 2027" },
  { label: "Championship", value: "April 3 – 4" },
];
const BOYS_AGES = ["4U/5U", "6U", "7U", "8U", "9U", "10U", "11U", "12U"];
const GIRLS_AGES = ["4U/5U", "6U", "7U", "8U", "9U", "10U", "11U", "12U", "14U"];

export default function Home() {
  return (
    <main>
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/nffl-logo.svg" alt="NFFL logo" className="logo-outline-lg" width={300} height={233} fetchPriority="high" />
          <h1 id="hero-title">North Florida Flag League</h1>
          <p className="tagline">Boys and girls · Football · Fun · Development · Community</p>
          <Link href="/sign-up" className="btn">
            Register · Dec 1 – Jan 3
          </Link>
        </div>
        <div className="hero-half boys">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/hero-boy.jpg" alt="" className="hero-photo" fetchPriority="high" />
          <div className="hero-tint" aria-hidden="true" />
          <div className="hero-label">
            <strong>Boys</strong>
            <span>4U/5U – 12U</span>
          </div>
        </div>
        <div className="hero-half girls">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/hero-girl.jpg" alt="" className="hero-photo" fetchPriority="high" />
          <div className="hero-tint" aria-hidden="true" />
          <div className="hero-label">
            <strong>Girls</strong>
            <span>4U/5U – 14U</span>
          </div>
        </div>
      </section>

      <section className="dates-band" aria-label="Key dates">
        <div className="container">
          {KEY_DATES.map((d) => (
            <div key={d.label}>
              <span>{d.label}</span>
              <strong>{d.value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section id="schedule" className="container section cols" aria-label="Weekly schedule">
        <div>
          <h2 style={{ marginBottom: 0 }}>Practice</h2>
          <div className="rule" />
          <p className="big-line">Monday – Wednesday</p>
          <p className="muted-line">6:00 – 7:30 PM</p>
        </div>
        <div>
          <h2 style={{ marginBottom: 0 }}>Games</h2>
          <div className="rule blue" />
          <p className="big-line">Tuesday · Thursday · Saturday</p>
          <p className="muted-line">February 2 – March 27</p>
        </div>
      </section>

      <section id="divisions" className="container section" aria-labelledby="divisions-title">
        <h2 id="divisions-title">Divisions</h2>
        <div className="cols">
          <article className="division">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/division-boys.jpg" alt="Boy player leaping to catch a pass" loading="lazy" style={{ objectPosition: "50% 30%" }} />
            <div className="ages">
              <h3>Boys</h3>
              {BOYS_AGES.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </div>
          </article>
          <article className="division girls">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/division-girls.jpg" alt="Girl player pulling a ball carrier's flag" loading="lazy" style={{ objectPosition: "55% 35%" }} />
            <div className="ages">
              <h3>Girls</h3>
              {GIRLS_AGES.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </div>
          </article>
        </div>
      </section>

      <section id="fees" className="container section" aria-labelledby="fees-title">
        <h2 id="fees-title">Fees</h2>
        <div className="cols" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))" }}>
          <div className="fee primary">
            <span className="label">Registration</span>
            <span className="amount">$100</span>
            <span className="label" style={{ fontSize: 17 }}>Per player</span>
          </div>
          <div className="fee">
            <span className="label" style={{ color: "#6fbfff" }}>League fees</span>
            <div className="row"><span>Coaching badge</span><b>$25</b></div>
            <div className="row"><span>Team mom</span><b>$25</b></div>
          </div>
          <div className="fee">
            <span className="label" style={{ color: "var(--gold)" }}>Gate fee</span>
            <div className="row"><span>Adults</span><b>$7</b></div>
            <div className="row"><span>Kids</span><b>$4</b></div>
            <div className="row"><span>4 and under</span><b style={{ color: "var(--lime)" }}>Free</b></div>
          </div>
        </div>
      </section>

      <section className="cta-band">
        <div className="container">
          <div>
            <h2>More than a league</h2>
            <p>We build players, leaders and a stronger North Florida.</p>
          </div>
          <Link href="/sign-up" className="btn">
            Register your player
          </Link>
        </div>
      </section>
    </main>
  );
}
