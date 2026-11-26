import type { Metadata } from "next";
import Link from "next/link";
import { DEFAULT_HOMEPAGE, type Homepage, type ImageSlots } from "@nffl/shared";
import { DivisionsSection } from "@/components/home-sections";
import { Markdown } from "@/components/markdown";
import { serverGet, type ContentPage } from "@/lib/server-api";

export const metadata: Metadata = {
  title: "Divisions",
  description: "Boys and girls flag football divisions by age, which division your child is in, and what to expect at each age.",
};
export const revalidate = 60;

interface Division {
  id: string;
  name: string;
  genderPolicy: "boys" | "girls" | "coed";
  birthDateFrom: string | null;
  birthDateTo: string | null;
  eligibilityNotes: string | null;
  full: boolean;
}

const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function born(d: Division) {
  if (d.birthDateFrom && d.birthDateTo) return `${fmt(d.birthDateFrom)} – ${fmt(d.birthDateTo)}`;
  if (d.birthDateFrom) return `On or after ${fmt(d.birthDateFrom)}`;
  if (d.birthDateTo) return `On or before ${fmt(d.birthDateTo)}`;
  return "Any";
}

const GROUPS = [
  { key: "boys", label: "Boys" },
  { key: "girls", label: "Girls" },
  { key: "coed", label: "Boys and girls" },
] as const;

/**
 * Boys and girls divisions (labels and photos: Site content → Homepage), the
 * live "Find your division" chart (Admin → Seasons & divisions), and the
 * text below it (Site content → Pages → Divisions page).
 */
export default async function DivisionsPage() {
  const [c, live, more] = await Promise.all([
    serverGet<{ homepage: Homepage; images?: Partial<ImageSlots> }>("/homepage"),
    serverGet<{ season: { name: string } | null; divisions: Division[] }>("/divisions/current"),
    serverGet<{ page: ContentPage }>("/pages/divisions"),
  ]);
  const divisions = live?.divisions ?? [];
  const groups = GROUPS.map((g) => ({ ...g, items: divisions.filter((d) => d.genderPolicy === g.key) })).filter((g) => g.items.length);

  return (
    <main className="page">
      <DivisionsSection h={{ ...DEFAULT_HOMEPAGE, ...c?.homepage }} images={c?.images ?? {}} asPage />
      <p style={{ marginTop: 24 }}>
        See every division&rsquo;s games and standings on the <Link href="/schedule">schedule</Link>.
      </p>

      {groups.length > 0 && (
        <section className="div-finder" aria-labelledby="finder-title">
          <h2 id="finder-title">Find your division</h2>
          <p className="muted">
            {live?.season ? `${live.season.name}: ` : ""}find your child&rsquo;s birth date below. When you register, the site only shows the divisions your child can join.
          </p>
          <div className="div-finder-groups">
            {groups.map((g) => (
              <div key={g.key} className={`div-finder-group ${g.key}`}>
                <h3>{g.label}</h3>
                <div className="table-wrap">
                  <table className="simple">
                    <thead>
                      <tr>
                        <th>Division</th>
                        <th>Born</th>
                        <th>Spots</th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <strong>{d.name}</strong>
                            {d.eligibilityNotes && <span className="muted div-note">{d.eligibilityNotes}</span>}
                          </td>
                          <td>{born(d)}</td>
                          <td>{d.full ? <span className="status warn">Full · waitlist</span> : <span className="status ok">Open</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {more?.page?.body && (
        <section className="div-more">
          <Markdown source={more.page.body} />
        </section>
      )}
    </main>
  );
}
