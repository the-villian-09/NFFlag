"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ErrorAlert, useAction } from "@/components/form";
import { api, ApiError } from "@/lib/api";
import { useMe } from "@/lib/use-me";

const ROLE: Record<string, string> = { head_coach: "Head Coach", assistant_coach: "Assistant Coach", team_manager: "Team Mom" };

interface StaffMember {
  teamId: string;
  userId: string;
  roleKey: string;
  name: string;
}
interface Team {
  id: string;
  name: string;
  players: number;
  staff: StaffMember[];
}
interface Division {
  id: string;
  name: string;
  draft: { status: string; publishedAt: string | null };
  available: number;
  awaitingReview: number;
  teams: Team[];
}
interface PoolPerson {
  userId: string;
  roleKey: string;
  name: string;
  assignments: { teamId: string; teamName: string }[];
}
interface Season {
  id: string;
  name: string;
  isCurrent: string | null;
}

/** Admin: teams per division, coaches and team moms, and links to each division's draft. */
export default function AdminTeamsPage() {
  const router = useRouter();
  const { me, loading } = useMe();
  const [seasons, setSeasons] = useState<Season[]>([]);
  const [seasonId, setSeasonId] = useState("");
  const [data, setData] = useState<{ items: Division[]; staffPool: PoolPerson[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    api
      .get<{ items: Season[] }>("/admin/league/seasons")
      .then((r) => {
        setSeasons(r.items);
        setSeasonId((r.items.find((s) => s.isCurrent) ?? r.items[0])?.id ?? "");
      })
      .catch((err) => {
        if (err instanceof ApiError && (err.code === "SESSION_IDLE" || err.status === 401)) router.replace("/sign-in");
        else setError(err instanceof Error ? err.message : "Couldn't load.");
      });
  }, [me, router]);

  const load = useCallback(() => {
    if (!seasonId) return;
    api
      .get<{ items: Division[]; staffPool: PoolPerson[] }>(`/admin/teams/seasons/${seasonId}`)
      .then(setData)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) router.replace("/admin");
        else setError(err instanceof Error ? err.message : "Couldn't load teams.");
      });
  }, [seasonId, router]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading || !me) return <main className="page muted">Loading…</main>;

  return (
    <main className="page">
      <p>
        <Link href="/admin">← Admin portal</Link>
      </p>
      <h1>Teams & draft</h1>
      <p className="muted">
        Create each division's teams and add their coaches and team moms (from approved applications). A coach's or team mom's own child in
        that division goes on their team automatically and counts as one of the team's first picks. Then run the draft.
      </p>
      <ErrorAlert error={error} />
      <div className="filters">
        <label>
          Season
          <select value={seasonId} onChange={(e) => setSeasonId(e.target.value)}>
            {seasons.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!data ? (
        !error && <p className="muted">Loading…</p>
      ) : data.items.length === 0 ? (
        <p className="muted">This season has no divisions yet. Add them under Seasons.</p>
      ) : (
        data.items.map((d) => <DivisionCard key={d.id} d={d} pool={data.staffPool} onChanged={load} />)
      )}
    </main>
  );
}

const DRAFT: Record<string, { label: string; tone: string }> = {
  setup: { label: "Draft not started", tone: "muted" },
  live: { label: "Draft live", tone: "warn" },
  complete: { label: "Draft finished", tone: "info" },
};

function DivisionCard({ d, pool, onChanged }: { d: Division; pool: PoolPerson[]; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const [name, setName] = useState("");
  const status = d.draft.publishedAt ? { label: "Rosters published", tone: "ok" } : DRAFT[d.draft.status] ?? DRAFT.setup!;

  async function addTeam(e: React.FormEvent) {
    e.preventDefault();
    if ((await run(() => api.post(`/admin/teams/divisions/${d.id}/teams`, { name }))) !== undefined) {
      setName("");
      onChanged();
    }
  }

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "baseline" }}>
        <h2>{d.name}</h2>
        <span className={`status ${status.tone}`}>{status.label}</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {d.available} approved player{d.available === 1 ? "" : "s"} not on a team
        {d.awaitingReview ? ` · ${d.awaitingReview} registration${d.awaitingReview === 1 ? "" : "s"} still awaiting review` : ""}
      </p>
      <ErrorAlert error={error} />
      <div className="grid">
        {d.teams.map((t) => (
          <TeamCard key={t.id} t={t} pool={pool} locked={d.draft.status !== "setup"} onChanged={onChanged} />
        ))}
      </div>
      {d.draft.status === "setup" && (
        <form onSubmit={addTeam} style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 16 }}>
          <label style={{ flex: "1 1 220px" }}>
            New team name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} placeholder="Lightning" />
          </label>
          <button className="btn ghost" disabled={busy}>
            + Add team
          </button>
        </form>
      )}
      <p style={{ marginTop: 16 }}>
        <Link className="btn" href={`/admin/draft/${d.id}`}>
          {d.draft.status === "setup" ? "Set up the draft" : d.draft.status === "live" ? "Open the live draft" : "View rosters"}
        </Link>
      </p>
    </section>
  );
}

function TeamCard({ t, pool, locked, onChanged }: { t: Team; pool: PoolPerson[]; locked: boolean; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const [pick, setPick] = useState("");
  const options = pool.filter((p) => !t.staff.some((s) => s.userId === p.userId));

  async function assign() {
    const [userId, roleKey] = pick.split("|");
    const r = await run(() => api.post<{ childrenPlaced: number }>(`/admin/teams/teams/${t.id}/staff`, { userId, roleKey }));
    if (r !== undefined) {
      setPick("");
      onChanged();
    }
  }
  async function remove(userId: string) {
    if (!window.confirm("Remove this person from the team? They lose access to its roster.")) return;
    if ((await run(() => api.del(`/admin/teams/teams/${t.id}/staff/${userId}`))) !== undefined) onChanged();
  }
  async function del() {
    if (!window.confirm(`Delete ${t.name}?`)) return;
    if ((await run(() => api.del(`/admin/teams/teams/${t.id}`))) !== undefined) onChanged();
  }

  return (
    <div style={{ background: "var(--navy)", padding: 16, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
        <strong style={{ fontSize: 22, color: "#fff" }}>{t.name}</strong>
        <span className="muted">
          {t.players} player{t.players === 1 ? "" : "s"}
        </span>
      </div>
      <ErrorAlert error={error} />
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0" }}>
        {t.staff.length === 0 && <li className="muted">No coaches yet.</li>}
        {t.staff.map((s) => (
          <li key={s.userId} style={{ display: "flex", justifyContent: "space-between", gap: 8, padding: "4px 0" }}>
            <span>
              {s.name} <span className="muted">· {ROLE[s.roleKey]}</span>
            </span>
            <button className="link-btn" onClick={() => remove(s.userId)} disabled={busy}>
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: "1 1 200px" }} aria-label={`Add staff to ${t.name}`}>
          <option value="">Add coach or team mom…</option>
          {options.map((p) => (
            <option key={p.userId + p.roleKey} value={`${p.userId}|${p.roleKey}`}>
              {p.name} · {ROLE[p.roleKey]}
              {p.assignments.length ? ` (on ${p.assignments.map((a) => a.teamName).join(", ")})` : ""}
            </option>
          ))}
        </select>
        <button className="btn small" onClick={assign} disabled={!pick || busy}>
          Add
        </button>
      </div>
      {!locked && t.players === 0 && (
        <button className="link-btn" style={{ marginTop: 8 }} onClick={del} disabled={busy}>
          Delete team
        </button>
      )}
    </div>
  );
}
