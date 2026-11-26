"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import type { SiteLink } from "@/lib/server-api";

const LINKS = [
  { href: "/about", label: "About" },
  { href: "/divisions", label: "Divisions" },
  { href: "/schedule", label: "Schedule" },
  { href: "/fees", label: "Fees" },
  { href: "/contact", label: "Contact" },
];

/**
 * Header navigation. Desktop: one row of links. Phones and small tablets (≤960px): Register
 * button plus a menu button that opens a full-width list.
 */
export function SiteNav({ extra = [] }: { extra?: SiteLink[] }) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close when the page changes or Escape is pressed.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => setOpen(false);

  // "Sign in" for visitors, "My account" once signed in. Rechecked on each page
  // change so it updates right after signing in or out.
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => live && setSignedIn(!!s?.session))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [pathname]);
  const account = signedIn ? { href: "/dashboard", label: "My account" } : { href: "/sign-in", label: "Sign in" };
  // Pages the league added: in the phone menu before Contact; on a computer under "More" so the header stays on one line.
  const links = [...LINKS.slice(0, -1), ...extra, LINKS[LINKS.length - 1]!];
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => setMoreOpen(false), [pathname]);
  // Close "More" on a click anywhere else.
  useEffect(() => {
    if (!moreOpen) return;
    const away = (e: MouseEvent) => !(e.target as Element).closest?.(".nav-more") && setMoreOpen(false);
    document.addEventListener("click", away);
    return () => document.removeEventListener("click", away);
  }, [moreOpen]);

  return (
    <>
      <nav className={`site-nav desktop-nav${extra.length ? " has-more" : ""}`} aria-label="Main">
        {LINKS.slice(0, -1).map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
        {extra.length > 0 && (
          <div className="nav-more" onKeyDown={(e) => e.key === "Escape" && setMoreOpen(false)}>
            <button type="button" aria-expanded={moreOpen} aria-controls="nav-more-list" onClick={() => setMoreOpen((o) => !o)}>
              More
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
            {moreOpen && (
              <div id="nav-more-list" className="nav-more-list">
                {extra.map((l) => (
                  <Link key={l.href} href={l.href} onClick={() => setMoreOpen(false)}>
                    {l.label}
                  </Link>
                ))}
              </div>
            )}
          </div>
        )}
        <Link href={LINKS[LINKS.length - 1]!.href}>{LINKS[LINKS.length - 1]!.label}</Link>
        <Link href={account.href} className="nav-signin">
          {account.label}
        </Link>
        <Link href={signedIn ? "/register" : "/sign-up"} className="btn small">
          Register
        </Link>
      </nav>

      <div className="mobile-actions">
        <Link href={signedIn ? "/register" : "/sign-up"} className="btn small" onClick={close}>
          Register
        </Link>
        <button
          type="button"
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((o) => !o)}
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" />
            )}
          </svg>
        </button>
      </div>

      <nav id="mobile-menu" className="mobile-menu" data-open={open} aria-label="Main" hidden={!open}>
        {links.map((l) => (
          <Link key={l.href} href={l.href} onClick={close}>
            {l.label}
          </Link>
        ))}
        <Link href={account.href} className="nav-signin" onClick={close}>
          {account.label}
        </Link>
      </nav>
    </>
  );
}
