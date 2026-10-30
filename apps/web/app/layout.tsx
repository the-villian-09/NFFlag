import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { SiteNav } from "@/components/site-nav";
import { LEAGUE_NAME } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: LEAGUE_NAME, template: `%s | NFFL` },
  description: "Youth flag football for boys and girls in North Florida. Football, fun, development, community.",
  // Favicon: app/icon.svg; home-screen icon: app/apple-icon.png (picked up automatically).
};

export const viewport: Viewport = { themeColor: "#011322" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
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
          <div className="container">
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/images/nffl-logo.svg" alt="" className="logo-outline" width={52} height={40} />
              <span>
                © {new Date().getFullYear()} {LEAGUE_NAME}
              </span>
            </div>
            <span>Football · Fun · Development · Community</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
