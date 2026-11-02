"use client";

/**
 * Frame for every admin page: the side menu (grouped, with counts) on
 * computers, an "Admin menu" button on phones. The portal home has no side
 * menu; it shows the same groups as tiles. Also shares the "Needs attention"
 * counts with the portal home.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { badgeFor, visibleGroups, type AttentionItem } from "@/lib/admin-nav";
import { isAdmin, useMe } from "@/lib/use-me";

const AttentionContext = createContext<{ items: AttentionItem[] | null; refresh: () => void }>({ items: null, refresh: () => undefined });
export const useAttention = () => useContext(AttentionContext);

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { me } = useMe();
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const admin = !!me && isAdmin(me);

  const refresh = useCallback(() => {
    api
      .get<{ items: AttentionItem[] }>("/admin/summary")
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, []);
  // Counts change as admins work, so they're re-read on every page change.
  useEffect(() => {
    if (admin) refresh();
    setOpen(false);
  }, [admin, pathname, refresh]);

  const home = pathname === "/admin";
  if (!admin || home) return <AttentionContext.Provider value={{ items, refresh }}>{children}</AttentionContext.Provider>;

  const groups = visibleGroups(me!.permissions);
  // The most specific menu item for this page (Pay referees wins over Referees on /admin/referees/pay).
  const current = groups
    .flatMap((g) => g.items)
    .filter((i) => pathname === i.href || pathname.startsWith(i.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0];

  const menu = (
    <nav aria-label="Admin">
      <Link className="admin-nav-home" href="/admin">
        Admin portal
      </Link>
      {groups.map((g) => (
        <div key={g.title}>
          <h4>{g.title}</h4>
          {g.items.map((i) => {
            const b = badgeFor(i, items ?? []);
            return (
              <Link key={i.href} href={i.href} className={`admin-nav-item${current?.href === i.href ? " on" : ""}`} aria-current={current?.href === i.href ? "page" : undefined}>
                <span>{i.label}</span>
                {b && <span className={`admin-badge ${b.tone}`}>{b.text}</span>}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );

  return (
    <AttentionContext.Provider value={{ items, refresh }}>
      <div className="admin-shell">
        <aside className="admin-side">{menu}</aside>
        <div className="admin-body">
          <div className="admin-menubar">
            <button type="button" aria-expanded={open} aria-controls="admin-menu-panel" onClick={() => setOpen(!open)}>
              ☰ Admin menu
            </button>
            <span>{current?.label ?? ""}</span>
          </div>
          {open && (
            <div id="admin-menu-panel" className="admin-menu-panel">
              {menu}
            </div>
          )}
          {children}
        </div>
      </div>
    </AttentionContext.Provider>
  );
}
