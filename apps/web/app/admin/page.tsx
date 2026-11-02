"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AdminSearch } from "@/components/admin-search";
import { useAttention } from "@/components/admin-shell";
import { api } from "@/lib/api";
import { attentionFigure, badgeFor, visibleGroups } from "@/lib/admin-nav";
import { isAdmin, useMe } from "@/lib/use-me";

/** Admin portal home: what needs attention, then every admin area grouped by what it's for. */
export default function AdminPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const { items: attention } = useAttention();
  const [off, setOff] = useState<Set<string>>(new Set());
  const [season, setSeason] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    if (!isAdmin(me)) {
      router.replace("/dashboard");
      return;
    }
    // Release switches that are off (only people who can change them see the "Off" chips).
    if (me.permissions.includes("platform.flags.manage")) {
      api
        .get<{ items: { key: string; enabled: boolean }[] }>("/admin/flags")
        .then((r) => setOff(new Set(r.items.filter((f) => !f.enabled).map((f) => f.key))))
        .catch(() => undefined);
    }
    api
      .get<{ items: { name: string; isCurrent: string | null }[] }>("/admin/league/seasons")
      .then((r) => setSeason(r.items.find((s) => s.isCurrent)?.name ?? null))
      .catch(() => undefined);
  }, [me, router]);

  if (loading || !me) return <main className="page muted">Loading…</main>;
  const groups = visibleGroups(me.permissions);
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "America/New_York" });

  return (
    <main className="page">
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <div className="portal-head">
        <div>
          <h1>Admin portal</h1>
          <p className="muted" style={{ margin: 0 }}>
            {season ? `${season} · ` : ""}
            {today}
          </p>
        </div>
        <AdminSearch permissions={me.permissions} />
      </div>

      {attention && attention.length > 0 && (
        <section className="attention" aria-labelledby="attention-title">
          <h2 id="attention-title">Needs attention</h2>
          <ul>
            {attention.map((a) => (
              <li key={a.key}>
                <Link href={a.href}>
                  <span className={`attention-n ${a.tone}`}>{attentionFigure(a)}</span>
                  <span>{a.label}</span>
                  <span className="go" aria-hidden="true">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {attention && attention.length === 0 && (
        <p className="all-clear">
          <span className="status ok">All caught up</span> Nothing is waiting on you right now.
        </p>
      )}

      {groups.map((g) => (
        <section key={g.title} className="portal-group" aria-label={g.title}>
          <h3>{g.title}</h3>
          <div className="portal-tiles">
            {g.items.map((i) => {
              const b = badgeFor(i, attention ?? []);
              return (
                <Link key={i.href} href={i.href} className="portal-tile">
                  <strong>{i.label}</strong>
                  <span>{i.blurb}</span>
                  {b ? (
                    <span className={`admin-badge ${b.tone}`}>{b.text}</span>
                  ) : i.flag && off.has(i.flag) ? (
                    <span className="tile-off" title="Its release switch is off: families and coaches don't see it yet">
                      Off
                    </span>
                  ) : null}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </main>
  );
}
