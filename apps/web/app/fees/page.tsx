import type { Metadata } from "next";
import { DEFAULT_HOMEPAGE, type Homepage } from "@nffl/shared";
import { FeesSection } from "@/components/home-sections";
import { serverGet } from "@/lib/server-api";

export const metadata: Metadata = { title: "Fees" };
export const revalidate = 60;

/** Registration, league and gate fees (edited in Site content → Homepage). */
export default async function FeesPage() {
  const c = await serverGet<{ homepage: Homepage }>("/homepage");
  return (
    <main className="page">
      <FeesSection h={c?.homepage ?? DEFAULT_HOMEPAGE} asPage />
    </main>
  );
}
