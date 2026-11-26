/** Divisions and fees from Site content → Homepage: on the registration home page and on their own pages. */
import Link from "next/link";
import type { ReactNode } from "react";
import type { Homepage, ImageSlots } from "@nffl/shared";
import { imageFor } from "@/lib/season-home";

function Title({ id, asPage, children }: { id: string; asPage?: boolean; children: ReactNode }) {
  return asPage ? (
    <>
      <h1 id={id} className="page-title">
        {children}
      </h1>
      <div className="rule" />
    </>
  ) : (
    <h2 id={id}>{children}</h2>
  );
}

export function DivisionsSection({ h, images, asPage }: { h: Homepage; images: Partial<ImageSlots>; asPage?: boolean }) {
  return (
    <section id="divisions" className={asPage ? undefined : "container section"} aria-labelledby="divisions-title">
      <Title id="divisions-title" asPage={asPage}>
        Divisions
      </Title>
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
  );
}

export function FeesSection({ h, asPage }: { h: Homepage; asPage?: boolean }) {
  return (
    <section id="fees" className={asPage ? undefined : "container section"} aria-labelledby="fees-title">
      <Title id="fees-title" asPage={asPage}>
        Fees
      </Title>
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
  );
}


/** Home page: the steps of signing up (Site content → Homepage). */
export function HowItWorks({ h }: { h: Homepage }) {
  if (!h.howSteps.length) return null;
  return (
    <section className="container section how" aria-labelledby="how-title">
      <div className="how-head">
        <div>
          <h2 id="how-title">{h.howTitle || "How registration works"}</h2>
          {h.howIntro && <p className="muted">{h.howIntro}</p>}
        </div>
        <Link href="/faq" className="directions">
          Questions? Read the FAQ →
        </Link>
      </div>
      <ol className="how-steps">
        {h.howSteps.map((s, i) => (
          <li key={s.title}>
            <b aria-hidden="true">{i + 1}</b>
            <strong>{s.title}</strong>
            <span>{s.text}</span>
          </li>
        ))}
      </ol>
      <p className="how-cta">
        <Link href="/sign-up" className="btn">
          Create your family account
        </Link>
        <span className="muted">
          Already have one? <Link href="/sign-in">Sign in</Link>
        </span>
      </p>
    </section>
  );
}

/** Home page: boys and girls cards that lead to the birth-date chart on the Divisions page. */
export function DivisionFinderTeaser({ h }: { h: Homepage }) {
  const sides = [
    { key: "boys", label: "Boys", ages: h.boysDivisions, range: h.boysAgeRange },
    { key: "girls", label: "Girls", ages: h.girlsDivisions, range: h.girlsAgeRange },
  ];
  return (
    <section className="container section" aria-labelledby="finder-teaser-title">
      <h2 id="finder-teaser-title">Find your division</h2>
      <div className="finder-teaser">
        {sides.map((s) => (
          <Link key={s.key} href="/divisions#finder-title" className={`finder-card ${s.key}`}>
            <span className="finder-card-head">
              <strong>{s.label}</strong>
              <span>See birth dates →</span>
            </span>
            <span className="finder-chips">
              {s.ages.map((a) => (
                <span key={a}>{a}</span>
              ))}
            </span>
            {s.range && <span className="muted">{s.range}</span>}
          </Link>
        ))}
      </div>
    </section>
  );
}
