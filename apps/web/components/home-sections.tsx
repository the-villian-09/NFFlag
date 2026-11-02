/** Divisions and fees from Site content → Homepage: on the registration home page and on their own pages. */
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
