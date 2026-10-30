import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "North Florida Flag Football", template: "%s | NFFL" },
  description: "Youth flag football in North Florida. Registration, schedules and league news.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="inner">
            <Link href="/" className="wordmark">
              NFFL <span>Flag</span>
            </Link>
            <nav aria-label="Main">
              <Link href="/dashboard">My account</Link>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
