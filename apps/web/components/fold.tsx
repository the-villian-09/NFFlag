"use client";

/**
 * My account on phones: each card folds into one tappable line with a short
 * summary, and a jump bar pinned at the top lists the sections on the page.
 * On wider screens a Fold is just the usual card (heading + content).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

const PHONE = "(max-width: 700px)";

export function useIsPhone() {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(PHONE);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(PHONE).matches,
    () => false,
  );
}

interface Entry {
  id: string;
  label: string;
  order: number;
  attention: boolean;
}
interface Ctx {
  open: Set<string>;
  toggle: (id: string, to?: boolean) => void;
  register: (e: Entry) => void;
  unregister: (id: string) => void;
  entries: Entry[];
}
const FoldCtx = createContext<Ctx | null>(null);

export function FoldProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [entries, setEntries] = useState<Entry[]>([]);
  const toggle = useCallback((id: string, to?: boolean) => {
    setOpen((cur) => {
      const next = new Set(cur);
      if (to ?? !next.has(id)) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const register = useCallback((e: Entry) => {
    setEntries((cur) => {
      const same = cur.find((x) => x.id === e.id);
      if (same && same.label === e.label && same.attention === e.attention && same.order === e.order) return cur;
      return [...cur.filter((x) => x.id !== e.id), e].sort((a, b) => a.order - b.order);
    });
  }, []);
  const unregister = useCallback((id: string) => setEntries((cur) => cur.filter((x) => x.id !== id)), []);
  const value = useMemo(() => ({ open, toggle, register, unregister, entries }), [open, toggle, register, unregister, entries]);
  return <FoldCtx.Provider value={value}>{children}</FoldCtx.Provider>;
}

/** The pinned row of section buttons (phones only). */
export function JumpBar() {
  const ctx = useContext(FoldCtx);
  const phone = useIsPhone();
  if (!ctx || !phone || ctx.entries.length < 3) return null;
  const go = (id: string) => {
    ctx.toggle(id, true);
    // After it opens, bring its top just under the pinned bars.
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  return (
    <div className="jump-wrap">
      <nav className="jump" aria-label="Jump to a section">
        {ctx.entries.map((e) => (
          <button key={e.id} type="button" className={`jump-chip ${e.attention ? "warn" : ""}`} onClick={() => go(e.id)}>
            {e.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

export function Fold({
  id,
  title,
  short,
  chip,
  summary,
  badge,
  tone = "info",
  order,
  startOpen = false,
  children,
}: {
  id: string;
  title: string;
  /** Shorter heading for phones, so it fits on one line (defaults to the title). */
  short?: string;
  /** Short name on the jump bar (defaults to the title). */
  chip?: string;
  /** One line shown while folded. */
  summary?: ReactNode;
  badge?: string | null;
  tone?: "info" | "warn" | "ok";
  /** Position on the jump bar. */
  order: number;
  /** Open on first load (e.g. something needs doing). */
  startOpen?: boolean;
  children: ReactNode;
}) {
  const ctx = useContext(FoldCtx);
  const phone = useIsPhone();
  const attention = tone === "warn" && !!badge;
  const register = ctx?.register;
  const unregister = ctx?.unregister;
  const toggle = ctx?.toggle;
  useEffect(() => {
    register?.({ id, label: chip ?? title, order, attention });
  }, [register, id, chip, title, order, attention]);
  useEffect(() => () => unregister?.(id), [unregister, id]);
  useEffect(() => {
    if (startOpen) toggle?.(id, true);
  }, [startOpen, toggle, id]);

  if (!phone || !ctx) {
    return (
      <section className="card" id={id}>
        <h2>{title}</h2>
        {children}
      </section>
    );
  }
  const open = ctx.open.has(id);
  return (
    <section className={`card fold ${open ? "open" : ""}`} id={id}>
      <button type="button" className="fold-head" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => ctx.toggle(id)}>
        <span className="fold-text">
          <span className="fold-title">{short ?? title}</span>
          {(summary || badge) && (
            <span className="fold-sub">
              {badge && <span className={`fold-badge ${tone}`}>{badge}</span>}
              {summary && <span className="fold-sum">{summary}</span>}
            </span>
          )}
        </span>
        <svg className="fold-chev" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M4 7l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      </button>
      <div id={`${id}-body`} className="fold-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
