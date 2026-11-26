import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_HOMEPAGE, type Homepage } from "@nffl/shared";
import { FeesSection } from "@/components/home-sections";
import { Markdown } from "@/components/markdown";
import { serverGet, type ContentPage } from "@/lib/server-api";

export const metadata: Metadata = {
  title: "Fees",
  description: "Registration, coach and game-day fees, what's included, paying and refunds.",
};
export const revalidate = 60;

/**
 * Price boxes (Site content → Homepage) and the details below them
 * (Site content → Pages → Fees page).
 */
export default async function FeesPage() {
  const [c, more] = await Promise.all([serverGet<{ homepage: Homepage }>("/homepage"), serverGet<{ page: ContentPage }>("/pages/fees")]);
  const h = c?.homepage ?? DEFAULT_HOMEPAGE;
  return (
    <main className="page">
      <FeesSection h={h} asPage />
      <p style={{ marginTop: 24 }}>
        <Link href="/sign-up" className="btn">
          {h.registerButton}
        </Link>
      </p>
      {more?.page?.body && (
        <section className="div-more">
          <Markdown source={more.page.body} />
        </section>
      )}
    </main>
  );
}
