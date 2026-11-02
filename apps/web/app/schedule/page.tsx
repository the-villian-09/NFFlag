import type { Metadata } from "next";
import Link from "next/link";
import { serverGet } from "@/lib/server-api";
import { ScheduleBrowser, type ScheduleDivision } from "@/components/schedule-browser";

export const metadata: Metadata = { title: "Schedule & standings" };
export const revalidate = 60;

interface Data {
  season: { id: string; name: string; seasonPassUrl?: string | null };
  divisions: ScheduleDivision[];
}

/** Public game schedule, results and standings for the current season. */
export default async function SchedulePage() {
  const data = await serverGet<Data>("/schedule");
  const divs = data?.divisions.filter((d) => d.games.length) ?? [];

  return (
    <main className="page">
      <h1 className="page-title">Schedule & standings</h1>
      <div className="rule" />
      {!data ? (
        <p className="muted">The schedule is temporarily unavailable. Please try again shortly.</p>
      ) : divs.length === 0 ? (
        <section className="card">
          <h2>Games coming soon</h2>
          <p className="muted">
            The {data.season.name} game schedule is posted after the draft. Practice nights and the season calendar are on the{" "}
            <Link href="/#schedule">home page</Link>.
          </p>
        </section>
      ) : (
        <>
          <p className="muted">{data.season.name}. All times are Jacksonville time.</p>
          <ScheduleBrowser divisions={divs} season={data.season} />
        </>
      )}
    </main>
  );
}
