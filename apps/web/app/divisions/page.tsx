import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_HOMEPAGE, type Homepage, type ImageSlots } from "@nffl/shared";
import { DivisionsSection } from "@/components/home-sections";
import { serverGet } from "@/lib/server-api";

export const metadata: Metadata = { title: "Divisions" };
export const revalidate = 60;

/** Boys and girls divisions (edited in Site content → Homepage). */
export default async function DivisionsPage() {
  const c = await serverGet<{ homepage: Homepage; images?: Partial<ImageSlots> }>("/homepage");
  return (
    <main className="page">
      <DivisionsSection h={c?.homepage ?? DEFAULT_HOMEPAGE} images={c?.images ?? {}} asPage />
      <p style={{ marginTop: 24 }}>
        See every division&rsquo;s games and standings on the <Link href="/schedule">schedule</Link>.
      </p>
    </main>
  );
}
