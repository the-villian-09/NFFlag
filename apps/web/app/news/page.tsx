import type { Metadata } from "next";
import { serverGet } from "@/lib/server-api";
import type { NewsItem } from "@/components/season-home";

export const metadata: Metadata = { title: "League news" };
export const revalidate = 60;

const fmt = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" });

/** All league news, newest first (pinned posts on top). */
export default async function NewsPage() {
  const items = (await serverGet<{ items: NewsItem[] }>("/news?limit=100"))?.items;
  return (
    <main className="page">
      <h1 className="page-title">League news</h1>
      <div className="rule" />
      {!items ? (
        <p className="muted">News is temporarily unavailable. Please try again shortly.</p>
      ) : items.length === 0 ? (
        <p className="muted">No news yet. Check back during the season.</p>
      ) : (
        <div className="news-list">
          {items.map((n) => (
            <article key={n.id} id={`post-${n.id}`} className="news-post">
              {n.imageUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={n.imageUrl} alt="" loading="lazy" />
              )}
              <div className="news-body">
                <div className="sh-d">{fmt(n.publishedAt)}</div>
                <h2>{n.title}</h2>
                {n.body
                  .split(/\n\s*\n/)
                  .map((p) => p.trim())
                  .filter(Boolean)
                  .map((p, i) => (
                    <p key={i} style={{ whiteSpace: "pre-line" }}>
                      {p}
                    </p>
                  ))}
                {n.linkUrl && (
                  <p>
                    <a className="sh-more" href={n.linkUrl} {...(n.linkUrl.startsWith("/") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>
                      {`${n.linkText || "Read more"} →`}
                    </a>
                  </p>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
