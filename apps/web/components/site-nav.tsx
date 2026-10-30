"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LINKS = [
  { href: "/about", label: "About" },
  { href: "/#divisions", label: "Divisions" },
  { href: "/#schedule", label: "Schedule" },
  { href: "/#fees", label: "Fees" },
  { href: "/contact", label: "Contact" },
];

/**
 * Header navigation. Desktop: one row of links. Phones and small tablets (≤960px): Register
 * button plus a menu button that opens a full-width list.
 */
export function SiteNav() {
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

  return (
    <>
      <nav className="site-nav desktop-nav" aria-label="Main">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}>
            {l.label}
          </Link>
        ))}
        <Link href="/dashboard" className="nav-signin">
          My account
        </Link>
        <Link href="/sign-up" className="btn small">
          Register
        </Link>
      </nav>

      <div className="mobile-actions">
        <Link href="/sign-up" className="btn small" onClick={close}>
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
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} onClick={close}>
            {l.label}
          </Link>
        ))}
        <Link href="/dashboard" className="nav-signin" onClick={close}>
          My account
        </Link>
      </nav>
    </>
  );
}
