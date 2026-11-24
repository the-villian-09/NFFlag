import type { Metadata } from "next";
import Link from "next/link";
import { COACHES_HONOR as C } from "@nffl/shared";
import { PrintPolicy } from "./print-policy";

export const metadata: Metadata = {
  title: "Coaches Honor",
  description: "The NFFL Player Safety Policy and the pledge every coach signs before working with players.",
};

const ICONS: Record<string, React.ReactNode> = {
  "two-adults": (
    <>
      <circle cx="8" cy="7" r="3" />
      <circle cx="17" cy="7" r="3" />
      <path d="M2 21v-2a5 5 0 0 1 10 0v2M12 21v-2a5 5 0 0 1 10 0v2" />
    </>
  ),
  report: (
    <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
  ),
  parents: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM8 9h8M8 13h5" />,
  "substance-free": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </>
  ),
};

export default function CoachesHonorPage() {
  return (
    <main className="page honor">
      <section className="honor-head" aria-labelledby="honor-title">
        <span className="honor-eyebrow">{C.eyebrow}</span>
        <h1 id="honor-title" className="page-title">
          {C.title}
        </h1>
        <p className="honor-intro">{C.intro}</p>
        <div className="chip-picks no-print">
          <Link className="btn" href="/coaches-staff">
            Apply to coach &amp; sign
          </Link>
          <PrintPolicy />
        </div>
      </section>

      <section className="honor-rules" aria-label="The four rules every coach follows">
        {C.rules.map((r) => (
          <div key={r.key} className={`honor-rule rule-${r.key}`}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {ICONS[r.key]}
            </svg>
            <h2>{r.title}</h2>
            <p>{r.body}</p>
          </div>
        ))}
      </section>

      <section className="honor-pledge" aria-labelledby="pledge-title">
        <div className="honor-letterhead">
          <span>North Florida Flag League</span>
          <span>Coaches Honor Pledge</span>
        </div>
        <h2 id="pledge-title">{C.pledgeTitle}</h2>
        {C.pledge.map((p) => (
          <p key={p}>{p}</p>
        ))}
        <p>
          <strong>So I promise to:</strong>
        </p>
        <ul>
          {C.promises.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
        <p className="honor-signed">Coaches sign this pledge online when they apply. The league keeps the signed copy with the date.</p>
      </section>

      <section className="honor-standards" aria-labelledby="standards-title">
        <h2 id="standards-title">The nine standards</h2>
        <p className="muted">Every NFFL coach agrees to all nine. Tap one to read it.</p>
        <div className="honor-list">
          {C.standards.map((s, i) => (
            <details key={s.title} open={i === 0}>
              <summary>
                <span className="num">{String(i + 1).padStart(2, "0")}</span>
                <span className="title">{s.title}</span>
                <span className="mark" aria-hidden="true" />
              </summary>
              <p>{s.body}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="cta-band honor-cta no-print">
        <div>
          <h2>Ready to coach?</h2>
          <p>Apply, complete your background check and sign the Coaches Honor, all on the Coaches &amp; Staff page.</p>
        </div>
        <Link className="btn" href="/coaches-staff">
          Apply to coach
        </Link>
      </section>

      <p className="muted honor-foot">
        Questions about this policy? <Link href="/contact">Contact the league</Link>. Worried about a child&rsquo;s safety right now? Call 911 or the Florida Abuse Hotline at{" "}
        <a href="tel:18009622873">1-800-962-2873</a>.
      </p>
    </main>
  );
}
