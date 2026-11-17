import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ShareGameButton } from "@/components/share-game";
import { TicketButton } from "@/components/ticket-button";
import { LEAGUE_NAME } from "@/lib/brand";
import { clock, gamePath, imagePath, isFinal, longDate, recordText, shareText, shareTitle, type PublicGame } from "@/lib/game-share";
import { GAME_STATUS } from "@/lib/schedule";
import { serverGet } from "@/lib/server-api";

export const revalidate = 60;

const load = (id: string) => (/^[0-9a-f-]{36}$/i.test(id) ? serverGet<PublicGame>(`/games/${id}`, 60) : Promise.resolve(null));

/** The address people reached the site on (nfflag.com or staging), for absolute links in previews. */
async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "nfflag.com";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const d = await load(id);
  if (!d) return { title: "Game not found" };
  const base = await origin();
  const title = shareTitle(d.game);
  const description = shareText(d.game, d.division.name);
  const image = { url: `${base}${imagePath(id, "og")}`, width: 1200, height: 630, alt: title };
  return {
    title,
    description,
    alternates: { canonical: `${base}${gamePath(id)}` },
    openGraph: { type: "website", siteName: LEAGUE_NAME, title, description, url: `${base}${gamePath(id)}`, images: [image] },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}

/** One game's public page: what a shared link opens. */
export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const d = await load(id);
  if (!d) notFound();
  const g = d.game;
  const final = isFinal(g);
  const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(g.location)}`;
  return (
    <main className="page game-page">
      <p className="game-kicker">
        {d.division.name} · {d.season.name}
      </p>
      {final ? (
        <h1 className="game-final" aria-label={`Final: ${g.home} ${g.homeScore}, ${g.away} ${g.awayScore}`}>
          <span className={g.homeScore! > g.awayScore! ? "won" : undefined}>
            {g.home} <b>{g.homeScore}</b>
          </span>
          <span className={g.awayScore! > g.homeScore! ? "won" : undefined}>
            {g.away} <b>{g.awayScore}</b>
          </span>
        </h1>
      ) : (
        <h1 className="game-matchup" style={g.status === "cancelled" ? { textDecoration: "line-through", opacity: 0.7 } : undefined}>
          {g.home} <span className="res-vs">vs</span> {g.away}
        </h1>
      )}
      {g.status !== "scheduled" && <p className={`status ${GAME_STATUS[g.status].tone}`}>{GAME_STATUS[g.status].label}</p>}

      <section className="card game-facts">
        <div>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="2" />
            <path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
          <span>
            <strong>{longDate(g.startsAt)}</strong>
            <span className="muted">{clock(g.startsAt)} Eastern Time</span>
          </span>
        </div>
        <div>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z" />
            <circle cx="12" cy="9" r="2.5" />
          </svg>
          <span>
            <strong>{g.location}</strong>
            <a href={maps} target="_blank" rel="noopener noreferrer">
              Get directions
            </a>
          </span>
        </div>
        {final && (
          <p className="muted" style={{ margin: 0 }}>
            Records this season: {g.home} {recordText(d.records.home)} · {g.away} {recordText(d.records.away)}
          </p>
        )}
      </section>

      <div className="game-actions">
        <TicketButton g={g} />
        {!final && g.status !== "cancelled" && (
          <a className="btn ghost small" href={`${gamePath(id)}/calendar`}>
            Add to calendar
          </a>
        )}
        <ShareGameButton game={g} division={d.division.name} />
      </div>

      <p className="muted game-save">
        Posting on Instagram? Save the image:{" "}
        <a href={imagePath(id, "square", true)} download>
          post
        </a>{" "}
        ·{" "}
        <a href={imagePath(id, "story", true)} download>
          story
        </a>
      </p>
      <p>
        <Link href={`/schedule?q=${encodeURIComponent(d.division.name)}`}>See the full {d.division.name} schedule →</Link>
      </p>
      <section className="game-join">
        <h2>Want your child to play?</h2>
        <p className="muted">
          See the <Link href="/divisions">divisions</Link> and <Link href="/fees">fees</Link>, or <Link href="/sign-up">create a family account</Link>.
        </p>
      </section>
    </main>
  );
}
