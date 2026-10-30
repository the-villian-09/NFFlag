import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { LEAGUE_NAME } from "@/lib/brand";
import { PAGES, serverGet, type SiteInfo } from "@/lib/server-api";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: LEAGUE_NAME, template: `%s | NFFL` },
  description: "Youth flag football for boys and girls in North Florida. Football, fun, development, community.",
  // Favicon: app/icon.svg; home-screen icon: app/apple-icon.png (picked up automatically).
};

export const viewport: Viewport = { themeColor: "#011322" };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Banner + contact details, edited in the admin portal (refreshes about every minute).
  const site = await serverGet<SiteInfo>("/site");
  const banner = site?.announcement;
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Teko:wght@500;600;700&family=Barlow+Semi+Condensed:wght@500;600;700;800&display=swap"
        />
      </head>
      <body>
        {banner && (
          <div className="announce" role="region" aria-label="Announcement">
            <div className="container">
              <span>{banner.message}</span>
              {banner.linkHref && banner.linkText && (
                <Link href={banner.linkHref}>{banner.linkText} →</Link>
              )}
            </div>
          </div>
        )}
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="brand" aria-label={`${LEAGUE_NAME} home`}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/nffl-logo.svg" alt="" className="logo-outline" width={70} height={54} />
              <span>
                North Florida
                <br />
                Flag League
              </span>
            </Link>
            <SiteNav />
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="container footer-top">
            <div className="footer-brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/nffl-logo.svg" alt="" className="logo-outline" width={52} height={40} />
              <div>
                <strong>{LEAGUE_NAME}</strong>
                <span>Football · Fun · Development · Community</span>
              </div>
            </div>
            <nav aria-label="Footer" className="footer-links">
              {PAGES.map((p) => (
                <Link key={p.slug} href={`/${p.slug}`}>
                  {p.label}
                </Link>
              ))}
            </nav>
            {(site?.contact.publicEmail || site?.contact.phone) && (
              <div className="footer-contact">
                {site.contact.publicEmail && <a href={`mailto:${site.contact.publicEmail}`}>{site.contact.publicEmail}</a>}
                {site.contact.phone && <a href={`tel:${site.contact.phone.replace(/[^\d+]/g, "")}`}>{site.contact.phone}</a>}
              </div>
            )}
          </div>
          <div className="container footer-bottom">
            © {new Date().getFullYear()} {LEAGUE_NAME}
          </div>
        </footer>
      </body>
    </html>
  );
}
