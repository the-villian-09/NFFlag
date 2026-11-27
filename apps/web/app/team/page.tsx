"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";
import { RSVP_LABEL, STAFF_ROLE, stamp, useTeamLive, when, type Rsvp, type SpaceSummary } from "@/lib/team-chat";

/** My teams: every team space this person belongs to, newest season first. */
export default function MyTeamsPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [items, setItems] = useState<SpaceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ items: SpaceSummary[] }>("/team-spaces")
      .then((r) => setItems(r.items))
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else if (err instanceof ApiError && err.code === "FEATURE_DISABLED") setError("Team pages open soon. We'll email you when they're ready.");
        else setError(err instanceof Error ? err.message : "Couldn't load your teams.");
      });
  }, [router]);

  useEffect(() => {
    if (me) load();
  }, [me, load]);
  useTeamLive(() => load(), load);

  async function answer(s: SpaceSummary, playerId: string, status: Rsvp) {
    if (!s.next) return;
    await api.put(`/team-spaces/${s.teamId}/rsvp`, { eventType: s.next.type, eventId: s.next.id, playerId, status });
    load();
  }

  if (loading || !me) return <main className="page muted">Loading…</main>;
  return (
    <main className="page tc-page">
      <p>
        <Link href="/dashboard">← My account</Link>
      </p>
      <h1>My teams</h1>
      <ErrorAlert error={error} />
      {items === null && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && (
        <section className="card">
          <h2>No teams yet</h2>
          <p className="muted">Your team shows up here once the draft is done and rosters are published. Coaches and team moms see their team as soon as the league places them.</p>
        </section>
      )}
      <div className="tc-list">
        {items?.map((s) => {
          const unread = s.unread.feed + s.unread.chat + s.unread.staff;
          return (
            <article key={s.teamId} className="tc-team" style={{ ["--team" as string]: s.color ?? "var(--lime)" }}>
              <Link className="tc-team-head" href={`/team/${s.teamId}`}>
                <span>
                  <span className="tc-team-name">{s.teamName}</span>
                  <span className="muted">
                    {s.divisionName} · {s.seasonName}
                    {s.readOnly ? " · Past season" : ""}
                  </span>
                  <span className="tc-role">
                    {s.role === "staff" ? (STAFF_ROLE[s.staffRole ?? ""] ?? "Staff") : `${s.children.map((c) => c.name).join(" & ")}'s team`}
                  </span>
                </span>
                {unread > 0 && (
                  <span className="tc-badge" aria-label={`${unread} unread`}>
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </Link>
              {s.pinned && (
                <Link href={`/team/${s.teamId}`} className={`tc-pinned ${s.pinned.kind === "alert" ? "alert" : ""}`}>
                  <strong>{s.pinned.kind === "alert" ? "Alert" : "Pinned"}</strong> {s.pinned.body.split("\n")[0]}
                </Link>
              )}
              {s.next && (
                <div className="tc-next">
                  <div>
                    <span className="tc-kicker">Next up</span>
                    <strong>{s.next.title}</strong> · {when(s.next.startsAt)}
                    <br />
                    <span className="muted">{s.next.location}</span>
                  </div>
                  {s.next.myRsvps.map((r) => (
                    <div key={r.playerId} className="tc-rsvp-row">
                      {s.next!.myRsvps.length > 1 && <span className="tc-rsvp-name">{r.name}</span>}
                      <div className="tc-chips" role="group" aria-label={`Is ${r.name} coming?`}>
                        {(["yes", "maybe", "no"] as Rsvp[]).map((v) => (
                          <button key={v} type="button" className={`tc-chip ${v}`} aria-pressed={r.status === v} onClick={() => void answer(s, r.playerId, v)}>
                            {RSVP_LABEL[v]}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {s.latest && !s.next && (
                <p className="tc-latest muted">
                  {s.latest.authorName}: {s.latest.body.slice(0, 90)} · {stamp(s.latest.createdAt)}
                </p>
              )}
            </article>
          );
        })}
      </div>
    </main>
  );
}
