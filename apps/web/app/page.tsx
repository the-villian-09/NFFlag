import Link from "next/link";

/**
 * Public home. Rendered on the server so it is fast and indexable.
 * R1a replaces the copy with admin-editable content blocks.
 */

interface CurrentSeason {
  season: { name: string; status: string; registrationOpensAt: string | null };
}

async function getSeason(): Promise<CurrentSeason | null> {
  const origin = process.env.API_ORIGIN ?? "http://localhost:8080";
  try {
    const res = await fetch(`${origin}/api/v1/seasons/current`, { next: { revalidate: 60 } });
    return res.ok ? ((await res.json()) as CurrentSeason) : null;
  } catch {
    return null;
  }
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" });
}

export default async function Home() {
  const data = await getSeason();
  const opens = data?.season.registrationOpensAt;
  return (
    <>
      <section className="hero">
        <div className="inner">
          {data && <div className="badge">{data.season.name}</div>}
          <h1>North Florida Flag Football</h1>
          <p>
            {opens ? `Registration opens ${formatDate(opens)}. ` : ""}
            Create your family account now so you're ready on day one.
          </p>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <Link href="/sign-up" className="btn accent">
              Create account
            </Link>
            <Link href="/sign-in" className="btn ghost" style={{ color: "#fff", borderColor: "rgba(255,255,255,.4)" }}>
              Sign in
            </Link>
          </div>
        </div>
      </section>
      <main className="page">
        <div className="grid">
          <div className="card">
            <h2>Divisions and fees</h2>
            <p className="muted">Published before registration opens.</p>
          </div>
          <div className="card">
            <h2>Schedules</h2>
            <p className="muted">Coming soon.</p>
          </div>
          <div className="card">
            <h2>Coaches and volunteers</h2>
            <p className="muted">Applications open with registration.</p>
          </div>
        </div>
      </main>
    </>
  );
}
