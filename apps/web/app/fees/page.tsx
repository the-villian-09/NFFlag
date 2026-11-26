import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_HOMEPAGE, type Homepage } from "@nffl/shared";
import { Markdown } from "@/components/markdown";
import { serverGet, type ContentPage } from "@/lib/server-api";

export const metadata: Metadata = {
  title: "Fees",
  description: "Registration, coach and game-day fees, what's included, paying and refunds.",
};
export const revalidate = 60;

/** Splits the editable text into cards, one per "## Heading". */
function sections(body: string) {
  const out: { title: string; body: string }[] = [];
  let cur: { title: string; body: string } | null = null;
  for (const line of body.split("\n")) {
    const m = /^##\s*(.+)$/.exec(line.trim());
    if (m) {
      cur = { title: m[1]!.trim(), body: "" };
      out.push(cur);
    } else if (cur) cur.body += line + "\n";
  }
  return out.map((s) => ({ ...s, body: s.body.trim() }));
}

/**
 * Prices (Site content → Homepage) and the cards below them
 * (Site content → Pages → Fees page; each "## Heading" is a card, and a
 * heading with "included" sits beside the registration price).
 */
export default async function FeesPage() {
  const [c, more] = await Promise.all([serverGet<{ homepage: Homepage }>("/homepage"), serverGet<{ page: ContentPage }>("/pages/fees")]);
  const h = c?.homepage ?? DEFAULT_HOMEPAGE;
  const all = sections(more?.page?.body ?? "");
  const included = all.find((s) => /includ/i.test(s.title));
  const questions = all.filter((s) => s !== included && /question|faq/i.test(s.title));
  const cards = all.filter((s) => s !== included && !questions.includes(s));

  return (
    <main className="page fees-page">
      <h1 className="page-title">Fees</h1>
      <div className="rule" />

      <section className="fees-top" aria-label="Registration fee">
        <div className="fees-price">
          <span className="fees-label">Registration</span>
          <span className="fees-amount">{h.registrationFee}</span>
          <span className="fees-label">{h.registrationFeeNote}</span>
          <Link href="/sign-up" className="btn dark">
            {h.registerButton}
          </Link>
        </div>
        {included && (
          <div className="fees-card fees-included">
            <h2>{included.title}</h2>
            <Markdown source={included.body} />
          </div>
        )}
      </section>

      {cards.length > 0 && (
        <section className="fees-cards" aria-label="Paying, discounts and refunds">
          {cards.map((s) => (
            <div key={s.title} className="fees-card">
              <h2>{s.title}</h2>
              <Markdown source={s.body} />
            </div>
          ))}
        </section>
      )}

      <section className="fees-cards two" aria-label="Coach and game-day fees">
        {h.leagueFees.length > 0 && (
          <div className="fees-card">
            <h2>Coaches &amp; team staff</h2>
            {h.leagueFees.map((f) => (
              <div className="fees-row" key={f.label}>
                <span>{f.label}</span>
                <b>{f.value}</b>
              </div>
            ))}
            <p className="muted">
              Refunded in full if you&rsquo;re not approved. <Link href="/coaches">Coaching with the NFFL</Link>
            </p>
          </div>
        )}
        {h.gateFees.length > 0 && (
          <div className="fees-card">
            <h2>Game-day gate</h2>
            {h.gateFees.map((f) => (
              <div className="fees-row" key={f.label}>
                <span>{f.label}</span>
                <b className={/^free$/i.test(f.value) ? "free" : undefined}>{f.value}</b>
              </div>
            ))}
          </div>
        )}
      </section>

      {questions.map((s) => (
        <section key={s.title} className="fees-card fees-questions">
          <h2>{s.title}</h2>
          <Markdown source={s.body} />
        </section>
      ))}
    </main>
  );
}
