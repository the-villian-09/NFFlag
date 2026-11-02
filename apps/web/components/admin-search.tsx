"use client";

/**
 * Admin search: jump to an admin page by name ("refund", "pay referees"), or
 * find a player, family, coach or referee by name or email.
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { visibleGroups } from "@/lib/admin-nav";

interface Result {
  type: "page" | "player" | "family" | "coach" | "referee";
  label: string;
  detail: string;
  href: string;
}
const TYPE: Record<Result["type"], string> = { page: "Page", player: "Player", family: "Family", coach: "Coach", referee: "Referee" };

export function AdminSearch({ permissions }: { permissions: string[] }) {
  const router = useRouter();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const pages = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return visibleGroups(permissions)
      .flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })))
      .filter((i) => `${i.label} ${i.blurb} ${i.keywords ?? ""} ${i.group}`.toLowerCase().includes(t))
      .slice(0, 4)
      .map<Result>((i) => ({ type: "page", label: i.label, detail: i.group, href: i.href }));
  }, [q, permissions]);

  // People: asked for 250 ms after typing stops.
  useEffect(() => {
    const t = q.trim();
    if (t.length < 2) {
      setPeople([]);
      return;
    }
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .get<{ items: Result[] }>(`/admin/search?q=${encodeURIComponent(t)}`)
        .then((r) => setPeople(r.items))
        .catch(() => setPeople([]))
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  // "/" jumps to the search box from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === "/" && tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const results = [...pages, ...people];
  useEffect(() => setActive(0), [q, people.length]);

  function go(r: Result | undefined) {
    if (!r) return;
    setOpen(false);
    setQ("");
    router.push(r.href);
  }

  return (
    <div className="admin-search" role="search">
      <label htmlFor="admin-search-input" className="sr-only">
        Search the admin portal
      </label>
      <input
        ref={input}
        id="admin-search-input"
        type="search"
        placeholder="Search people or pages…  ( / )"
        autoComplete="off"
        value={q}
        role="combobox"
        aria-expanded={open && q.trim().length > 0}
        aria-controls={listId}
        aria-activedescendant={results[active] ? `${listId}-${active}` : undefined}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(results[active]);
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
      />
      {open && q.trim().length > 0 && (
        <ul id={listId} className="admin-search-results" role="listbox">
          {results.map((r, i) => (
            <li
              key={`${r.type}-${r.href}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? "on" : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                go(r);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="type">{TYPE[r.type]}</span>
              <span className="what">
                <strong>{r.label}</strong>
                <span>{r.detail}</span>
              </span>
            </li>
          ))}
          {results.length === 0 && (
            <li className="empty">{loading || q.trim().length < 2 ? "Searching…" : "No matches. Try a first or last name, family name or email."}</li>
          )}
        </ul>
      )}
    </div>
  );
}
